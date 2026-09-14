import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';
import { createLogger } from '@platform/logger';
import { config } from '../config/index.js';
import { BadRequestError } from '../lib/errors.js';

// Resolution runs deep inside an intake transaction with no request-scoped
// logger to hand, the same reason meta-capi-trigger.ts carries its own.
const log = createLogger({ service: 'leads-service', nodeEnv: config.nodeEnv });

/**
 * ext.meta_leads.platform -> marketing.marketing_platforms.name.
 * Mirrors PLATFORM_MAP in msq-lms/meta-sync-scripts/sync_campaigns.py; both
 * paths create the same marketing.ad_campaigns row and must agree on it.
 */
const PLATFORM_MAP: Record<string, string> = { fb: 'facebook', ig: 'instagram' };
const DEFAULT_PLATFORM_NAME = 'facebook';

/** Meta effective_status -> marketing.campaign_statuses.name. Mirrors STATUS_MAP there. */
const STATUS_MAP: Record<string, string> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  CAMPAIGN_PAUSED: 'paused',
  ADSET_PAUSED: 'paused',
  ARCHIVED: 'archived',
  DELETED: 'archived',
  IN_PROCESS: 'draft',
  WITH_ISSUES: 'draft',
  PENDING_REVIEW: 'draft',
  DISAPPROVED: 'draft',
};
const DEFAULT_STATUS_NAME = 'draft';

export interface ResolveCampaignInput {
  /**
   * Meta's own campaign id. A string, not a number: Meta campaign ids run to 17
   * digits, past Number.MAX_SAFE_INTEGER, so parsing one into a JS number
   * silently corrupts the low digits and would match the wrong branch row.
   * Every query below casts it with `::bigint` instead.
   */
  metaCampaignId?: string | null;
  metaCampaignName?: string | null;
  /** 'fb' | 'ig' as carried on the webhook; anything else falls back to facebook. */
  metaPlatform?: string | null;
  /** Meta effective_status, when the caller happens to know it. */
  metaCampaignStatus?: string | null;
  /**
   * The type meta-conversion-api resolved for this campaign. IT owns ext.* — it
   * holds the Graph token and the ext.meta_campaigns mapping — so on the Meta
   * path the answer arrives already decided rather than being looked up here.
   */
  campaignTypeId?: string | null;
  /**
   * The page/form-level fallback (ext.meta_page_form_org_map.default_campaign_type_id),
   * passed IN by the caller for the same reason: that table lives in ext.*.
   */
  defaultCampaignTypeId?: string | null;
}

export interface ResolvedCampaign {
  campaign_id: string | null;
  campaign_type_id: string | null;
}

/**
 * Confirms a campaign type is real, live, and belongs to this org's tenant, and
 * returns it.
 *
 * Throws rather than falling through when a supplied type fails the check. The
 * public intake route spreads the caller's whole body into WebhookLeadData, so
 * `campaign_type_id` is genuinely attacker-controlled there; quietly swapping a
 * foreign tenant's id for the local default would route the lead as if the
 * request had been legitimate and leave nothing in the logs. A bad type is a bad
 * request.
 */
//
// ONE DISTINCTION, drawn on purpose: a type of THIS tenant that has since been
// deactivated or deleted is NOT a bad request. It is an admin retiring a pool
// while Meta keeps delivering leads for a campaign still mapped to it, and
// refusing it failed intake — a lost customer lead — over a housekeeping
// change. That case returns null and the caller falls through its ladder with a
// warning. An unknown id, or one owned by another tenant, still throws.
async function tenantTypeIfLive(tx: DrizzleTx, orgId: string, typeId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT ct.id, (ct.is_active AND NOT ct.is_deleted) AS live
    FROM marketing.campaign_types ct
    WHERE ct.id = ${typeId}::uuid
      AND ct.tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${orgId}::uuid)
    LIMIT 1
  `)) as Array<{ id: string; live: boolean }>;
  if (!rows[0]) throw new BadRequestError('Unknown campaign type for this tenant');
  return rows[0].live ? rows[0].id : null;
}

/** The tenant's catch-all pool. At most one per tenant (uix_campaign_types_one_default). */
async function tenantDefaultType(tx: DrizzleTx, orgId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT ct.id
    FROM marketing.campaign_types ct
    WHERE ct.is_default
      AND ct.is_active
      AND NOT ct.is_deleted
      AND ct.tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${orgId}::uuid)
    LIMIT 1
  `)) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * The branch's projection of a Meta campaign, created on first sight.
 *
 * ON CONFLICT DO NOTHING then re-select, never a bare INSERT: two webhook
 * deliveries for a brand-new campaign arrive concurrently often enough that the
 * race is routine, and uix_ad_campaigns_org_meta_campaign_id would turn the
 * loser into a 23505 that fails an otherwise good lead.
 *
 * Returns null when the tenant has no matching platform/status catalog row.
 * Deliberately not an error: the lead still gets its TYPE and is still created
 * and routed. Dropping an inbound lead over a missing dropdown entry would be a
 * far worse failure than a lead with no campaign attached.
 */
async function ensureBranchCampaign(
  tx: DrizzleTx,
  orgId: string,
  metaCampaignId: string,
  input: ResolveCampaignInput,
  campaignTypeId: string | null,
): Promise<string | null> {
  const existing = (await tx.execute(sql`
    SELECT id FROM marketing.ad_campaigns
    WHERE org_id = ${orgId}::uuid AND meta_campaign_id = ${metaCampaignId}::bigint
    LIMIT 1
  `)) as Array<{ id: string }>;
  if (existing[0]) return existing[0].id;

  // marketing.marketing_platforms / campaign_statuses are tenant-scoped, so both
  // lookups resolve against the CAMPAIGN's tenant via org_id — the same fix
  // sync_campaigns.py carries. A global `WHERE name =` would pick an arbitrary
  // tenant's row here, since this runs under a BYPASSRLS service tx.
  const platformName = PLATFORM_MAP[String(input.metaPlatform ?? '').toLowerCase()] ?? DEFAULT_PLATFORM_NAME;
  const statusName = STATUS_MAP[String(input.metaCampaignStatus ?? '').toUpperCase()] ?? DEFAULT_STATUS_NAME;

  const catalog = (await tx.execute(sql`
    SELECT
      (SELECT id FROM marketing.marketing_platforms
        WHERE name = ${platformName}
          AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${orgId}::uuid)
        LIMIT 1) AS platform_id,
      (SELECT id FROM marketing.campaign_statuses
        WHERE name = ${statusName}
          AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${orgId}::uuid)
        LIMIT 1) AS status_id
  `)) as Array<{ platform_id: string | null; status_id: string | null }>;

  const platformId = catalog[0]?.platform_id ?? null;
  const statusId = catalog[0]?.status_id ?? null;
  if (!platformId || !statusId) {
    log.warn(
      { event: 'lead.campaign_projection_skipped', org_id: orgId, meta_campaign_id: metaCampaignId, platform: platformName, status: statusName },
      'No tenant platform/status catalog row; lead keeps its type but gets no campaign',
    );
    return null;
  }

  const name = input.metaCampaignName?.trim() || `Meta Campaign ${metaCampaignId}`;

  await tx.execute(sql`
    INSERT INTO marketing.ad_campaigns (org_id, name, platform_id, status_id, meta_campaign_id, campaign_type_id)
    VALUES (
      ${orgId}::uuid, ${name}, ${platformId}::uuid, ${statusId}::uuid,
      ${metaCampaignId}::bigint,
      ${campaignTypeId}::uuid
    )
    -- The WHERE is not optional. uix_ad_campaigns_org_meta_campaign_id is a
    -- PARTIAL unique index, and Postgres will only infer a partial index when
    -- the conflict target repeats its predicate; without it this statement
    -- fails outright with "no unique or exclusion constraint matching the
    -- ON CONFLICT specification".
    ON CONFLICT (org_id, meta_campaign_id) WHERE meta_campaign_id IS NOT NULL DO NOTHING
  `);

  // Re-select rather than RETURNING: DO NOTHING returns no row for the loser of
  // the race, and that loser still needs the winner's id.
  const created = (await tx.execute(sql`
    SELECT id FROM marketing.ad_campaigns
    WHERE org_id = ${orgId}::uuid AND meta_campaign_id = ${metaCampaignId}::bigint
    LIMIT 1
  `)) as Array<{ id: string }>;
  return created[0]?.id ?? null;
}

/**
 * What campaign and what TYPE a newly arriving lead belongs to.
 *
 * Type resolves in a fixed order, most specific first:
 *   1. the type the caller resolved (the Meta path — meta-conversion-api);
 *   2. the page/form default the caller passed in;
 *   3. the tenant's is_default type — walk-ins, the public API, anything with no
 *      Meta campaign at all.
 * Both caller-supplied ids are checked against the org's tenant before use.
 *
 * This service never reads `ext.*`. That schema belongs to meta-conversion-api,
 * which holds the Graph token and owns the campaign -> type mapping; the resolved
 * ids arrive as arguments instead. Keeping that line means the two services stay
 * separable and no cross-service grant is added here.
 *
 * Runs inside the caller's transaction so the campaign row it may create and the
 * lead that needs it commit or roll back together.
 */
export async function resolveCampaignForLead(
  tx: DrizzleTx,
  orgId: string,
  input: ResolveCampaignInput,
): Promise<ResolvedCampaign> {
  let campaignTypeId: string | null = null;
  const supplied = [
    ['caller', input.campaignTypeId],
    ['form_default', input.defaultCampaignTypeId],
  ] as const;
  for (const [source, candidate] of supplied) {
    if (!candidate) continue;
    campaignTypeId = await tenantTypeIfLive(tx, orgId, candidate);
    if (campaignTypeId) break;
    log.warn(
      { event: 'lead.campaign_type_inactive', org_id: orgId, campaign_type_id: candidate, source },
      'Supplied campaign type is inactive; falling back to the next rung',
    );
  }
  if (!campaignTypeId) {
    campaignTypeId = await tenantDefaultType(tx, orgId);
    if (!campaignTypeId) {
      // Every tenant gets `sales` + `hiring` from entity.seed_tenant_rbac(), so
      // this means the default was deleted or unflagged. The lead is still
      // created; it simply cannot be routed, which the caller then logs.
      log.warn({ event: 'lead.no_default_campaign_type', org_id: orgId }, 'Tenant has no default campaign type');
    }
  }

  const metaCampaignId = input.metaCampaignId != null ? String(input.metaCampaignId).trim() : '';
  if (!metaCampaignId) return { campaign_id: null, campaign_type_id: campaignTypeId };

  const campaignId = await ensureBranchCampaign(tx, orgId, metaCampaignId, input, campaignTypeId);
  return { campaign_id: campaignId, campaign_type_id: campaignTypeId };
}
