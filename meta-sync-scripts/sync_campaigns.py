#!/usr/bin/env python3
"""Resolve Meta campaign metadata for campaign_ids seen in ext.meta_leads,
and attribute them onto marketing.ad_campaigns / crm.marketing_leads.

Today ext.meta_leads.campaign_id is a raw Meta numeric id that nothing ever
resolves into crm.marketing_leads.campaign_id, so the "Campaign" field on
the lead edit screen always shows "-" for Meta-sourced leads. This script
closes that gap:

  1. Finds every distinct (org_id, meta campaign_id) pair present in
     ext.meta_leads that doesn't yet have a matching marketing.ad_campaigns
     row (keyed on the new (org_id, meta_campaign_id) unique index).
  2. Calls GET /{campaign-id} on the Graph API for each to get name/status.
  3. Upserts marketing.ad_campaigns (idempotent — ON CONFLICT on
     (org_id, meta_campaign_id)).
  4. Backfills crm.marketing_leads.campaign_id for any already-existing
     Meta-sourced leads that are missing it.

No internal CRM HTTP API is called — DB (crm_service role) + Graph API only.
"""

import argparse
import sys

from common import config, db, tenant_config
from common.graph_api import MetaGraphClient, MetaGraphError
from common.output import CsvWriter

log = config.setup_logging("sync_campaigns")

# Meta campaign effective_status -> marketing.campaign_statuses.name
STATUS_MAP = {
    "ACTIVE": "active",
    "PAUSED": "paused",
    "CAMPAIGN_PAUSED": "paused",
    "ADSET_PAUSED": "paused",
    "ARCHIVED": "archived",
    "DELETED": "archived",
    "IN_PROCESS": "draft",
    "WITH_ISSUES": "draft",
    "PENDING_REVIEW": "draft",
    "DISAPPROVED": "draft",
}
DEFAULT_STATUS_NAME = "draft"

# ext.meta_leads.platform ('fb'/'ig') -> marketing.marketing_platforms.name
PLATFORM_MAP = {"fb": "facebook", "ig": "instagram"}


def get_unresolved_campaigns(cur, tenant_id: str = None, org_id: str = None) -> list:
    """tenant_id filters by the org's own tenant (entity.organizations.tenant_id)
    — not the credential/integration's tenant, since ext.meta_tenant_config is
    tenant-agnostic (tenant_id may be NULL there). None means every tenant."""
    cur.execute(
        """
        SELECT DISTINCT ml.org_id, ml.campaign_id AS meta_campaign_id, ml.platform
        FROM ext.meta_leads ml
        JOIN entity.organizations o ON o.id = ml.org_id
        LEFT JOIN marketing.ad_campaigns ac
          ON ac.org_id = ml.org_id AND ac.meta_campaign_id = ml.campaign_id
        WHERE ml.campaign_id IS NOT NULL
          AND ac.id IS NULL
          AND (%(tenant_id)s::uuid IS NULL OR o.tenant_id = %(tenant_id)s::uuid)
          AND (%(org_id)s::uuid IS NULL OR ml.org_id = %(org_id)s::uuid)
        """,
        {"tenant_id": tenant_id, "org_id": org_id},
    )
    return cur.fetchall()


def resolve_platform_id(cur, platform_key: str):
    name = PLATFORM_MAP.get(platform_key, "facebook")
    cur.execute("SELECT id FROM marketing.marketing_platforms WHERE name = %s LIMIT 1", (name,))
    row = cur.fetchone()
    return row["id"] if row else None


def resolve_status_id(cur, meta_status: str):
    name = STATUS_MAP.get((meta_status or "").upper(), DEFAULT_STATUS_NAME)
    cur.execute("SELECT id FROM marketing.campaign_statuses WHERE name = %s LIMIT 1", (name,))
    row = cur.fetchone()
    return row["id"] if row else None


def upsert_campaign(
    cur, org_id: str, meta_campaign_id: int, name: str, platform_id, status_id, dry_run: bool, debug_writer: CsvWriter
):
    if dry_run:
        log.info("  [dry-run] would upsert marketing.ad_campaigns org=%s meta_campaign_id=%s name=%r", org_id, meta_campaign_id, name)
        return None

    if debug_writer is not None:
        debug_writer.write(
            {
                "org_id": org_id,
                "meta_campaign_id": meta_campaign_id,
                "name": name,
                "platform_id": platform_id,
                "status_id": status_id,
            }
        )
        log.info("  [debug] wrote ad_campaigns row to CSV org=%s meta_campaign_id=%s name=%r", org_id, meta_campaign_id, name)
        return None

    cur.execute(
        """
        INSERT INTO marketing.ad_campaigns (org_id, name, platform_id, status_id, meta_campaign_id)
        VALUES (%(org_id)s, %(name)s, %(platform_id)s, %(status_id)s, %(meta_campaign_id)s)
        ON CONFLICT (org_id, meta_campaign_id) DO UPDATE SET
          name = EXCLUDED.name,
          status_id = EXCLUDED.status_id,
          updated_at = NOW()
        RETURNING id
        """,
        {
            "org_id": org_id,
            "name": name or f"Meta Campaign {meta_campaign_id}",
            "platform_id": platform_id,
            "status_id": status_id,
            "meta_campaign_id": meta_campaign_id,
        },
    )
    return cur.fetchone()["id"]


def backfill_lead_campaign_ids(cur, org_id: str, meta_campaign_id: int, ad_campaign_id, dry_run: bool, debug_writer: CsvWriter) -> int:
    if dry_run or debug_writer is not None:
        # ad_campaign_id doesn't exist yet in these modes (nothing was
        # actually inserted into marketing.ad_campaigns) — still show which
        # leads *would* be backfilled once the campaign is really synced.
        cur.execute(
            """
            SELECT ml.id FROM crm.marketing_leads ml
            JOIN ext.meta_leads mtl ON mtl.marketing_lead_id = ml.id
            WHERE ml.org_id = %(org_id)s AND mtl.campaign_id = %(meta_campaign_id)s AND ml.campaign_id IS NULL
            """,
            {"org_id": org_id, "meta_campaign_id": meta_campaign_id},
        )
        rows = cur.fetchall()
        if dry_run:
            log.info("  [dry-run] would backfill campaign_id on %d lead(s)", len(rows))
        elif debug_writer is not None:
            for row in rows:
                debug_writer.write({"marketing_lead_id": row["id"], "meta_campaign_id": meta_campaign_id, "org_id": org_id})
            log.info("  [debug] wrote %d lead campaign_id backfill row(s) to CSV", len(rows))
        return len(rows)

    if not ad_campaign_id:
        return 0

    cur.execute(
        """
        UPDATE crm.marketing_leads ml
        SET campaign_id = %(ad_campaign_id)s, updated_at = NOW()
        FROM ext.meta_leads mtl
        WHERE mtl.marketing_lead_id = ml.id
          AND ml.org_id = %(org_id)s
          AND mtl.campaign_id = %(meta_campaign_id)s
          AND ml.campaign_id IS NULL
        """,
        {"ad_campaign_id": ad_campaign_id, "org_id": org_id, "meta_campaign_id": meta_campaign_id},
    )
    return cur.rowcount


def sync_campaigns_for_integration(
    cur, integration: tenant_config.TenantIntegration, scope_tenant_id: str, org_id: str, dry_run: bool, debug: bool
) -> dict:
    client = MetaGraphClient(integration.access_token, integration.graph_api_version)
    unresolved = get_unresolved_campaigns(cur, scope_tenant_id, org_id)

    campaigns_writer = CsvWriter("ad_campaigns") if debug else None
    backfill_writer = CsvWriter("marketing_leads_campaign_backfill") if debug else None

    counts = {"synced": 0, "backfilled_leads": 0, "errors": 0}

    for row in unresolved:
        meta_campaign_id = row["meta_campaign_id"]
        try:
            campaign = client.get_campaign(str(meta_campaign_id))
        except MetaGraphError as exc:
            log.error("org=%s meta_campaign_id=%s: Graph API error: %s", row["org_id"], meta_campaign_id, exc)
            counts["errors"] += 1
            continue

        platform_id = resolve_platform_id(cur, row["platform"])
        status_id = resolve_status_id(cur, campaign.get("effective_status") or campaign.get("status"))
        ad_campaign_id = upsert_campaign(
            cur, row["org_id"], meta_campaign_id, campaign.get("name"), platform_id, status_id, dry_run, campaigns_writer
        )
        counts["synced"] += 1

        counts["backfilled_leads"] += backfill_lead_campaign_ids(
            cur, row["org_id"], meta_campaign_id, ad_campaign_id, dry_run, backfill_writer
        )

    if campaigns_writer:
        campaigns_writer.close()
    if backfill_writer:
        backfill_writer.close()

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", help="Only sync orgs belonging to this tenant (UUID)")
    parser.add_argument("--org-id", help="Only sync this org (UUID)")
    parser.add_argument("--dry-run", action="store_true", help="Log what would happen, write nothing (no DB, no CSV)")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Run all reads/resolution against the real DB, but redirect every write to "
        "CSV files under output/ instead of committing to Postgres",
    )
    args = parser.parse_args()

    with db.transaction() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        if not integrations:
            log.warning("No active ext.meta_tenant_config rows found for the given scope")
            return 0

        total = {"synced": 0, "backfilled_leads": 0, "errors": 0}
        for integration in integrations:
            counts = sync_campaigns_for_integration(
                cur, integration, args.tenant_id, args.org_id, args.dry_run, args.debug
            )
            for key in total:
                total[key] += counts[key]

    log.info(
        "Done. campaigns synced=%d leads_backfilled=%d errors=%d",
        total["synced"], total["backfilled_leads"], total["errors"],
    )
    return 1 if total["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
