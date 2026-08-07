#!/usr/bin/env python3
"""Fetches every Meta lead since --since into a local CSV (all_leads.csv),
then for leads already in the local DB whose true Meta platform is
Instagram ("ig") but whose stored platform/source says Facebook, corrects
ext.meta_leads.platform and lms.marketing_leads.source_id to Instagram.

PAGE-FIRST, same discovery approach as download_page_leads.py: asks each
known Page which leadgen forms it actually has right now, rather than
trusting a possibly-stale mapping-table form_id list. Unmapped forms are
still downloaded (so they show up in all_leads.csv) but obviously have no
org to fix a lead against, so they're excluded from the fix pass.

Scope of the fix is deliberately narrow: only leads Meta reports as
platform="ig" get corrected. A lead Meta reports as "fb" is left alone even
if its stored source looks wrong, since that direction wasn't asked for and
silently guessing would be worse than leaving it for a human to review (see
mismatch_other in the summary).

Two DB passes: read-only to build the CSV + detect mismatches, then (unless
--dry-run) a single write transaction that applies only the ig-mislabeled
fixes.
"""

import argparse
import sys
from collections import Counter
from typing import Any, Dict, List, Optional

from common import config, db, field_mapping, output, tenant_config
from common import mappings as mappings_repo
from common.graph_api import MetaGraphError, parse_since_arg, resolve_page_clients
from common.output import CsvWriter

log = config.setup_logging("reconcile_platform_source")

PLATFORM_TO_SOURCE_NAME = {"fb": "facebook", "ig": "instagram"}
DEFAULT_SINCE = "2026-07-01"


def summarise_lead(raw_lead: dict, mappings) -> dict:
    """Best-effort contact extraction for the review CSV only — never raises
    on a missing phone, unlike field_mapping.build_contact_payload."""
    field_data = raw_lead.get("field_data") or []
    contact = mappings["contact"]
    return {
        "full_name": field_mapping.extract_by_keys(field_data, contact["full_name"]),
        "phone": field_mapping.extract_by_keys(field_data, contact["phone"]),
        "email": field_mapping.extract_by_keys(field_data, contact["email"]),
    }


def fetch_all_leads(args, since, until) -> List[Dict[str, Any]]:
    """Opens its own short-lived DB connection for the setup queries only —
    NOT held across the Graph API calls below, which take minutes for a
    full backfill. A remote/production Postgres can drop an idle connection
    over that span (observed live), and there is nothing to roll back here
    since this phase never writes."""
    with db.read_only_cursor() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        if not integrations:
            log.warning("No active ext.meta_tenant_config rows found for the given scope")
            return []

        form_org_map = mappings_repo.load_form_org_map(cur, args.tenant_id)
        field_mappings = field_mapping.resolve_field_mappings(integrations[0].field_mappings)

        page_ids = sorted(set(mappings_repo.get_known_page_ids(cur, args.tenant_id)) | {str(p) for p in args.page_id})
    if not page_ids:
        log.warning("No pages in scope — nothing to fetch")
        return []

    page_clients = resolve_page_clients(integrations)
    log.info("Pages in scope: %s | Pages reachable via /me/accounts: %d", ", ".join(page_ids), len(page_clients))

    rows: List[Dict[str, Any]] = []
    for page_id in page_ids:
        entry = page_clients.get(page_id)
        if not entry:
            log.error(
                "page=%s: not among any active token's managed Pages (/me/accounts) — skipping",
                page_id,
            )
            continue

        client, integration = entry
        try:
            forms = client.get_leadgen_forms(page_id)
        except MetaGraphError as exc:
            log.error("page=%s: could not list leadgen forms: %s", page_id, exc)
            continue

        log.info("page=%s: %d live form(s) on Meta", page_id, len(forms))
        for form in forms:
            form_id = str(form["id"])
            mapping = form_org_map.resolve(page_id, form_id)
            try:
                leads, truncated = client.get_leads_all(form_id, since=since, until=until, max_pages=args.max_pages)
            except MetaGraphError as exc:
                log.error("page=%s form=%s: Graph API error: %s", page_id, form_id, exc)
                continue

            if truncated:
                log.warning(
                    "page=%s form=%s: hit --max-pages=%d before pagination ended — older leads not fetched",
                    page_id, form_id, args.max_pages,
                )

            if leads:
                log.info(
                    "page=%s form=%s (%s) [%s]: %d lead(s) since %s",
                    page_id, form_id, form.get("name"),
                    "mapped -> " + mapping["org_name"] if mapping else "UNMAPPED",
                    len(leads), since.date(),
                )

            for raw_lead in leads:
                contact = summarise_lead(raw_lead, field_mappings)
                rows.append(
                    {
                        "page_id": page_id,
                        "form_id": form_id,
                        "form_name": form.get("name"),
                        "org_id": mapping["org_id"] if mapping else None,
                        "org_name": mapping["org_name"] if mapping else None,
                        "meta_lead_id": raw_lead.get("id"),
                        "created_time": raw_lead.get("created_time"),
                        "meta_platform": raw_lead.get("platform"),
                        "full_name": contact.get("full_name"),
                        "phone": contact.get("phone"),
                        "email": contact.get("email"),
                        "campaign_id": raw_lead.get("campaign_id"),
                        "ad_id": raw_lead.get("ad_id"),
                    }
                )

    return rows


def lookup_db_state(cur, meta_lead_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        """
        SELECT ml.id AS meta_leads_id, ml.platform AS db_platform, ml.org_id,
               mkl.id AS marketing_lead_id, mkl.source_id, ls.name AS source_name,
               o.tenant_id
        FROM ext.meta_leads ml
        LEFT JOIN lms.marketing_leads mkl ON mkl.id = ml.marketing_lead_id
        LEFT JOIN lms.lead_sources ls ON ls.id = mkl.source_id
        JOIN entity.organizations o ON o.id = ml.org_id
        WHERE ml.meta_lead_id = %s
        LIMIT 1
        """,
        (meta_lead_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def find_instagram_source_id(cur, tenant_id: str) -> Optional[str]:
    cur.execute(
        "SELECT id FROM lms.lead_sources WHERE tenant_id = %s AND name = 'instagram' AND is_active LIMIT 1",
        (tenant_id,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def apply_fix(cur, meta_leads_id: str, marketing_lead_id: Optional[str], instagram_source_id: Optional[str]) -> None:
    cur.execute("UPDATE ext.meta_leads SET platform = 'ig' WHERE id = %s", (meta_leads_id,))
    if marketing_lead_id and instagram_source_id:
        cur.execute(
            "UPDATE lms.marketing_leads SET source_id = %s, updated_at = NOW() WHERE id = %s",
            (instagram_source_id, marketing_lead_id),
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tenant-id", help="Only cover pages mapped to orgs in this tenant (UUID)")
    parser.add_argument("--page-id", action="append", default=[], help="Extra page_id to fetch beyond the mapping table (repeatable)")
    parser.add_argument("--since", default=DEFAULT_SINCE, help=f"Only leads created at/after this date (default {DEFAULT_SINCE})")
    parser.add_argument("--until", help="Only leads created before this date (optional upper bound)")
    parser.add_argument("--max-pages", type=int, default=50, help="Hard cap on Graph pages fetched per form")
    parser.add_argument("--dry-run", action="store_true", help="Report only — write no DB changes")
    args = parser.parse_args()

    since = parse_since_arg(args.since)
    until = parse_since_arg(args.until) if args.until else None

    run_dir = output.new_run_dir("all_leads")
    log.info("Fetching leads created on/after %s into %s", since.isoformat(), run_dir)

    leads = fetch_all_leads(args, since, until)

    counts = Counter()
    csv_rows = []
    fixups = []  # (meta_leads_id, marketing_lead_id, tenant_id, row) for ig-mislabeled leads

    with db.read_only_cursor() as cur:
        for lead in leads:
            counts["fetched"] += 1
            db_state = lookup_db_state(cur, lead["meta_lead_id"]) if lead["meta_lead_id"] else None

            in_db = db_state is not None
            db_platform = db_state["db_platform"] if db_state else None
            db_source_name = db_state["source_name"] if db_state else None
            expected_source = PLATFORM_TO_SOURCE_NAME.get(lead["meta_platform"])

            mismatch = False
            mismatch_kind = ""
            if in_db and lead["meta_platform"] == "ig" and (db_platform != "ig" or db_source_name != "instagram"):
                mismatch = True
                mismatch_kind = "ig_mislabeled"
                counts["mismatch_ig_mislabeled"] += 1
                fixups.append((db_state, lead))
            elif in_db and lead["meta_platform"] == "fb" and (db_platform == "ig" or db_source_name == "instagram"):
                mismatch = True
                mismatch_kind = "fb_mislabeled_not_fixed"
                counts["mismatch_other"] += 1

            if in_db:
                counts["already_synced"] += 1
            else:
                counts["not_in_db"] += 1

            csv_rows.append(
                {
                    **lead,
                    "in_db": in_db,
                    "db_platform": db_platform,
                    "db_source_name": db_source_name,
                    "expected_source": expected_source,
                    "mismatch": mismatch,
                    "mismatch_kind": mismatch_kind,
                }
            )

        with CsvWriter("all_leads", run_dir) as writer:
            for row in csv_rows:
                writer.write(row)

    log.info("--- fetch summary (%d leads since %s) ---", counts["fetched"], since.date())
    log.info("  already_synced        %d", counts["already_synced"])
    log.info("  not_in_db             %d", counts["not_in_db"])
    log.info("  mismatch_ig_mislabeled %d  (Meta says Instagram, DB says Facebook/other -> will be fixed)", counts["mismatch_ig_mislabeled"])
    log.info("  mismatch_other        %d  (Meta says Facebook, DB says Instagram -> NOT auto-fixed, review manually)", counts["mismatch_other"])
    log.info("CSV: %s", run_dir / "all_leads.csv")

    if not fixups:
        log.info("Nothing to fix.")
        return 0

    if args.dry_run:
        for db_state, lead in fixups:
            log.info(
                "  [dry-run] would fix meta_lead_id=%s org=%s: platform fb->ig, source -> instagram",
                lead["meta_lead_id"], db_state["org_id"],
            )
        log.info("Dry-run: %d lead(s) would be fixed. Re-run without --dry-run to apply.", len(fixups))
        return 0

    fixed = 0
    skipped_no_source = 0
    with db.transaction() as cur:
        tenant_source_cache: Dict[str, Optional[str]] = {}
        for db_state, lead in fixups:
            tenant_id = db_state["tenant_id"]
            if tenant_id not in tenant_source_cache:
                tenant_source_cache[tenant_id] = find_instagram_source_id(cur, tenant_id)
            instagram_source_id = tenant_source_cache[tenant_id]

            if db_state["marketing_lead_id"] and not instagram_source_id:
                log.warning(
                    "  meta_lead_id=%s tenant=%s: no active 'instagram' lms.lead_sources row — "
                    "fixed platform only, source_id left unchanged",
                    lead["meta_lead_id"], tenant_id,
                )
                skipped_no_source += 1

            apply_fix(cur, db_state["meta_leads_id"], db_state["marketing_lead_id"], instagram_source_id)
            fixed += 1
            log.info(
                "  fixed meta_lead_id=%s org=%s marketing_lead_id=%s",
                lead["meta_lead_id"], db_state["org_id"], db_state["marketing_lead_id"],
            )

    log.info("Done. Fixed %d lead(s) (%d had no tenant 'instagram' source row -> platform only).", fixed, skipped_no_source)
    return 0


if __name__ == "__main__":
    sys.exit(main())
