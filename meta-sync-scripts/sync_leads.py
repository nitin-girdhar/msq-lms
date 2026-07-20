#!/usr/bin/env python3
"""Pull-based backfill/catch-up for Meta Lead Ads leads.

Complements the existing real-time webhook path
(services/meta-conversion-api) — it does not replace it. Useful for: (a)
catching up leads if a webhook delivery was missed, (b) backfilling
historical leads when Meta integration is turned on for a tenant that
already has leads sitting in Meta, (c) periodic reconciliation via cron.

For each active org->form mapping in ext.meta_page_form_org_map, pages
through GET /{form_id}/leads and, for every lead not already present in
ext.meta_leads (deduped on meta_lead_id, same as the webhook path):
  1. writes the canonical lms.marketing_leads row via common.lead_writer
     (bare SQL port of intake.repository.ts::createWebhookLead, including
     dedup/auto-assign/lead_links and, when known, campaign_id)
  2. writes ext.meta_leads + address/professional/demographics/custom_fields
     children, mirroring lead-sync.service.ts exactly

No internal CRM HTTP API is called — DB (root_service role) + Graph API only.

Because Meta's /{form-id}/leads edge doesn't reliably support server-side
"since" filtering, pagination stops early once a run of consecutive
already-synced leads is seen (--stop-after-dupes), bounded by --max-pages
as a hard safety cap for first-run backfills.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from common import config, db, field_mapping, lead_writer, tenant_config
from common.graph_api import MetaGraphClient, MetaGraphError
from common.output import CsvWriter

log = config.setup_logging("sync_leads")

PLATFORM_TO_LEAD_SOURCE = {"fb": "facebook", "ig": "instagram"}


def safe_bigint(value) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_meta_created_time(value: Optional[str]) -> datetime:
    """Meta's Lead object returns created_time as an ISO8601 string
    (e.g. "2026-07-11T18:07:55+0000"), NOT a Unix timestamp — confirmed
    against a live Graph API response. Falls back to "now" if missing or
    unparseable rather than failing the whole lead."""
    if value:
        try:
            return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S%z")
        except ValueError:
            log.warning("  could not parse created_time=%r, using current time instead", value)
    return datetime.now(timezone.utc)


def get_active_mappings(
    cur, tenant_id: Optional[str], org_id: Optional[str], form_id: Optional[str]
) -> list:
    """tenant_id here filters by the *org's* tenant (via
    ext.meta_page_form_org_map.tenant_id, which mirrors entity.organizations.
    tenant_id) — it is NOT the credential/integration's tenant, since
    ext.meta_tenant_config is tenant-agnostic (tenant_id may be NULL there).
    None means "every org, regardless of tenant"."""
    cur.execute(
        """
        SELECT id, tenant_id, org_id, page_id, form_id, platform
        FROM ext.meta_page_form_org_map
        WHERE is_active = true
          AND (%(tenant_id)s::uuid IS NULL OR tenant_id = %(tenant_id)s::uuid)
          AND (%(org_id)s::uuid IS NULL OR org_id = %(org_id)s::uuid)
          AND (%(form_id)s::bigint IS NULL OR form_id = %(form_id)s::bigint)
        """,
        {"tenant_id": tenant_id, "org_id": org_id, "form_id": form_id},
    )
    return cur.fetchall()


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
                "form_id": mapping["form_id"],
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


def sync_form(cur, integration, mapping, page_tokens: Dict[str, str], dry_run: bool, debug: bool, max_pages: int, stop_after_dupes: int) -> dict:
    # /{form-id}/leads requires a Page Access Token, not the tenant-level
    # User/System-User token stored on ext.meta_tenant_config (Meta error
    # #190 otherwise) — same fix as sync_forms.py.
    page_token = page_tokens.get(str(mapping["page_id"]))
    if not page_token:
        log.error(
            "tenant=%s org=%s form=%s: page_id=%s not found among this token's managed Pages "
            "(/me/accounts) — check ext.meta_page_form_org_map.page_id is correct",
            mapping["tenant_id"], mapping["org_id"], mapping["form_id"], mapping["page_id"],
        )
        return {"created": 0, "duplicate": 0, "error": 1}

    client = MetaGraphClient(page_token, integration.graph_api_version)
    mappings = field_mapping.resolve_field_mappings(integration.field_mappings)

    debug_writers = None
    if debug:
        debug_writers = {
            "marketing_leads": CsvWriter("marketing_leads"),
            "meta_leads": CsvWriter("meta_leads"),
            "custom_fields": CsvWriter("meta_lead_custom_fields"),
        }

    counts = {"created": 0, "duplicate": 0, "error": 0}
    consecutive_dupes = 0
    after = None
    pages_fetched = 0

    while pages_fetched < max_pages:
        try:
            leads, after = client.get_leads_page(str(mapping["form_id"]), after=after)
        except MetaGraphError as exc:
            log.error("form=%s: Graph API error: %s", mapping["form_id"], exc)
            counts["error"] += 1
            break

        pages_fetched += 1
        if not leads:
            break

        for raw_lead in leads:
            raw_lead.setdefault("platform", mapping["platform"])
            result = process_lead(cur, mapping, raw_lead, mappings, dry_run, debug_writers)
            counts[result] = counts.get(result, 0) + 1
            consecutive_dupes = consecutive_dupes + 1 if result == "duplicate" else 0
            if consecutive_dupes >= stop_after_dupes:
                log.info("  form=%s: stopping after %d consecutive already-synced leads", mapping["form_id"], consecutive_dupes)
                after = None
                break

        if not after:
            break

    if debug_writers:
        for writer in debug_writers.values():
            writer.close()

    if not dry_run and not debug:
        cur.execute(
            "UPDATE ext.meta_page_form_org_map SET last_synced_at = NOW() WHERE id = %s",
            (mapping["id"],),
        )

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", help="Only sync orgs belonging to this tenant (UUID)")
    parser.add_argument("--org-id", help="Only sync this org (UUID)")
    parser.add_argument("--form-id", help="Only sync this Meta form id")
    parser.add_argument("--max-pages", type=int, default=20, help="Hard cap on pages fetched per form per run")
    parser.add_argument(
        "--stop-after-dupes", type=int, default=50,
        help="Stop paging a form after this many consecutive already-synced leads. Default is "
        "deliberately generous (50, not a handful) — a small cluster of old test/webhook leads "
        "mixed into Meta's result order can otherwise trigger an early stop before reaching "
        "genuinely new leads further back in pagination (confirmed live: several Fitclass "
        "branches had real new leads hidden behind under 20 pre-existing test rows).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Log what would happen, write nothing (no DB, no CSV)")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Run all reads/dedup checks against the real DB, but redirect every write to "
        "CSV files under output/ instead of committing to Postgres",
    )
    args = parser.parse_args()

    with db.transaction() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        if not integrations:
            log.warning("No active ext.meta_tenant_config rows found for the given scope")
            return 0

        total = {"created": 0, "duplicate": 0, "error": 0}
        for integration in integrations:
            # args.tenant_id filters by the org's tenant (via
            # meta_page_form_org_map.tenant_id), not the integration's own
            # tenant_id — ext.meta_tenant_config is tenant-agnostic.
            mappings = get_active_mappings(cur, args.tenant_id, args.org_id, args.form_id)
            if not mappings:
                continue

            user_client = MetaGraphClient(integration.access_token, integration.graph_api_version)
            try:
                page_tokens = user_client.get_managed_pages()
            except MetaGraphError as exc:
                log.error("integration=%s: could not list managed pages via /me/accounts: %s", integration.id, exc)
                total["error"] += 1
                continue

            for mapping in mappings:
                log.info("tenant=%s org=%s form=%s: syncing", mapping["tenant_id"], mapping["org_id"], mapping["form_id"])
                counts = sync_form(cur, integration, mapping, page_tokens, args.dry_run, args.debug, args.max_pages, args.stop_after_dupes)
                for key in total:
                    total[key] += counts.get(key, 0)

    log.info(
        "Done. leads created=%d duplicate=%d errors=%d",
        total["created"], total["duplicate"], total["error"],
    )
    return 1 if total["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
