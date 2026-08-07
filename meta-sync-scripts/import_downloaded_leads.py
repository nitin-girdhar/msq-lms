#!/usr/bin/env python3
"""Stage 3 of the download -> check -> import workflow: write the leads a
download run captured into the database.

Reads the same output/<run>/page_*_raw.json that check_leads_against_db.py
reported on, so what you reviewed is exactly what gets written — no second
Graph API call, and re-running is safe (every lead is re-classified against
the live DB at write time, and ext.meta_leads.meta_lead_id is uniquely
constrained).

Leads on forms with no ext.meta_page_form_org_map row are never imported:
routing them would mean guessing which branch org they belong to, and one
Page here is shared by eight branches. They're reported and left for a human
to map (see output/<run>/unmapped_forms.csv), then re-run this script.

Reuses the canonical write path unchanged — common/lead_writer.py::create_lead
(port of intake.repository.ts::createWebhookLead) plus
sync_leads.write_meta_lead_and_children — so an imported lead is
indistinguishable from a webhook-ingested one.
"""

import argparse
import sys
from collections import Counter

from common import config, db, field_mapping, lead_writer, output, reconcile, tenant_config
from common.graph_api import parse_created_time
from common.output import CsvWriter
from sync_leads import PLATFORM_TO_LEAD_SOURCE, resolve_ad_campaign_id, write_meta_lead_and_children

log = config.setup_logging("import_downloaded_leads")


def import_lead(cur, page: dict, form: dict, raw_lead: dict, verdict: dict, mappings, debug_writers) -> None:
    """Writes one lead. Assumes classify() already returned an IMPORTABLE
    verdict for it against this same cursor."""
    org_id = form["org_id"]
    contact = verdict["contact"]
    field_data = raw_lead.get("field_data") or []

    address = field_mapping.build_address_payload(field_data, mappings)
    professional = field_mapping.build_professional_payload(field_data, mappings)
    demographics = field_mapping.build_demographics_payload(field_data, mappings)
    custom_fields = field_mapping.extract_custom_fields(field_data, mappings)

    # A downloaded lead always carries created_time; fall back to the download
    # run's cutoff rather than "now" so a parse surprise can't date a
    # backfilled lead to today.
    lead_created_at = parse_created_time(raw_lead.get("created_time")) or parse_created_time(page.get("since"))

    # Meta returns `platform` per-lead — prefer it over the form-level
    # platform (itself just mapping["platform"], the static per-form config
    # value stamped by download_page_leads.py) when it's present and known.
    meta_platform = raw_lead.get("platform")
    if meta_platform and meta_platform in PLATFORM_TO_LEAD_SOURCE:
        resolved_platform = meta_platform
    else:
        if meta_platform:
            log.warning(
                "form=%s meta_lead_id=%s: unrecognized platform=%r from Meta, falling back to form mapping",
                form["form_id"], raw_lead.get("id"), meta_platform,
            )
        resolved_platform = form.get("platform") or "fb"

    # The lead payload as ext.meta_leads expects it. page_id/form_id come from
    # the Page we downloaded from, not from the lead body — the whole point of
    # the page-first rewrite is that the form the lead actually lives on is
    # authoritative.
    enriched = {
        **raw_lead,
        "page_id": page["page_id"],
        "form_id": form["form_id"],
        "platform": resolved_platform,
    }
    source = PLATFORM_TO_LEAD_SOURCE.get(enriched["platform"])
    ad_campaign_id = resolve_ad_campaign_id(cur, org_id, reconcile.safe_bigint(raw_lead.get("campaign_id")))

    if debug_writers is not None:
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
                "meta_lead_id": verdict["meta_lead_id"],
                "page_id": page["page_id"],
                "form_id": form["form_id"],
                "campaign_id": raw_lead.get("campaign_id"),
                "platform": enriched["platform"],
                "lead_created_at": lead_created_at.isoformat() if lead_created_at else None,
                "full_name": contact["full_name"],
                "phone": contact["phone"],
                "email": contact["email"],
            }
        )
        for cf in custom_fields:
            debug_writers["custom_fields"].write(
                {"meta_lead_id": verdict["meta_lead_id"], "question_key": cf["key"], "question_value": cf["value"]}
            )
        return

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
        metadata={"meta_lead_id": str(verdict["meta_lead_id"]), "form_id": form["form_id"], "platform": source},
        raw_webhook_data={"field_data": field_data},
        created_at=lead_created_at,
    )

    write_meta_lead_and_children(
        cur, org_id, result["id"], enriched, contact, address, professional,
        demographics, custom_fields, lead_created_at,
    )
    log.info(
        "  imported meta_lead_id=%s -> marketing_lead_id=%s org=%s form=%s",
        verdict["meta_lead_id"], result["id"], org_id, form["form_id"],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-dir", help="Download run to import (default: the most recent one)")
    parser.add_argument("--page-id", action="append", default=[], help="Only import these page_id(s) from the run (repeatable)")
    parser.add_argument("--form-id", action="append", default=[], help="Only import these form_id(s) from the run (repeatable)")
    parser.add_argument("--tenant-id", help="Tenant whose field_mappings to use (UUID)")
    parser.add_argument("--dry-run", action="store_true", help="Log what would happen, write nothing (no DB, no CSV)")
    parser.add_argument(
        "--debug", action="store_true",
        help="Run all reads/dedup checks against the real DB, but redirect every write to "
        "CSV files in the run directory instead of committing to Postgres",
    )
    args = parser.parse_args()

    run_dir = output.resolve_run_dir(args.run_dir)
    page_payloads = reconcile.load_run(run_dir)
    page_filter = {str(p) for p in args.page_id}
    form_filter = {str(f) for f in args.form_id}
    log.info("Importing from %s%s", run_dir, " [dry-run]" if args.dry_run else " [debug->CSV]" if args.debug else "")

    counts = Counter()
    debug_writers = None
    if args.debug:
        debug_writers = {
            "marketing_leads": CsvWriter("marketing_leads", run_dir),
            "meta_leads": CsvWriter("meta_leads", run_dir),
            "custom_fields": CsvWriter("meta_lead_custom_fields", run_dir),
        }

    with db.transaction() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        mappings = field_mapping.resolve_field_mappings(integrations[0].field_mappings if integrations else None)

        for page, form, raw_lead in reconcile.iter_leads(page_payloads):
            if page_filter and str(page["page_id"]) not in page_filter:
                continue
            if form_filter and str(form["form_id"]) not in form_filter:
                continue

            # Re-classified against the live DB, not against the download-time
            # snapshot — the dump may be hours old and the webhook path may
            # have ingested some of these leads in the meantime.
            verdict = reconcile.classify(cur, form, raw_lead, mappings)
            counts[verdict["verdict"]] += 1

            if verdict["verdict"] not in reconcile.IMPORTABLE:
                if verdict["verdict"] != reconcile.ALREADY_SYNCED:
                    log.warning(
                        "  skipped meta_lead_id=%s form=%s: %s (%s)",
                        verdict["meta_lead_id"], form["form_id"], verdict["verdict"], verdict["reason"],
                    )
                continue

            if args.dry_run:
                log.info(
                    "  [dry-run] would import meta_lead_id=%s org=%s form=%s verdict=%s",
                    verdict["meta_lead_id"], form.get("org_name"), form["form_id"], verdict["verdict"],
                )
                counts["imported"] += 1
                continue

            import_lead(cur, page, form, raw_lead, verdict, mappings, debug_writers)
            counts["imported"] += 1

        if args.dry_run or args.debug:
            # Nothing was written through this cursor, but be explicit: never
            # let a preview run commit.
            cur.connection.rollback()

    if debug_writers:
        for writer in debug_writers.values():
            writer.close()

    log.info("--- import summary ---")
    for verdict, count in counts.most_common():
        log.info("  %-16s %d", verdict, count)
    if counts[reconcile.UNMAPPED_FORM]:
        log.warning(
            "%d lead(s) skipped because their form has no ext.meta_page_form_org_map row — "
            "add the mappings (see %s) and re-run this script to pick them up",
            counts[reconcile.UNMAPPED_FORM], run_dir / "unmapped_forms.csv",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
