import { sql } from 'drizzle-orm';
import { withServiceTx, withTenantConfigTx, type DrizzleTx } from '@platform/db';
import { NotFoundError, pgError } from '../lib/errors.js';
import { assertTenantExists } from '../lib/admin-tenant.js';
import { getGlobalIntegration } from './integration.service.js';
import { listAccountCampaignsDetailed, type MetaCampaignDetailed } from './meta-api.service.js';
import { matchCampaignRules } from './campaign-mapping.service.js';
import type { LeadSyncLogger } from './lead-sync.service.js';

// ── "Fetch campaigns": every enabled ad account, attributed by PAGE (1.51.0) ──
//
// The proactive twin of campaign-mapping.service.ts. That one discovers a
// campaign the moment a lead arrives on it; this one walks the ad accounts up
// front so an admin can type campaigns BEFORE their first lead lands.
//
// SHARED-APP MODEL. One Meta integration (the tenant_id IS NULL row) serves every
// tenant, and one ad account routinely carries campaigns for several tenants'
// pages. So a campaign is attributed to a tenant by the PAGES its ad sets promote
// (promoted_object.page_id), looked up in ext.meta_page_form_org_map — never by
// which tenant pressed the button. Before 1.51.0 every campaign in the account
// was inserted under the pressing tenant, which then owned the global row and
// locked every other tenant out of classifying its own campaigns.
//
//   pages map to exactly ONE tenant   -> upsert under that tenant
//   pages map to NO tenant            -> reported as `unattributed`, not stored
//   pages map to MORE THAN ONE tenant -> reported as a conflict, not stored; an
//                                        existing row is flagged (conflict_reason).
//                                        A campaign must never span tenants
//                                        (product decision 2026-09-26).
//
// THE INVARIANT THIS MODULE EXISTS TO PROTECT:
//
//   A CONFIRMED MAPPING IS NEVER OVERWRITTEN.
//
// A fetch refreshes a confirmed row's NAME, STATUS, pages and last_synced_at —
// facts that belong to Meta — and touches campaign_type_id, mapping_status,
// confirmed_by and confirmed_at not at all. Unconfirmed rows get a fresh
// SUGGESTION from the ordered rules every fetch, because the point of editing a
// rule is that it takes effect. campaign_type_id is never written here at all:
// only an admin confirm sets it.

export interface CampaignSyncResult {
  /** Campaigns returned by Meta across every enabled ad account. */
  fetched: number;
  /** Rows this run created. A second, identical run reports 0. */
  inserted: number;
  suggested: number;
  unmapped: number;
  /** Rows left alone (mapping-wise) because an admin had confirmed them. */
  confirmed_untouched: number;
  /** Campaigns whose pages map to no tenant — map the pages, then fetch again. */
  unattributed: CampaignSyncIssue[];
  /** Campaigns whose pages map to more than one tenant. */
  conflicts: CampaignSyncIssue[];
  /** Campaigns attributed to a tenant OTHER than the one selected (tenant-scoped runs only). */
  other_tenant: number;
  /** Ad accounts walked. */
  ad_accounts: number;
  errors: CampaignSyncError[];
}

export interface CampaignSyncIssue {
  meta_campaign_id: string;
  name: string | null;
  page_ids: string[];
}

export interface CampaignSyncError {
  ad_account_id: string | null;
  meta_campaign_id: string | null;
  message: string;
}

interface UpsertRow {
  inserted: boolean;
  mapping_status: 'unmapped' | 'suggested' | 'confirmed';
}

/**
 * The three-way upsert, as ONE statement, under the ATTRIBUTED tenant's
 * withTenantConfigTx — so ext.meta_campaigns' admin_tenant_config_policy fences
 * the write to that tenant.
 *
 * | existing row | what happens                                                     |
 * |--------------|------------------------------------------------------------------|
 * | none         | insert, first_seen_source='fetch', suggestion from the rules     |
 * | 'confirmed'  | refresh Meta facts ONLY                                           |
 * | otherwise    | refresh Meta facts AND the suggestion                            |
 *
 * `xmax = 0` tells the INSERT arm from the UPDATE arm in RETURNING (a freshly
 * inserted tuple has no updating transaction yet).
 *
 * A row owned by ANOTHER tenant is invisible under this tenant's RLS; Postgres
 * answers the conflict with 23505/42501, which the caller records per campaign.
 */
async function upsertCampaign(
  tx: DrizzleTx,
  tenantId: string,
  adAccountId: string,
  campaign: MetaCampaignDetailed,
): Promise<UpsertRow | null> {
  const name = campaign.name?.trim() || null;
  const suggestion = name ? await matchCampaignRules(tx, tenantId, { campaignName: name }) : null;
  const pageIds = campaign.page_ids.filter((p) => /^\d+$/.test(p));
  const pageArray = pageIds.length
    ? sql`ARRAY[${sql.join(pageIds.map((p) => sql`${p}::bigint`), sql`, `)}]::bigint[]`
    : sql`'{}'::bigint[]`;

  const rows = (await tx.execute(sql`
    INSERT INTO ext.meta_campaigns (
      tenant_id, ad_account_id, meta_campaign_id, name, objective, effective_status,
      meta_created_time, campaign_type_id, suggested_campaign_type_id, matched_rule_id,
      matched_keyword, mapping_status, page_ids, conflict_reason, first_seen_source, last_synced_at
    ) VALUES (
      ${tenantId}::uuid, ${adAccountId}, ${campaign.meta_campaign_id}::bigint, ${name},
      ${campaign.objective}, ${campaign.effective_status}, ${campaign.created_time}::timestamptz,
      NULL, ${suggestion?.campaign_type_id ?? null}::uuid, ${suggestion?.rule_id ?? null}::uuid,
      ${suggestion?.pattern ?? null}, ${suggestion ? 'suggested' : 'unmapped'}, ${pageArray}, NULL,
      'fetch', NOW()
    )
    ON CONFLICT (meta_campaign_id) DO UPDATE SET
      -- Facts owned by Meta. Refreshed on every row, confirmed included.
      name              = EXCLUDED.name,
      objective         = EXCLUDED.objective,
      effective_status  = EXCLUDED.effective_status,
      meta_created_time = EXCLUDED.meta_created_time,
      ad_account_id     = EXCLUDED.ad_account_id,
      page_ids          = EXCLUDED.page_ids,
      conflict_reason   = NULL,
      last_synced_at    = NOW(),
      -- The suggestion. Re-derived ONLY when no human has ruled on it.
      suggested_campaign_type_id = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                                        THEN ext.meta_campaigns.suggested_campaign_type_id
                                        ELSE EXCLUDED.suggested_campaign_type_id END,
      matched_rule_id  = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                              THEN ext.meta_campaigns.matched_rule_id
                              ELSE EXCLUDED.matched_rule_id END,
      matched_keyword  = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                              THEN ext.meta_campaigns.matched_keyword
                              ELSE EXCLUDED.matched_keyword END,
      mapping_status   = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                              THEN 'confirmed'
                              ELSE EXCLUDED.mapping_status END
      -- campaign_type_id / confirmed_by / confirmed_at appear in neither list:
      -- not touching a column is a stronger guarantee than writing it back.
    RETURNING (xmax = 0) AS inserted, mapping_status
  `)) as unknown as UpsertRow[];

  // Name caches for the per-lead rules (ad set / ad names) and each ad set's
  // promoted page. Same tenant, same transaction.
  for (const s of campaign.adsets) {
    await tx.execute(sql`
      INSERT INTO ext.meta_adsets (tenant_id, meta_adset_id, meta_campaign_id, name, promoted_page_id, effective_status, last_synced_at)
      VALUES (${tenantId}::uuid, ${s.adset_id}::bigint, ${campaign.meta_campaign_id}::bigint, ${s.name},
              ${s.promoted_page_id}::bigint, ${s.effective_status}, NOW())
      ON CONFLICT (meta_adset_id) DO UPDATE
        SET name = EXCLUDED.name, promoted_page_id = EXCLUDED.promoted_page_id,
            effective_status = EXCLUDED.effective_status, meta_campaign_id = EXCLUDED.meta_campaign_id,
            last_synced_at = NOW()
    `);
  }
  for (const a of campaign.ads) {
    await tx.execute(sql`
      INSERT INTO ext.meta_ads (tenant_id, meta_ad_id, meta_adset_id, meta_campaign_id, name, effective_status, last_synced_at)
      VALUES (${tenantId}::uuid, ${a.ad_id}::bigint, ${a.adset_id}::bigint, ${campaign.meta_campaign_id}::bigint,
              ${a.name}, ${a.effective_status}, NOW())
      ON CONFLICT (meta_ad_id) DO UPDATE
        SET name = EXCLUDED.name, meta_adset_id = EXCLUDED.meta_adset_id,
            effective_status = EXCLUDED.effective_status, meta_campaign_id = EXCLUDED.meta_campaign_id,
            last_synced_at = NOW()
    `);
  }

  return rows[0] ?? null;
}

function errorMessage(err: unknown): string {
  const { code } = pgError(err);
  if (code === '23505' || code === '42501') {
    return 'Campaign is already registered to a different tenant';
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

export interface CampaignSyncOptions {
  log?: LeadSyncLogger | undefined;
}

export interface CampaignSyncScope {
  actorUserId: string;
  /**
   * Optional. Set: only campaigns attributed to THIS tenant are written (the
   * Meta Campaigns screen, which administers one tenant). Unset: every
   * attributable campaign lands in its own tenant.
   */
  tenantId?: string | undefined;
}

/**
 * Page -> tenant for every active page mapping, across tenants.
 *
 * withServiceTx (BYPASSRLS), a documented SYSTEM read: attributing a campaign
 * to its tenant is by definition a cross-tenant question — which tenant owns
 * this page? — and no single tenant's RLS context can answer it. It reads page
 * ids and tenant ids only. Every WRITE that follows runs under the attributed
 * tenant's withTenantConfigTx, where RLS is the fence again.
 */
async function loadPageTenants(): Promise<Map<string, Set<string>>> {
  const rows = (await withServiceTx((tx) => tx.execute(sql`
    SELECT DISTINCT page_id::text AS page_id, tenant_id
    FROM ext.meta_page_form_org_map
    WHERE is_active
  `))) as unknown as Array<{ page_id: string; tenant_id: string }>;
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = map.get(r.page_id) ?? new Set<string>();
    set.add(r.tenant_id);
    map.set(r.page_id, set);
  }
  return map;
}

/** Enabled ad accounts. Platform-level table, root_service only — see 02_tables_core.sql. */
async function loadEnabledAdAccounts(): Promise<string[]> {
  const rows = (await withServiceTx((tx) => tx.execute(sql`
    SELECT ad_account_id FROM ext.meta_ad_accounts WHERE is_enabled ORDER BY ad_account_id
  `))) as unknown as Array<{ ad_account_id: string }>;
  return rows.map((r) => r.ad_account_id);
}

/**
 * Walks every ENABLED ad account with the shared integration's token and lands
 * each campaign in the tenant its pages belong to.
 *
 * Callers: super_admin routes only (the controller checks RANKS.SUPER_ADMIN).
 *
 * Partial success is the honest answer: a failing ad account is recorded in
 * `errors` and the run continues; a failing campaign likewise.
 */
export async function syncCampaigns(
  scope: CampaignSyncScope,
  options: CampaignSyncOptions = {},
): Promise<CampaignSyncResult> {
  if (scope.tenantId) {
    const tenantId = scope.tenantId;
    // A bogus tenant id must be a 404, not a run that walks every account and
    // then writes nothing.
    await withTenantConfigTx({ actorUserId: scope.actorUserId, tenantId }, (tx) => assertTenantExists(tx, tenantId));
  }

  const integration = await getGlobalIntegration();
  if (!integration || !integration.is_active) {
    throw new NotFoundError('No active shared Meta integration is configured');
  }

  const adAccountIds = await loadEnabledAdAccounts();
  if (adAccountIds.length === 0) {
    throw new NotFoundError(
      'No ad accounts are enabled. Open Meta Ad Accounts, sync the list from Meta and enable the accounts to walk.',
    );
  }

  const pageTenants = await loadPageTenants();

  const result: CampaignSyncResult = {
    fetched: 0,
    inserted: 0,
    suggested: 0,
    unmapped: 0,
    confirmed_untouched: 0,
    unattributed: [],
    conflicts: [],
    other_tenant: 0,
    ad_accounts: adAccountIds.length,
    errors: [],
  };

  for (const adAccountId of adAccountIds) {
    let campaigns: MetaCampaignDetailed[];
    try {
      campaigns = await listAccountCampaignsDetailed(adAccountId, integration.access_token, integration.graph_api_version, {
        onBackoff: (info) => {
          options.log?.warn(
            { evt: 'campaign_sync.graph_backoff', adAccountId, attempt: info.attempt, delayMs: info.delay_ms, reason: info.reason },
            'Backing off a Meta Graph call',
          );
        },
      });
    } catch (err) {
      // The most common cause is a token without `ads_read`, or an account the
      // system user was never assigned — both fixable once visible.
      options.log?.warn({ evt: 'campaign_sync.account_failed', err, adAccountId }, 'Ad account fetch failed; continuing');
      result.errors.push({ ad_account_id: adAccountId, meta_campaign_id: null, message: errorMessage(err) });
      continue;
    }

    result.fetched += campaigns.length;

    for (const campaign of campaigns) {
      const tenants = new Set<string>();
      for (const p of campaign.page_ids) for (const t of pageTenants.get(p) ?? []) tenants.add(t);
      const issue: CampaignSyncIssue = {
        meta_campaign_id: campaign.meta_campaign_id,
        name: campaign.name,
        page_ids: campaign.page_ids,
      };

      if (tenants.size === 0) {
        result.unattributed.push(issue);
        continue;
      }
      if (tenants.size > 1) {
        result.conflicts.push(issue);
        // Flag an existing row so the grid shows it. System write, one column,
        // on a row identified by its global natural id.
        await withServiceTx((tx) => tx.execute(sql`
          UPDATE ext.meta_campaigns
          SET conflict_reason = 'This campaign promotes pages mapped to more than one tenant.',
              page_ids = ARRAY[${sql.join(campaign.page_ids.map((p) => sql`${p}::bigint`), sql`, `)}]::bigint[],
              updated_at = NOW()
          WHERE meta_campaign_id = ${campaign.meta_campaign_id}::bigint
        `)).catch(() => undefined);
        continue;
      }

      const tenantId = [...tenants][0]!;
      if (scope.tenantId && scope.tenantId !== tenantId) {
        result.other_tenant += 1;
        continue;
      }

      try {
        // One transaction PER CAMPAIGN: one failing campaign must not roll back
        // the hundreds already written.
        const row = await withTenantConfigTx(
          { actorUserId: scope.actorUserId, tenantId },
          (tx) => upsertCampaign(tx, tenantId, adAccountId, campaign),
        );
        if (!row) continue;
        if (row.inserted) result.inserted += 1;
        if (row.mapping_status === 'suggested') result.suggested += 1;
        else if (row.mapping_status === 'unmapped') result.unmapped += 1;
        else result.confirmed_untouched += 1;
      } catch (err) {
        result.errors.push({ ad_account_id: adAccountId, meta_campaign_id: campaign.meta_campaign_id, message: errorMessage(err) });
      }
    }

    await withServiceTx((tx) => tx.execute(sql`
      UPDATE ext.meta_ad_accounts SET last_synced_at = NOW(), updated_at = NOW() WHERE ad_account_id = ${adAccountId}
    `)).catch(() => undefined);
  }

  return result;
}
