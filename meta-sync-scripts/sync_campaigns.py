#!/usr/bin/env python3
"""Repair/backfill tool for Meta campaign metadata and campaign TYPES.

Campaign creation is no longer this script's job. Both marketing.ad_campaigns
(the per-branch CRM projection) and ext.meta_campaigns (the tenant-scoped
type mapping) are now created LIVE: by the webhook the moment a lead arrives
on a new campaign (common/lead_writer.py, via common/campaign_resolution.py),
and proactively by a super-admin "Fetch campaigns" button
(services/meta-conversion-api's campaign-sync.service.ts) that walks a
tenant's whole ad-account catalogue. This script keeps a narrower,
longer-standing role: name/status refresh and historical backfill for
whatever the live paths have not (yet) seen.

Concretely, for every distinct (org_id, meta campaign_id) pair present in
ext.meta_leads that doesn't yet have a marketing.ad_campaigns row — which
includes both campaigns ingested before this script or the live path ever
ran, and any the live path failed to project (e.g. a missing tenant
platform/status catalog row) — this script:

  1. Calls GET /{campaign-id} on the Graph API to get name/objective/status.
  2. Upserts ext.meta_campaigns (tenant-scoped, keyed on the globally-unique
     meta_campaign_id), re-running marketing.fn_match_campaign_type() against
     the fetched name so a historical campaign gets typed the same way a live
     one would. THE HARD RULE, mirroring campaign-sync.service.ts's
     upsertCampaign exactly: a row whose mapping_status = 'confirmed' has its
     campaign_type_id, mapping_status and matched_keyword left untouched — an
     admin's correction is never silently reverted by this (or any) batch
     job. Name/objective/status/last_synced_at refresh unconditionally,
     confirmed rows included, since those are facts owned by Meta.
  3. Upserts marketing.ad_campaigns (idempotent — ON CONFLICT on
     (org_id, meta_campaign_id)), carrying the resolved campaign_type_id.
  4. Backfills lms.marketing_leads.campaign_id for any already-existing
     Meta-sourced leads that are missing it.

No internal CRM HTTP API is called — DB (root_service role) + Graph API only.
"""

import argparse
import sys
from typing import Optional

from common import config, db, tenant_config
from common.campaign_resolution import KEYWORD_MATCH_SQL_SNIPPET
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
    tenant-agnostic (tenant_id may be NULL there). None means every tenant.

    Unchanged in scope by the campaign-types phase: this already covers every
    historical (org_id, meta_campaign_id) pair that predates campaign types
    and campaign-type discovery, since neither marketing.ad_campaigns nor
    ext.meta_campaigns existed to short-circuit it back then. What changed is
    what the caller now does with each row — see upsert_ext_meta_campaign.

    ALSO picks up campaigns whose ext.meta_campaigns row has NO NAME, even when
    their marketing.ad_campaigns row already exists. Those are the rows
    one_time/backfill_campaign_types.sql seeded from the historical back-catalogue
    (name and type NULL) and the ones the live webhook created when its one Graph
    name lookup failed. The ad_campaigns-only filter skipped every one of them,
    so they stayed nameless in the admin grid and never re-matched by keyword.
    Re-processing a campaign that already has an ad_campaigns row is safe: both
    upserts are ON CONFLICT, and a confirmed mapping is never overwritten."""
    cur.execute(
        """
        SELECT DISTINCT ml.org_id, o.tenant_id, ml.campaign_id AS meta_campaign_id, ml.platform
        FROM ext.meta_leads ml
        JOIN entity.organizations o ON o.id = ml.org_id
        LEFT JOIN marketing.ad_campaigns ac
          ON ac.org_id = ml.org_id AND ac.meta_campaign_id = ml.campaign_id
        WHERE ml.campaign_id IS NOT NULL
          AND (
            ac.id IS NULL
            OR EXISTS (
              SELECT 1 FROM ext.meta_campaigns mc
              WHERE mc.meta_campaign_id = ml.campaign_id AND mc.name IS NULL
            )
          )
          AND (%(tenant_id)s::uuid IS NULL OR o.tenant_id = %(tenant_id)s::uuid)
          AND (%(org_id)s::uuid IS NULL OR ml.org_id = %(org_id)s::uuid)
        """,
        {"tenant_id": tenant_id, "org_id": org_id},
    )
    return cur.fetchall()


def upsert_ext_meta_campaign(
    cur,
    tenant_id: str,
    meta_campaign_id: int,
    name: str,
    objective: str,
    effective_status: str,
    dry_run: bool,
    debug_writer: CsvWriter,
) -> Optional[dict]:
    """The tenant-scoped type mapping. Direct port of upsertCampaign in
    services/meta-conversion-api/src/services/campaign-sync.service.ts,
    minus the ad_account_id (this script discovers campaigns from
    ext.meta_leads, not from an ad account listing — first_seen_source is
    'lead' here for exactly the reason ext.meta_campaigns' own table comment
    gives: ad_account_id is NULL when the row came from a lead).

    THE HARD RULE: on conflict, a row whose mapping_status = 'confirmed' never
    has its campaign_type_id / mapping_status / matched_keyword touched — an
    admin's correction must survive every future run of this script, forever.
    Name/objective/effective_status/last_synced_at refresh unconditionally,
    confirmed rows included, since those are facts owned by Meta.

    Always called for a row this run already confirmed needs REFRESHING (the
    caller only reaches here for campaigns Graph was just queried for), so
    unlike resolveCampaignType's cache-hit short-circuit, this always issues
    the upsert — same as the TypeScript.
    """
    name = (name or "").strip() or None

    if dry_run:
        log.info("  [dry-run] would upsert ext.meta_campaigns tenant=%s meta_campaign_id=%s name=%r", tenant_id, meta_campaign_id, name)
        return None

    if debug_writer is not None:
        debug_writer.write(
            {"tenant_id": tenant_id, "meta_campaign_id": meta_campaign_id, "name": name, "objective": objective, "effective_status": effective_status}
        )
        log.info("  [debug] wrote ext.meta_campaigns row to CSV tenant=%s meta_campaign_id=%s name=%r", tenant_id, meta_campaign_id, name)
        return None

    cur.execute(
        f"""
        WITH matched AS (
            SELECT ct.id AS campaign_type_id,
                   {KEYWORD_MATCH_SQL_SNIPPET} AS matched_keyword
            FROM marketing.campaign_types ct
            WHERE ct.id = marketing.fn_match_campaign_type(%(tenant_id)s::uuid, %(name)s)
            LIMIT 1
        ),
        resolved AS (
            SELECT
                (SELECT campaign_type_id FROM matched) AS campaign_type_id,
                (SELECT matched_keyword  FROM matched) AS matched_keyword,
                CASE WHEN (SELECT campaign_type_id FROM matched) IS NOT NULL
                     THEN 'suggested' ELSE 'unmapped' END AS mapping_status
        )
        INSERT INTO ext.meta_campaigns (
            tenant_id, ad_account_id, meta_campaign_id, name, objective, effective_status,
            campaign_type_id, mapping_status, matched_keyword, first_seen_source, last_synced_at
        )
        SELECT %(tenant_id)s, NULL, %(meta_campaign_id)s, %(name)s, %(objective)s, %(effective_status)s,
               r.campaign_type_id, r.mapping_status, r.matched_keyword, 'lead', NOW()
        FROM resolved r
        ON CONFLICT (meta_campaign_id) DO UPDATE SET
            name              = EXCLUDED.name,
            objective         = EXCLUDED.objective,
            effective_status  = EXCLUDED.effective_status,
            last_synced_at    = NOW(),
            campaign_type_id = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                                    THEN ext.meta_campaigns.campaign_type_id
                                    ELSE EXCLUDED.campaign_type_id END,
            mapping_status   = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                                    THEN 'confirmed'
                                    ELSE EXCLUDED.mapping_status END,
            matched_keyword  = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                                    THEN ext.meta_campaigns.matched_keyword
                                    ELSE EXCLUDED.matched_keyword END
            -- confirmed_by / confirmed_at appear in neither list: not
            -- touching a column is a stronger guarantee than writing it back
            -- to itself.
        RETURNING campaign_type_id, mapping_status, (xmax = 0) AS inserted
        """,
        {
            "tenant_id": tenant_id,
            "meta_campaign_id": meta_campaign_id,
            "name": name,
            "objective": objective,
            "effective_status": effective_status,
        },
    )
    return cur.fetchone()


# marketing.marketing_platforms / marketing.campaign_statuses are tenant-scoped
# (08_rls.sql lists them alongside the LMS lookups), so every tenant has its own
# 'facebook' / 'active' row under the same `name`. This package runs as
# root_service (BYPASSRLS) and gets no policy narrowing, so both lookups have to
# resolve against the CAMPAIGN's tenant, derived from org_id — the same defect
# that mis-stamped lead stage_id/source_id in common/lead_writer.py.
def resolve_platform_id(cur, org_id: str, platform_key: str):
    name = PLATFORM_MAP.get(platform_key, "facebook")
    cur.execute(
        """
        SELECT id FROM marketing.marketing_platforms
        WHERE name = %(name)s
          AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = %(org_id)s)
        LIMIT 1
        """,
        {"name": name, "org_id": org_id},
    )
    row = cur.fetchone()
    return row["id"] if row else None


def resolve_status_id(cur, org_id: str, meta_status: str):
    name = STATUS_MAP.get((meta_status or "").upper(), DEFAULT_STATUS_NAME)
    cur.execute(
        """
        SELECT id FROM marketing.campaign_statuses
        WHERE name = %(name)s
          AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = %(org_id)s)
        LIMIT 1
        """,
        {"name": name, "org_id": org_id},
    )
    row = cur.fetchone()
    return row["id"] if row else None


def upsert_campaign(
    cur,
    org_id: str,
    meta_campaign_id: int,
    name: str,
    platform_id,
    status_id,
    campaign_type_id: Optional[str],
    dry_run: bool,
    debug_writer: CsvWriter,
):
    if dry_run:
        log.info("  [dry-run] would upsert marketing.ad_campaigns org=%s meta_campaign_id=%s name=%r campaign_type_id=%s", org_id, meta_campaign_id, name, campaign_type_id)
        return None

    if debug_writer is not None:
        debug_writer.write(
            {
                "org_id": org_id,
                "meta_campaign_id": meta_campaign_id,
                "name": name,
                "platform_id": platform_id,
                "status_id": status_id,
                "campaign_type_id": campaign_type_id,
            }
        )
        log.info("  [debug] wrote ad_campaigns row to CSV org=%s meta_campaign_id=%s name=%r", org_id, meta_campaign_id, name)
        return None

    # campaign_type_id is only ever set on INSERT, never on an ON CONFLICT
    # UPDATE — this row is a plain per-branch projection of the type
    # ext.meta_campaigns holds, and, like ensureBranchCampaign in
    # leads-service, an existing row is left alone once created. (In
    # practice this ON CONFLICT is close to unreachable: the caller only
    # ever passes rows get_unresolved_campaigns found with NO existing
    # ad_campaigns row.)
    cur.execute(
        """
        INSERT INTO marketing.ad_campaigns (org_id, name, platform_id, status_id, meta_campaign_id, campaign_type_id)
        VALUES (%(org_id)s, %(name)s, %(platform_id)s, %(status_id)s, %(meta_campaign_id)s, %(campaign_type_id)s)
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
            "campaign_type_id": campaign_type_id,
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
            SELECT ml.id FROM lms.marketing_leads ml
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
        UPDATE lms.marketing_leads ml
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
    ext_campaigns_writer = CsvWriter("ext_meta_campaigns") if debug else None
    backfill_writer = CsvWriter("marketing_leads_campaign_backfill") if debug else None

    counts = {
        "synced": 0,
        "backfilled_leads": 0,
        "errors": 0,
        # The invariant, counted — see upsert_ext_meta_campaign's docstring.
        "confirmed_untouched": 0,
    }

    for row in unresolved:
        meta_campaign_id = row["meta_campaign_id"]
        try:
            campaign = client.get_campaign(str(meta_campaign_id))
        except MetaGraphError as exc:
            log.error("org=%s meta_campaign_id=%s: Graph API error: %s", row["org_id"], meta_campaign_id, exc)
            counts["errors"] += 1
            continue

        name = campaign.get("name")
        effective_status = campaign.get("effective_status") or campaign.get("status")

        # The type mapping: seeds ext.meta_campaigns for this campaign if it
        # has no row yet (the historical-backfill case this phase adds), or
        # refreshes it in place — never overwriting a confirmed mapping.
        ext_row = upsert_ext_meta_campaign(
            cur, row["tenant_id"], meta_campaign_id, name, campaign.get("objective"), effective_status,
            dry_run, ext_campaigns_writer,
        )
        campaign_type_id = ext_row["campaign_type_id"] if ext_row else None
        if ext_row and ext_row["mapping_status"] == "confirmed" and not ext_row["inserted"]:
            counts["confirmed_untouched"] += 1

        platform_id = resolve_platform_id(cur, row["org_id"], row["platform"])
        status_id = resolve_status_id(cur, row["org_id"], effective_status)
        ad_campaign_id = upsert_campaign(
            cur, row["org_id"], meta_campaign_id, name, platform_id, status_id, campaign_type_id,
            dry_run, campaigns_writer,
        )
        counts["synced"] += 1

        counts["backfilled_leads"] += backfill_lead_campaign_ids(
            cur, row["org_id"], meta_campaign_id, ad_campaign_id, dry_run, backfill_writer
        )

    if campaigns_writer:
        campaigns_writer.close()
    if ext_campaigns_writer:
        ext_campaigns_writer.close()
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

        total = {"synced": 0, "backfilled_leads": 0, "errors": 0, "confirmed_untouched": 0}
        for integration in integrations:
            counts = sync_campaigns_for_integration(
                cur, integration, args.tenant_id, args.org_id, args.dry_run, args.debug
            )
            for key in total:
                total[key] += counts[key]

    log.info(
        "Done. campaigns synced=%d leads_backfilled=%d confirmed_mappings_untouched=%d errors=%d",
        total["synced"], total["backfilled_leads"], total["confirmed_untouched"], total["errors"],
    )
    return 1 if total["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
