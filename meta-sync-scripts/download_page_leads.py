#!/usr/bin/env python3
"""Stage 1 of the download -> check -> import workflow: pull Meta leads
PAGE-first into output/, touching the database read-only.

Why page-first: ext.meta_page_form_org_map's form_id list goes stale the
moment a new leadgen form is created on a Page, and Meta-side pages/ad
accounts get reorganised, so a form_id-driven sync silently stops seeing new
leads (confirmed live: ext.meta_leads already holds form ids that have no
mapping row at all). This script asks each Page what forms it actually has
right now — GET /{page-id}/leadgen_forms — and pulls leads from every one of
them, mapped or not.

Routing is still resolved from ext.meta_page_form_org_map's (page_id,
form_id) -> org_id, and a form with no mapping row is downloaded and
reported as UNMAPPED, never guessed into an org: one Page here is shared by
eight branch orgs, so "the page's org" is not a well-defined thing.

Writes nothing to the database — the connection is opened read-only. Review
output/<run>/, then run check_leads_against_db.py and
import_downloaded_leads.py against the same run directory.
"""

import argparse
import sys
from collections import defaultdict
from typing import Dict, List, Optional

from common import config, db, mappings as mappings_repo, output
from common.graph_api import MetaGraphError, parse_since_arg, resolve_page_clients
from common.output import CsvWriter
from common import field_mapping, tenant_config

log = config.setup_logging("download_page_leads")

# The Meta-side reorganisation that broke form_id-based syncing; everything
# from this point on needs re-pulling. Overridable with --since.
DEFAULT_SINCE = "2026-07-28"


def summarise_lead(raw_lead: dict, mappings) -> dict:
    """Best-effort contact extraction for the review CSV only. Unlike the
    import path this never raises on a missing phone — a lead that can't be
    imported is exactly the kind you want to see in the review sheet."""
    field_data = raw_lead.get("field_data") or []
    contact = mappings["contact"]
    return {
        "full_name": field_mapping.extract_by_keys(field_data, contact["full_name"]),
        "phone": field_mapping.extract_by_keys(field_data, contact["phone"]),
        "email": field_mapping.extract_by_keys(field_data, contact["email"]),
    }


def download_page(
    page_id: str,
    client,
    integration,
    form_org_map: "mappings_repo.FormOrgMap",
    since,
    until,
    max_pages: int,
    max_forms: Optional[int],
) -> dict:
    """Returns the full raw payload for one page: its live forms plus every
    lead per form created at/after `since`."""
    try:
        forms = client.get_leadgen_forms(page_id)
    except MetaGraphError as exc:
        log.error("page=%s: could not list leadgen forms: %s", page_id, exc)
        return {"page_id": page_id, "error": str(exc), "forms": []}

    log.info("page=%s: %d live form(s) on Meta", page_id, len(forms))
    if max_forms:
        forms = forms[:max_forms]

    page_payload = {
        "page_id": page_id,
        "integration_id": str(integration.id),
        "graph_api_version": integration.graph_api_version,
        "since": since.isoformat(),
        "until": until.isoformat() if until else None,
        "forms": [],
    }

    for form in forms:
        form_id = str(form["id"])
        mapping = form_org_map.resolve(page_id, form_id)
        try:
            leads, truncated = client.get_leads_all(form_id, since=since, until=until, max_pages=max_pages)
        except MetaGraphError as exc:
            log.error("page=%s form=%s: Graph API error: %s", page_id, form_id, exc)
            page_payload["forms"].append({**form, "form_id": form_id, "error": str(exc), "leads": []})
            continue

        if truncated:
            log.warning(
                "page=%s form=%s: hit --max-pages=%d before pagination ended — "
                "older leads in this form were not downloaded",
                page_id, form_id, max_pages,
            )

        log.info(
            "page=%s form=%s (%s) [%s]: %d lead(s) since %s",
            page_id, form_id, form.get("name"),
            "mapped -> " + mapping["org_name"] if mapping else "UNMAPPED",
            len(leads), since.date(),
        )

        page_payload["forms"].append(
            {
                **form,
                "form_id": form_id,
                "page_id": page_id,
                "mapping_status": "mapped" if mapping else "UNMAPPED",
                "org_id": str(mapping["org_id"]) if mapping else None,
                "org_name": mapping["org_name"] if mapping else None,
                "platform": mapping["platform"] if mapping else "fb",
                "truncated": truncated,
                "leads": leads,
            }
        )

    return page_payload


def write_review_csvs(cur, run_dir, page_payloads: List[dict], mappings) -> Dict[str, int]:
    counts: Dict[str, int] = defaultdict(int)

    leads_csv = CsvWriter("leads_downloaded", run_dir)
    forms_csv = CsvWriter("forms_discovered", run_dir)
    unmapped_csv = CsvWriter("unmapped_forms", run_dir)

    with leads_csv, forms_csv, unmapped_csv:
        for page in page_payloads:
            page_id = page["page_id"]
            candidates = None
            for form in page["forms"]:
                mapping_status = form.get("mapping_status", "UNMAPPED")
                counts["forms"] += 1
                counts["forms_" + mapping_status] += 1

                forms_csv.write(
                    {
                        "page_id": page_id,
                        "form_id": form["form_id"],
                        "form_name": form.get("name"),
                        "status": form.get("status"),
                        "leads_count_total": form.get("leads_count"),
                        "leads_since_cutoff": len(form.get("leads") or []),
                        "mapping_status": mapping_status,
                        "org_name": form.get("org_name"),
                        "truncated": form.get("truncated"),
                        "error": form.get("error"),
                    }
                )

                if mapping_status == "UNMAPPED":
                    if candidates is None:
                        candidates = "; ".join(mappings_repo.page_org_names(cur, page_id))
                    unmapped_csv.write(
                        {
                            "page_id": page_id,
                            "form_id": form["form_id"],
                            "form_name": form.get("name"),
                            "status": form.get("status"),
                            "leads_since_cutoff": len(form.get("leads") or []),
                            "orgs_already_on_this_page": candidates,
                        }
                    )

                for lead in form.get("leads") or []:
                    counts["leads"] += 1
                    counts["leads_" + mapping_status] += 1
                    contact = summarise_lead(lead, mappings)
                    leads_csv.write(
                        {
                            "page_id": page_id,
                            "form_id": form["form_id"],
                            "form_name": form.get("name"),
                            "mapping_status": mapping_status,
                            "org_name": form.get("org_name"),
                            "meta_lead_id": lead.get("id"),
                            "created_time": lead.get("created_time"),
                            "full_name": contact["full_name"],
                            "phone": contact["phone"],
                            "email": contact["email"],
                            "campaign_id": lead.get("campaign_id"),
                            "ad_id": lead.get("ad_id"),
                        }
                    )

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tenant-id", help="Only cover pages mapped to orgs in this tenant (UUID)")
    parser.add_argument(
        "--page-id", action="append", default=[],
        help="Extra page_id to download beyond those in ext.meta_page_form_org_map (repeatable)",
    )
    parser.add_argument(
        "--only-page-id", action="append", default=[],
        help="Download ONLY these page_id(s), ignoring the mapping table (repeatable)",
    )
    parser.add_argument("--since", default=DEFAULT_SINCE, help=f"Only leads created at/after this date (default {DEFAULT_SINCE})")
    parser.add_argument("--until", help="Only leads created before this date (optional upper bound)")
    parser.add_argument("--max-pages", type=int, default=50, help="Hard cap on Graph pages fetched per form (100 leads each)")
    parser.add_argument("--max-forms", type=int, help="Only download the first N forms per page (smoke-testing)")
    args = parser.parse_args()

    since = parse_since_arg(args.since)
    until = parse_since_arg(args.until) if args.until else None

    run_dir = output.new_run_dir("download")
    log.info("Downloading leads created on/after %s into %s", since.isoformat(), run_dir)

    page_payloads: List[dict] = []
    with db.read_only_cursor() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        if not integrations:
            log.warning("No active ext.meta_tenant_config rows found for the given scope")
            return 1

        form_org_map = mappings_repo.load_form_org_map(cur, args.tenant_id)
        field_mappings = field_mapping.resolve_field_mappings(integrations[0].field_mappings)

        if args.only_page_id:
            page_ids = sorted({str(p) for p in args.only_page_id})
        else:
            page_ids = sorted(
                set(mappings_repo.get_known_page_ids(cur, args.tenant_id)) | {str(p) for p in args.page_id}
            )
        if not page_ids:
            log.warning("No pages in scope — nothing to download")
            return 1

        page_clients = resolve_page_clients(integrations)
        log.info("Pages in scope: %s | Pages reachable via /me/accounts: %d", ", ".join(page_ids), len(page_clients))

        errors = 0
        for page_id in page_ids:
            entry = page_clients.get(page_id)
            if not entry:
                log.error(
                    "page=%s: not among any active token's managed Pages (/me/accounts) — the Page may have "
                    "moved to another Business/ad account, or the token lost access",
                    page_id,
                )
                errors += 1
                continue

            client, integration = entry
            payload = download_page(
                page_id, client, integration, form_org_map, since, until, args.max_pages, args.max_forms
            )
            page_payloads.append(payload)
            output.write_json(run_dir / f"page_{page_id}_raw.json", payload)
            if payload.get("error"):
                errors += 1

        counts = write_review_csvs(cur, run_dir, page_payloads, field_mappings)

    output.write_json(
        run_dir / "manifest.json",
        {
            "since": since.isoformat(),
            "until": until.isoformat() if until else None,
            "pages": [p["page_id"] for p in page_payloads],
            "counts": dict(counts),
        },
    )

    log.info(
        "Done. pages=%d forms=%d (mapped=%d unmapped=%d) leads=%d (mapped=%d unmapped=%d) errors=%d",
        len(page_payloads), counts["forms"], counts["forms_mapped"], counts["forms_UNMAPPED"],
        counts["leads"], counts["leads_mapped"], counts["leads_UNMAPPED"], errors,
    )
    log.info("Review %s, then run: python check_leads_against_db.py", run_dir)
    if counts["forms_UNMAPPED"]:
        log.warning(
            "%d form(s) have no ext.meta_page_form_org_map row — their %d lead(s) cannot be imported "
            "until you map them. See %s",
            counts["forms_UNMAPPED"], counts["leads_UNMAPPED"], run_dir / "unmapped_forms.csv",
        )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
