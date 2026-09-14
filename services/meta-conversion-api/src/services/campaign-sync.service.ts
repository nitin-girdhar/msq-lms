import { sql } from 'drizzle-orm';
import { withTenantConfigTx, type DrizzleTx } from '@platform/db';
import { NotFoundError, pgError } from '../lib/errors.js';
import { assertTenantExists } from '../lib/admin-tenant.js';
import { getIntegrationByTenantId } from './integration.service.js';
import { listAccountCampaigns, type MetaCampaign } from './meta-api.service.js';
import { KEYWORD_MATCH_SQL } from './campaign-mapping.service.js';
import type { AdminTenantScope } from './page-org-map.admin.service.js';
import type { LeadSyncLogger } from './lead-sync.service.js';

// ── "Fetch campaigns": a tenant's whole ad-account catalogue ─────────────────
//
// The proactive twin of campaign-mapping.service.ts. That one discovers a
// campaign the moment a lead arrives on it; this one walks the ad accounts up
// front so an admin can classify campaigns BEFORE their first lead lands, rather
// than finding out a hiring campaign was routed to sales by reading the sales
// rep's inbox.
//
// THE INVARIANT THIS MODULE EXISTS TO PROTECT:
//
//   A CONFIRMED MAPPING IS NEVER OVERWRITTEN.
//
// That is the product's explicit "works from next time onwards" guarantee, not a
// preference. An inferred type is provisional; an admin's decision is not. A
// fetch refreshes a confirmed row's NAME, STATUS and last_synced_at — facts that
// belong to Meta — and touches campaign_type_id, mapping_status,
// matched_keyword, confirmed_by and confirmed_at not at all. An admin who
// corrects a mapping and then presses Fetch must never watch their correction
// disappear.
//
// `suggested` and `unmapped` rows are the opposite case: they are re-matched on
// every fetch, because the admin may have improved a type's `match_keywords`
// since the row was created and the whole point of adding a keyword is that it
// takes effect.

export interface CampaignSyncResult {
  /** Campaigns returned by Meta across every ad account. */
  fetched: number;
  /** Rows this run created. A second, identical run reports 0 — see the idempotency note. */
  inserted: number;
  suggested: number;
  unmapped: number;
  /** Rows left alone because an admin had confirmed them. The invariant, counted. */
  confirmed_untouched: number;
  errors: CampaignSyncError[];
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
 * The three-way upsert, as ONE statement.
 *
 * | existing row | what happens                                                  |
 * |--------------|---------------------------------------------------------------|
 * | none         | insert, first_seen_source='fetch', run the matcher             |
 * | 'confirmed'  | refresh name / objective / status / last_synced_at ONLY        |
 * | otherwise    | refresh metadata AND re-run the matcher                        |
 *
 * One statement rather than a read-then-write, because a fetch and an inbound
 * lead for the same brand-new campaign race routinely and the read-then-write
 * version loses that race by writing a stale decision over a fresh one.
 *
 * `xmax = 0` is how Postgres distinguishes the INSERT arm of an upsert from the
 * UPDATE arm in RETURNING: a freshly inserted tuple has no updating transaction
 * yet. It is what makes acceptance criterion 4 (a second run reports `0
 * inserted`) checkable at all, since both arms otherwise return an identical
 * row. And because a newly inserted row can never be `confirmed`, an
 * `xmax <> 0 AND mapping_status = 'confirmed'` result is exactly "a confirmed
 * mapping this fetch left alone".
 *
 * The statement runs under `withTenantConfigTx`, so `ext.meta_campaigns`'
 * admin_tenant_config_policy fences it to the administered tenant. Note what
 * that means for a SHARED ad account: `uq_meta_campaigns_campaign_id` is global,
 * so a campaign already owned by tenant A cannot be inserted for tenant B, and
 * the conflicting row is invisible to B under RLS. Postgres answers that with a
 * 23505 or a 42501 rather than silently doing the right thing — which is
 * correct, and is why the caller records it per campaign and carries on instead
 * of failing the run.
 */
async function upsertCampaign(
  tx: DrizzleTx,
  tenantId: string,
  adAccountId: string,
  campaign: MetaCampaign,
): Promise<UpsertRow | null> {
  const name = campaign.name?.trim() || null;

  const rows = (await tx.execute(sql`
    WITH matched AS (
      SELECT ct.id AS campaign_type_id,
             ${KEYWORD_MATCH_SQL(sql`${name}`)} AS matched_keyword
      FROM marketing.campaign_types ct
      WHERE ct.id = marketing.fn_match_campaign_type(${tenantId}::uuid, ${name})
      LIMIT 1
    ),
    resolved AS (
      SELECT
        (SELECT campaign_type_id FROM matched)  AS campaign_type_id,
        (SELECT matched_keyword  FROM matched)  AS matched_keyword,
        CASE WHEN (SELECT campaign_type_id FROM matched) IS NOT NULL
             THEN 'suggested' ELSE 'unmapped' END AS mapping_status
    )
    INSERT INTO ext.meta_campaigns (
      tenant_id, ad_account_id, meta_campaign_id, name, objective, effective_status,
      meta_created_time, campaign_type_id, mapping_status, matched_keyword,
      first_seen_source, last_synced_at
    )
    SELECT
      ${tenantId}::uuid, ${adAccountId}, ${campaign.meta_campaign_id}::bigint, ${name},
      ${campaign.objective}, ${campaign.effective_status}, ${campaign.created_time}::timestamptz,
      r.campaign_type_id, r.mapping_status, r.matched_keyword,
      'fetch', NOW()
    FROM resolved r
    ON CONFLICT (meta_campaign_id) DO UPDATE SET
      -- Facts owned by Meta. Refreshed on every row, confirmed included: an
      -- admin who renamed a campaign in Ads Manager should see the new name.
      name              = EXCLUDED.name,
      objective         = EXCLUDED.objective,
      effective_status  = EXCLUDED.effective_status,
      meta_created_time = EXCLUDED.meta_created_time,
      ad_account_id     = EXCLUDED.ad_account_id,
      last_synced_at    = NOW(),
      -- The mapping. Re-derived ONLY when no human has ruled on it.
      campaign_type_id = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                              THEN ext.meta_campaigns.campaign_type_id
                              ELSE EXCLUDED.campaign_type_id END,
      mapping_status   = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                              THEN 'confirmed'
                              ELSE EXCLUDED.mapping_status END,
      matched_keyword  = CASE WHEN ext.meta_campaigns.mapping_status = 'confirmed'
                              THEN ext.meta_campaigns.matched_keyword
                              ELSE EXCLUDED.matched_keyword END
      -- confirmed_by / confirmed_at appear in neither list. Not touching a
      -- column is a stronger guarantee than writing it back to itself.
    RETURNING (xmax = 0) AS inserted, mapping_status
  `)) as unknown as UpsertRow[];

  return rows[0] ?? null;
}

function errorMessage(err: unknown): string {
  const { code } = pgError(err);
  if (code === '23505' || code === '42501') {
    // The shared-ad-account case above. Named explicitly because "duplicate key"
    // tells an operator nothing about why a campaign in THEIR account will not
    // sync, and the remedy (that campaign belongs to another tenant's
    // integration) is not guessable from the raw string.
    return 'Campaign is already registered to a different tenant';
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

export interface CampaignSyncOptions {
  log?: LeadSyncLogger | undefined;
}

/**
 * Runs the fetch for one administered tenant.
 *
 * `scope.tenantId` is the tenant the operator SELECTED in the console, never the
 * tenant on their own session — platform staff belong to a different one. Same
 * rule, and the same reasoning, as page-org-map.admin.service.ts.
 *
 * A failing ad account is recorded in `errors` and the run continues to the
 * next. Partial success is the honest answer for an operation that spans several
 * accounts and hundreds of campaigns: aborting on the first 429 would discard
 * everything already fetched and tell the admin nothing about which half landed.
 */
export async function syncTenantCampaigns(
  scope: AdminTenantScope,
  options: CampaignSyncOptions = {},
): Promise<CampaignSyncResult> {
  // Before any Graph credential is spent: a bogus tenant id must be a 404, not
  // a run that fetches an ad account and then fails on every insert.
  await withTenantConfigTx(
    { actorUserId: scope.actorUserId, tenantId: scope.tenantId },
    (tx) => assertTenantExists(tx, scope.tenantId),
  );

  const integration = await getIntegrationByTenantId(scope.tenantId);
  if (!integration || !integration.is_active) {
    throw new NotFoundError('No active Meta integration configured for this tenant');
  }

  const adAccountIds = integration.ad_account_ids ?? [];
  if (adAccountIds.length === 0) {
    throw new NotFoundError(
      'No ad accounts configured for this tenant — set ext.meta_tenant_config.ad_account_ids first',
    );
  }

  const result: CampaignSyncResult = {
    fetched: 0,
    inserted: 0,
    suggested: 0,
    unmapped: 0,
    confirmed_untouched: 0,
    errors: [],
  };

  for (const adAccountId of adAccountIds) {
    let campaigns: MetaCampaign[];
    try {
      campaigns = await listAccountCampaigns(
        adAccountId,
        integration.access_token,
        integration.graph_api_version,
        {
          onBackoff: (info) => {
            options.log?.warn(
              {
                evt: 'campaign_sync.graph_backoff',
                adAccountId,
                tenantId: scope.tenantId,
                attempt: info.attempt,
                delayMs: info.delay_ms,
                reason: info.reason,
              },
              'Backing off a Meta Graph call',
            );
          },
        },
      );
    } catch (err) {
      // Nothing from this account, but the other accounts are independent. The
      // most common cause is a token without `ads_read`, which is a
      // configuration problem the admin can act on once they can see it.
      options.log?.warn(
        { evt: 'campaign_sync.account_failed', err, adAccountId, tenantId: scope.tenantId },
        'Ad account fetch failed; continuing with the remaining accounts',
      );
      result.errors.push({
        ad_account_id: adAccountId,
        meta_campaign_id: null,
        message: errorMessage(err),
      });
      continue;
    }

    result.fetched += campaigns.length;

    for (const campaign of campaigns) {
      try {
        // One transaction PER CAMPAIGN, not one per run. A single failing
        // campaign must not roll back the hundreds already written, which is
        // exactly what a run-wide transaction would do to the shared-ad-account
        // conflict above.
        const row = await withTenantConfigTx(
          { actorUserId: scope.actorUserId, tenantId: scope.tenantId },
          (tx) => upsertCampaign(tx, scope.tenantId, adAccountId, campaign),
        );
        if (!row) continue;

        if (row.inserted) result.inserted += 1;
        if (row.mapping_status === 'suggested') result.suggested += 1;
        else if (row.mapping_status === 'unmapped') result.unmapped += 1;
        else if (!row.inserted) result.confirmed_untouched += 1;
      } catch (err) {
        result.errors.push({
          ad_account_id: adAccountId,
          meta_campaign_id: campaign.meta_campaign_id,
          message: errorMessage(err),
        });
      }
    }
  }

  return result;
}
