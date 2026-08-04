#!/usr/bin/env python3
"""Stage 2 of the download -> check -> import workflow: reconcile a
download_page_leads.py run against the local database, read-only.

Answers, per downloaded lead, exactly what the import would do with it:

  already_synced  meta_lead_id is already in ext.meta_leads — nothing to do
  unmapped_form   the form has no active ext.meta_page_form_org_map row, so
                  the lead cannot be routed to an org and will be SKIPPED
  missing_contact no usable phone in field_data — create_lead would reject it
  phone_duplicate an active lead with this phone exists for the org; the
                  import will supersede it (same as the webhook path)
  email_duplicate an active lead with this email exists; treated as a
                  re-submission — no new marketing lead, ext.meta_leads only
  new             will be inserted as a fresh lead

The dedup queries are the same ones common/lead_writer.py::create_lead runs,
so these verdicts are a prediction, not an estimate. Writes nothing (the DB
connection is read-only) and always exits 0 — this is a report, not a gate.
"""

import argparse
import sys
from collections import Counter, defaultdict

from common import config, db, field_mapping, output, reconcile, tenant_config
from common.output import CsvWriter

log = config.setup_logging("check_leads_against_db")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-dir", help="Download run to check (default: the most recent one)")
    parser.add_argument("--tenant-id", help="Tenant whose field_mappings to use when extracting contacts (UUID)")
    args = parser.parse_args()

    run_dir = output.resolve_run_dir(args.run_dir)
    page_payloads = reconcile.load_run(run_dir)
    log.info("Checking %s against the local database", run_dir)

    verdicts = Counter()
    per_form = defaultdict(Counter)
    rows = []

    with db.read_only_cursor() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        mappings = field_mapping.resolve_field_mappings(integrations[0].field_mappings if integrations else None)

        for page, form, raw_lead in reconcile.iter_leads(page_payloads):
            result = reconcile.classify(cur, form, raw_lead, mappings)
            verdict = result["verdict"]
            verdicts[verdict] += 1
            per_form[(page["page_id"], form["form_id"], form.get("name"), form.get("org_name"))][verdict] += 1

            contact = result["contact"] or {}
            rows.append(
                {
                    "verdict": verdict,
                    "reason": result["reason"],
                    "page_id": page["page_id"],
                    "form_id": form["form_id"],
                    "form_name": form.get("name"),
                    "org_name": form.get("org_name"),
                    "meta_lead_id": result["meta_lead_id"],
                    "created_time": raw_lead.get("created_time"),
                    "full_name": contact.get("full_name"),
                    "phone": contact.get("phone"),
                    "email": contact.get("email"),
                    "existing_lead_id": result["existing_lead_id"],
                }
            )

    with CsvWriter("reconciliation", run_dir) as detail:
        for row in rows:
            detail.write(row)

    with CsvWriter("reconciliation_summary", run_dir) as summary:
        for (page_id, form_id, form_name, org_name), counts in sorted(per_form.items()):
            summary.write(
                {
                    "page_id": page_id,
                    "form_id": form_id,
                    "form_name": form_name,
                    "org_name": org_name,
                    "total": sum(counts.values()),
                    **{verdict: counts.get(verdict, 0) for verdict in
                       (reconcile.NEW, reconcile.ALREADY_SYNCED, reconcile.UNMAPPED_FORM,
                        reconcile.PHONE_DUPLICATE, reconcile.EMAIL_DUPLICATE, reconcile.MISSING_CONTACT)},
                }
            )

    importable = sum(verdicts[v] for v in reconcile.IMPORTABLE)
    log.info("--- reconciliation against local DB (%d leads) ---", sum(verdicts.values()))
    for verdict, count in verdicts.most_common():
        log.info("  %-16s %d", verdict, count)
    log.info("Importable now: %d | blocked by missing form mapping: %d",
             importable, verdicts[reconcile.UNMAPPED_FORM])
    log.info("Detail: %s", run_dir / "reconciliation.csv")
    log.info("Next: python import_downloaded_leads.py --dry-run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
