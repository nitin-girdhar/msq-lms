#!/usr/bin/env python3
"""Pull-based backfill/catch-up for Meta Lead Ads leads.

Complements the existing real-time webhook path
(services/meta-conversion-api) — it does not replace it. Useful for: (a)
catching up leads if a webhook delivery was missed, (b) backfilling
historical leads when Meta integration is turned on for a tenant that
already has leads sitting in Meta, (c) periodic reconciliation via cron.

PAGE-FIRST, not form-first. For every Page in scope this asks Meta which
leadgen forms actually exist on it right now (GET /{page-id}/leadgen_forms)
rather than trusting the form_id list cached in ext.meta_page_form_org_map —
that list goes stale as soon as a new form is created, and pages/ad accounts
get reorganised Meta-side, which silently stopped this sync from ever seeing
newer forms' leads. ext.meta_page_form_org_map is still the routing
authority: a discovered form with no active mapping row is reported and
skipped, never guessed into an org (one Page here is shared by eight branch
orgs).

For each mapped form it pages through GET /{form_id}/leads, restricted to
leads created at/after --since, and for every lead not already present in
ext.meta_leads (deduped on meta_lead_id, same as the webhook path):
  1. writes the canonical lms.marketing_leads row via common.lead_writer
     (bare SQL port of intake.repository.ts::createWebhookLead, including
     dedup/auto-assign/lead_links and, when known, campaign_id)
  2. writes ext.meta_leads + address/professional/demographics/custom_fields
     children, mirroring lead-sync.service.ts exactly

No internal CRM HTTP API is called — DB (root_service role) + Graph API only.

For a reviewable backfill (dump to disk, reconcile against the DB, then
import) use download_page_leads.py -> check_leads_against_db.py ->
import_downloaded_leads.py instead; this script is the unattended cron path.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from common import config, db, field_mapping, lead_writer, mappings as mappings_repo, tenant_config
from common.graph_api import (
    MetaGraphClient,
    MetaGraphError,
    parse_created_time,
    parse_since_arg,
    resolve_page_clients,
)
from common.output import CsvWriter

log = config.setup_logging("sync_leads")

PLATFORM_TO_LEAD_SOURCE = {"fb": "facebook", "ig": "instagram", "wa": "whatsapp"}

# The Meta-side page/account reorganisation that broke form_id-driven syncing.
# Everything from here on needs (re-)pulling; older leads are already in the DB
# from the pre-reorg runs. Override with --since for a deeper backfill.
DEFAULT_SINCE = "2026-07-28"


def safe_bigint(value) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_meta_created_time(value: Optional[str]) -> datetime:
    """Falls back to "now" if the lead's created_time is missing or
    unparseable, rather than failing the whole lead."""
    return parse_created_time(value) or datetime.now(timezone.utc)


def is_already_synced(cur, meta_lead_id: int) -> bool:
    cur.execute("SELECT id FROM ext.meta_leads WHERE meta_lead_id = %s LIMIT 1", (meta_lead_id,))
    return cur.fetchone() is not None


def resolve_ad_campaign_id(cur, org_id: str, meta_campaign_id: Optional[int]) -> Optional[str]:
    if not meta_campaign_id:
        return None
    cur.execute(
        "SELECT id FROM marketing.ad_campaigns WHERE org_id = %s AND meta_campaign_id = %s LIMIT 1",
        (org_id, meta_campaign_id),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def write_meta_lead_and_children(cur, org_id: str, marketing_lead_id: str, raw_lead: Dict[str, Any], contact, address, professional, demographics, custom_fields, lead_created_at) -> str:
    cur.execute(
        """
        INSERT INTO ext.meta_leads (
            org_id, marketing_lead_id, meta_lead_id, page_id, form_id, campaign_id, adset_id, ad_id,
            platform, lead_created_at, full_name, first_name, last_name, email, phone,
            whatsapp_number, raw_field_data
        ) VALUES (
            %(org_id)s, %(marketing_lead_id)s, %(meta_lead_id)s, %(page_id)s, %(form_id)s, %(campaign_id)s,
            %(adset_id)s, %(ad_id)s, %(platform)s, %(lead_created_at)s, %(full_name)s, %(first_name)s,
            %(last_name)s, %(email)s, %(phone)s, %(whatsapp_number)s, %(raw_field_data)s
        )
        RETURNING id
        """,
        {
            "org_id": org_id,
            "marketing_lead_id": marketing_lead_id,
            "meta_lead_id": safe_bigint(raw_lead["id"]),
            "page_id": safe_bigint(raw_lead.get("page_id")),
            "form_id": safe_bigint(raw_lead.get("form_id")) or 0,
            "campaign_id": safe_bigint(raw_lead.get("campaign_id")),
            "adset_id": safe_bigint(raw_lead.get("adset_id")),
            "ad_id": safe_bigint(raw_lead.get("ad_id")),
            "platform": raw_lead["platform"],
            "lead_created_at": lead_created_at,
            "full_name": contact["full_name"],
            "first_name": contact["first_name"],
            "last_name": contact["last_name"],
            "email": contact["email"],
            "phone": contact["phone"],
            "whatsapp_number": contact["whatsapp_number"],
            "raw_field_data": json.dumps(raw_lead["field_data"]),
        },
    )
    meta_lead_row_id = cur.fetchone()["id"]

    if field_mapping.has_any_value(address):
        cur.execute(
            """
            INSERT INTO ext.meta_lead_addresses (
                meta_lead_id, org_id, street_address, city, state, province, country, postal_code, zip_code
            ) VALUES (%(id)s, %(org_id)s, %(street_address)s, %(city)s, %(state)s, %(province)s, %(country)s, %(postal_code)s, %(zip_code)s)
            """,
            {"id": meta_lead_row_id, "org_id": org_id, **address},
        )

    if field_mapping.has_any_value(professional):
        cur.execute(
            """
            INSERT INTO ext.meta_lead_professional (
                meta_lead_id, org_id, job_title, company_name, work_email, work_phone_number
            ) VALUES (%(id)s, %(org_id)s, %(job_title)s, %(company_name)s, %(work_email)s, %(work_phone_number)s)
            """,
            {"id": meta_lead_row_id, "org_id": org_id, **professional},
        )

    if field_mapping.has_any_value(demographics):
        cur.execute(
            """
            INSERT INTO ext.meta_lead_demographics (
                meta_lead_id, org_id, date_of_birth, gender, marital_status, relationship_status, military_status
            ) VALUES (%(id)s, %(org_id)s, %(date_of_birth)s, %(gender)s, %(marital_status)s, %(relationship_status)s, %(military_status)s)
            """,
            {"id": meta_lead_row_id, "org_id": org_id, **demographics},
        )

    for cf in custom_fields:
        cur.execute(
            """
            INSERT INTO ext.meta_lead_custom_fields (meta_lead_id, org_id, question_key, question_value)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (meta_lead_id, question_key) DO NOTHING
            """,
            (meta_lead_row_id, org_id, cf["key"], cf["value"]),
        )

    return meta_lead_row_id


def process_lead(cur, mapping, raw_lead: Dict[str, Any], mappings, dry_run: bool, debug_writers) -> str:
    meta_lead_id = safe_bigint(raw_lead["id"])
    if meta_lead_id is None:
        log.warning("  skipping lead with non-numeric id=%r", raw_lead.get("id"))
        return "error"

    if is_already_synced(cur, meta_lead_id):
        log.info("  skipped (already exists) meta_lead_id=%s", meta_lead_id)
        return "duplicate"

    try:
        contact = field_mapping.build_contact_payload(raw_lead["field_data"], mappings)
    except ValueError as exc:
        log.warning("  skipping meta_lead_id=%s: %s", meta_lead_id, exc)
        return "error"

    address = field_mapping.build_address_payload(raw_lead["field_data"], mappings)
    professional = field_mapping.build_professional_payload(raw_lead["field_data"], mappings)
    demographics = field_mapping.build_demographics_payload(raw_lead["field_data"], mappings)
    custom_fields = field_mapping.extract_custom_fields(raw_lead["field_data"], mappings)

    created_time = raw_lead.get("created_time")
    lead_created_at = parse_meta_created_time(created_time)

    org_id = mapping["org_id"]
    ad_campaign_id = resolve_ad_campaign_id(cur, org_id, safe_bigint(raw_lead.get("campaign_id")))
    source = PLATFORM_TO_LEAD_SOURCE.get(raw_lead["platform"])

    if dry_run:
        log.info(
            "  [dry-run] would create lead meta_lead_id=%s org=%s phone=%s campaign_id=%s",
            meta_lead_id, org_id, contact["phone"], ad_campaign_id,
        )
        return "created"

    if debug_writers is not None:
        synthetic_marketing_lead_id = f"debug-{meta_lead_id}"
        debug_writers["marketing_leads"].write(
            {
                "org_id": org_id,
                "first_name": contact["first_name"] or "",
                "last_name": contact["last_name"] or "",
                "phone": contact["phone"],
                "email": contact["email"],
                "source": source,
                "city": address["city"],
                "address_line1": address["street_address"],
                "pincode": address["postal_code"] or address["zip_code"],
                "campaign_id": ad_campaign_id,
            }
        )
        debug_writers["meta_leads"].write(
            {
                "org_id": org_id,
                "marketing_lead_id": synthetic_marketing_lead_id,
                "meta_lead_id": meta_lead_id,
                "form_id": raw_lead["form_id"],
                "campaign_id": raw_lead.get("campaign_id"),
                "platform": raw_lead["platform"],
                "lead_created_at": lead_created_at.isoformat(),
                "full_name": contact["full_name"],
                "phone": contact["phone"],
                "email": contact["email"],
            }
        )
        for cf in custom_fields:
            debug_writers["custom_fields"].write(
                {"meta_lead_id": meta_lead_id, "question_key": cf["key"], "question_value": cf["value"]}
            )
        log.info("  [debug] wrote lead rows to CSV meta_lead_id=%s org=%s", meta_lead_id, org_id)
        return "created"

    result = lead_writer.create_lead(
        cur,
        org_id=org_id,
        first_name=contact["first_name"] or "",
        last_name=contact["last_name"] or "",
        phone=contact["phone"],
        email=contact["email"],
        source=source,
        city=address["city"],
        address_line1=address["street_address"],
        pincode=address["postal_code"] or address["zip_code"],
        campaign_id=ad_campaign_id,
        metadata={"meta_lead_id": str(meta_lead_id), "form_id": raw_lead.get("form_id"), "platform": source},
        raw_webhook_data={"field_data": raw_lead["field_data"]},
        created_at=lead_created_at,
    )

    write_meta_lead_and_children(
        cur, org_id, result["id"], raw_lead, contact, address, professional, demographics, custom_fields, lead_created_at
    )
    log.info("  created meta_lead_id=%s -> marketing_lead_id=%s org=%s", meta_lead_id, result["id"], org_id)
    return "created"


def sync_form(cur, integration, client: MetaGraphClient, mapping, form_id: str, since, dry_run: bool, debug: bool, max_pages: int, debug_writers) -> dict:
    """Syncs one mapped form. `client` is already page-scoped — /{form-id}/leads
    requires a Page Access Token, not the tenant-level User/System-User token
    on ext.meta_tenant_config (Meta error #190 otherwise). `form_id` is the
    Graph-API-discovered form id — not read off `mapping`, since a page-level
    mapping row (form_id IS NULL) covers many forms."""
    mappings = field_mapping.resolve_field_mappings(integration.field_mappings)
    counts = {"created": 0, "duplicate": 0, "error": 0}

    try:
        leads, truncated = client.get_leads_all(form_id, since=since, max_pages=max_pages)
    except MetaGraphError as exc:
        log.error("form=%s: Graph API error: %s", form_id, exc)
        counts["error"] += 1
        return counts

    if truncated:
        log.warning(
            "  form=%s: hit --max-pages=%d before pagination ended — older leads were not fetched "
            "this run (raise --max-pages or narrow --since for a full backfill)",
            form_id, max_pages,
        )

    for raw_lead in leads:
        # Meta returns `platform` per-lead — prefer it over the static
        # per-(page,form) mapping["platform"] config value, which is now only
        # a fallback for when Meta omits the field or returns something we
        # don't recognize yet (never drop/error the lead over it).
        meta_platform = raw_lead.get("platform")
        if not meta_platform or meta_platform not in PLATFORM_TO_LEAD_SOURCE:
            if meta_platform:
                log.warning(
                    "form=%s meta_lead_id=%s: unrecognized platform=%r from Meta, falling back to mapping",
                    form_id, raw_lead.get("id"), meta_platform,
                )
            raw_lead["platform"] = mapping["platform"]
        raw_lead.setdefault("page_id", mapping["page_id"])
        raw_lead["form_id"] = form_id
        result = process_lead(cur, mapping, raw_lead, mappings, dry_run, debug_writers)
        counts[result] = counts.get(result, 0) + 1

    if not dry_run and not debug and mapping.get("id"):
        cur.execute(
            "UPDATE ext.meta_page_form_org_map SET last_synced_at = NOW() WHERE id = %s",
            (mapping["id"],),
        )

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tenant-id", help="Only sync orgs belonging to this tenant (UUID)")
    parser.add_argument("--org-id", help="Only sync this org (UUID)")
    parser.add_argument("--page-id", action="append", default=[], help="Extra page_id(s) to sync beyond those in the mapping table (repeatable)")
    parser.add_argument("--form-id", action="append", default=[], help="Narrow to these Meta form id(s) (repeatable)")
    parser.add_argument("--since", default=DEFAULT_SINCE, help=f"Only leads created at/after this date (default {DEFAULT_SINCE})")
    parser.add_argument("--max-pages", type=int, default=20, help="Hard cap on Graph pages fetched per form per run (100 leads each)")
    parser.add_argument("--dry-run", action="store_true", help="Log what would happen, write nothing (no DB, no CSV)")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Run all reads/dedup checks against the real DB, but redirect every write to "
        "CSV files under output/ instead of committing to Postgres",
    )
    args = parser.parse_args()

    since = parse_since_arg(args.since)
    form_filter = {str(f) for f in args.form_id}
    total = {"created": 0, "duplicate": 0, "error": 0, "unmapped": 0}

    debug_writers = None
    if args.debug:
        debug_writers = {
            "marketing_leads": CsvWriter("marketing_leads"),
            "meta_leads": CsvWriter("meta_leads"),
            "custom_fields": CsvWriter("meta_lead_custom_fields"),
        }

    with db.transaction() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        if not integrations:
            log.warning("No active ext.meta_tenant_config rows found for the given scope")
            return 0

        # args.tenant_id/--org-id filter by the *org's* tenant (via
        # ext.meta_page_form_org_map), not the integration's own tenant_id —
        # ext.meta_tenant_config is tenant-agnostic.
        form_org_map = mappings_repo.load_form_org_map(cur, args.tenant_id, args.org_id)
        page_ids = sorted(set(form_org_map.page_ids()) | {str(p) for p in args.page_id})
        if not page_ids:
            log.warning("No active page/form mappings in scope — nothing to sync")
            return 0

        # Resolved once across all integrations, not per-integration: doing it
        # inside the integration loop synced every page once per credential row
        # and then failed page-token lookup on the second pass.
        page_clients = resolve_page_clients(integrations)

        for page_id in page_ids:
            entry = page_clients.get(page_id)
            if not entry:
                log.error(
                    "page=%s: not among any active token's managed Pages (/me/accounts) — the Page may "
                    "have moved to another Business/ad account, or the token lost access",
                    page_id,
                )
                total["error"] += 1
                continue

            client, integration = entry
            try:
                forms = client.get_leadgen_forms(page_id)
            except MetaGraphError as exc:
                log.error("page=%s: could not list leadgen forms: %s", page_id, exc)
                total["error"] += 1
                continue

            log.info("page=%s: %d live form(s) on Meta", page_id, len(forms))
            for form in forms:
                form_id = str(form["id"])
                if form_filter and form_id not in form_filter:
                    continue

                mapping = form_org_map.resolve(page_id, form_id)
                if not mapping:
                    total["unmapped"] += 1
                    log.warning(
                        "  page=%s form=%s (%r): no active ext.meta_page_form_org_map row (form-level or "
                        "page-level) — leads NOT synced. Add a mapping row to route them (never guessed: "
                        "this page may serve several orgs)",
                        page_id, form_id, form.get("name"),
                    )
                    continue

                log.info("  org=%s form=%s (%r): syncing since %s", mapping["org_name"], form_id, form.get("name"), since.date())
                counts = sync_form(cur, integration, client, mapping, form_id, since, args.dry_run, args.debug, args.max_pages, debug_writers)
                for key in ("created", "duplicate", "error"):
                    total[key] += counts.get(key, 0)

    if debug_writers:
        for writer in debug_writers.values():
            writer.close()

    log.info(
        "Done. leads created=%d duplicate=%d errors=%d | forms needing a manual mapping=%d",
        total["created"], total["duplicate"], total["error"], total["unmapped"],
    )
    return 1 if total["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
