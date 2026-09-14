import { sql } from 'drizzle-orm';
import { withServiceTx, withTenantConfigTx, type DrizzleTx } from '@platform/db';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { assertTenantExists } from '../lib/admin-tenant.js';
import { reclassifyCampaign, type ReclassifyResult } from '../lib/internal-leads-client.js';
import type { AdminTenantScope } from './page-org-map.admin.service.js';
import type { MappingStatus } from './campaign-mapping.service.js';

// ── Admin surface for ext.meta_campaigns (lookup-admin console) ─────────────
//
// Kept OUT of campaign-mapping.service.ts on purpose. That module is the live
// webhook path: it runs on `withServiceTx` (BYPASSRLS) because an inbound Meta
// delivery carries no session at all. Everything here is the opposite — an
// authenticated platform super_admin acting on ONE selected tenant, fully
// RLS-scoped through `withTenantConfigTx`. page-org-map.service.ts had to be
// split for exactly this reason after its read path ended up on withServiceTx
// beneath a comment claiming RLS scoped it; there is no reason to re-learn that
// here.
//
// The administered tenant is an explicit argument on every operation, taken from
// ?tenant_id= and never from the caller's own session. A platform super_admin
// belongs to a different tenant than the one they administer, so a silent
// fallback to `ctx.tenant_id` would scope every read to zero rows and stamp
// every write with the wrong owner. That precise bug was removed from the
// page-org-map API one phase ago and must not be reintroduced.

export interface MetaCampaignRow {
  id: string;
  tenant_id: string;
  ad_account_id: string | null;
  meta_campaign_id: string;
  name: string | null;
  objective: string | null;
  effective_status: string | null;
  meta_created_time: string | null;
  campaign_type_id: string | null;
  campaign_type_name: string | null;
  campaign_type_label: string | null;
  mapping_status: MappingStatus;
  matched_keyword: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  first_seen_source: string | null;
  last_synced_at: string | null;
  /** Leads received on this campaign, across every branch. */
  lead_count: number;
}

export interface ListCampaignsFilters {
  mapping_status?: MappingStatus | undefined;
}

/**
 * The three admin grids, backed by one query and a `?mapping_status=` filter.
 *
 * The per-campaign LEAD COUNT is the column that makes the grid usable. An ad
 * account holds years of campaigns, most of them long dead; "which of these
 * actually matter" is answerable only by how many leads each one brought in, and
 * without it an admin classifying by hand has no way to tell a live hiring
 * campaign from a test one someone ran in 2023.
 *
 * The count is NOT read inside the admin transaction. `ext.meta_leads` is
 * ORG-scoped — its app_user policy keys on app.current_org_id, which
 * withTenantConfigTx deliberately never sets — so a subquery there returned
 * ZERO for every campaign with no error, and the column the grid exists for
 * read 0 across the board (lead-pull.admin.service.ts documents the same
 * table behaving the same way). It is counted separately in
 * `leadCountsByCampaign`, then merged by campaign id.
 *
 * No `WHERE tenant_id = …` on the campaigns themselves, deliberately:
 * admin_tenant_config_policy is the scope. A literal filter alongside the policy
 * would make the cross-tenant acceptance test pass whether or not the policy is
 * doing its job.
 */
export async function listCampaigns(
  scope: AdminTenantScope,
  filters: ListCampaignsFilters = {},
): Promise<MetaCampaignRow[]> {
  const campaigns = await withTenantConfigTx(
    { actorUserId: scope.actorUserId, tenantId: scope.tenantId },
    async (tx) => {
      await assertTenantExists(tx, scope.tenantId);

      const rows = await tx.execute(sql`
        SELECT mc.id,
               mc.tenant_id,
               mc.ad_account_id,
               mc.meta_campaign_id::text AS meta_campaign_id,
               mc.name,
               mc.objective,
               mc.effective_status,
               mc.meta_created_time,
               mc.campaign_type_id,
               ct.name  AS campaign_type_name,
               ct.label AS campaign_type_label,
               mc.mapping_status,
               mc.matched_keyword,
               mc.confirmed_by,
               mc.confirmed_at,
               mc.first_seen_source,
               mc.last_synced_at
        FROM ext.meta_campaigns mc
        LEFT JOIN marketing.campaign_types ct ON ct.id = mc.campaign_type_id
        ${filters.mapping_status ? sql`WHERE mc.mapping_status = ${filters.mapping_status}` : sql``}
        ORDER BY mc.last_synced_at DESC NULLS LAST, mc.created_at DESC
      `);
      return rows as unknown as Array<Omit<MetaCampaignRow, 'lead_count'>>;
    },
  );

  if (campaigns.length === 0) return [];
  const counts = await leadCountsByCampaign(scope.tenantId);
  return campaigns.map((c) => ({ ...c, lead_count: counts.get(c.meta_campaign_id) ?? 0 }));
}

/**
 * Leads received per Meta campaign, across every branch of ONE tenant.
 *
 * withServiceTx (BYPASSRLS), documented: `ext.meta_leads` is org-scoped and the
 * admin transaction pins a tenant, not an org, so under RLS this reads nothing.
 * The tenant fence is therefore explicit — every counted lead must sit in a
 * branch of `tenantId` — and `tenantId` itself was proven real under
 * admin_tenant_config_policy by assertTenantExists in the caller's transaction
 * before this runs. Only aggregate counts leave this function; no lead row does.
 *
 * Grouped per tenant rather than per campaign id list: one indexed pass over the
 * tenant's leads, and a campaign id seen only in another tenant can never be
 * counted here because the branch join excludes it.
 */
async function leadCountsByCampaign(tenantId: string): Promise<Map<string, number>> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ml.campaign_id::text AS meta_campaign_id, COUNT(*)::int AS lead_count
      FROM ext.meta_leads ml
      JOIN entity.organizations o ON o.id = ml.org_id
      WHERE o.tenant_id = ${tenantId}::uuid
        AND ml.campaign_id IS NOT NULL
      GROUP BY ml.campaign_id
    `)) as unknown as Array<{ meta_campaign_id: string; lead_count: number }>;
    return new Map(rows.map((r) => [r.meta_campaign_id, Number(r.lead_count)]));
  });
}

export interface ConfirmCampaignInput {
  campaign_type_id: string;
  /**
   * Teach the type a keyword taken from THIS campaign's name, so the next
   * similarly-named campaign auto-matches instead of landing unmapped again.
   */
  learn_keyword?: boolean | undefined;
  dry_run: boolean;
}

export interface ConfirmCampaignResult {
  dry_run: boolean;
  meta_campaign_id: string;
  campaign_type_id: string;
  /** The token added to match_keywords, or null when nothing was learned. */
  learned_keyword: string | null;
  /** True once the confirmed mapping is committed — always false on a dry run. */
  mapping_saved: boolean;
  /**
   * What the fan-out did — or, on a dry run, what it WOULD do. Null only when a
   * REAL confirm saved the mapping but the fan-out then failed; see
   * reclassification_error.
   */
  reclassification: ReclassifyResult | null;
  /**
   * Set when the mapping was saved but re-routing its existing leads failed.
   * New leads already route by the corrected type; the existing ones keep their
   * old label and owner until Confirm is pressed again, which is safe to repeat.
   */
  reclassification_error: string | null;
}

/**
 * The longest token in a campaign name that is not already a keyword anywhere in
 * the tenant, lower-cased.
 *
 * 'HIR_Gurugram_Trainer_Sep26' splits on the separators Meta names actually use
 * and yields 'gurugram' — which is the WRONG keyword for a hiring campaign and
 * is exactly why this returns a CANDIDATE for the admin to accept rather than
 * learning silently on every confirm. `learn_keyword` is opt-in per request for
 * that reason.
 *
 * Tokens shorter than four characters are skipped: a two-letter fragment matches
 * far too much, and `marketing.fn_match_campaign_type` matches on word
 * boundaries, not prefixes, so a short token is all risk and no reach.
 */
function keywordCandidate(name: string | null, existing: string[]): string | null {
  if (!name) return null;
  const taken = new Set(existing.map((k) => k.toLowerCase()));
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !taken.has(t));
  if (tokens.length === 0) return null;
  return tokens.reduce((longest, t) => (t.length > longest.length ? t : longest));
}

interface CampaignRowForConfirm {
  meta_campaign_id: string;
  name: string | null;
  mapping_status: MappingStatus;
}

async function loadCampaignForConfirm(
  tx: DrizzleTx,
  metaCampaignId: string,
): Promise<CampaignRowForConfirm> {
  const rows = (await tx.execute(sql`
    SELECT meta_campaign_id::text AS meta_campaign_id, name, mapping_status
    FROM ext.meta_campaigns
    WHERE meta_campaign_id = ${metaCampaignId}::bigint
    LIMIT 1
  `)) as unknown as CampaignRowForConfirm[];

  // A row belonging to ANOTHER tenant is filtered out by
  // admin_tenant_config_policy and reaches here as "not found" — which is the
  // right answer. Distinguishing the two would confirm the existence of another
  // tenant's campaign.
  const row = rows[0];
  if (!row) throw new NotFoundError('Campaign not found for this tenant');
  return row;
}

/** The type must be real, live, and this tenant's — the policy fences the row, not the FK. */
async function assertTypeUsable(tx: DrizzleTx, campaignTypeId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT id FROM marketing.campaign_types
    WHERE id = ${campaignTypeId}::uuid AND is_active AND NOT is_deleted
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new BadRequestError('Unknown campaign type for this tenant');
}

/**
 * Confirm or correct a campaign's type, then re-route the leads it already has.
 *
 * `dry_run` RETURNS THE PREVIEW AND WRITES NOTHING — not the mapping, not the
 * keyword, not the reclassification. An admin checking what a correction would
 * cost must be able to walk away having changed nothing at all; a preview that
 * quietly commits the mapping and skips only the fan-out is the version of this
 * feature that loses people's trust.
 *
 * The order of the two writes is deliberate. The mapping is written FIRST, in
 * its own committed transaction, and only then is leads-service asked to fan
 * out. If the fan-out fails, the mapping still stands and re-pressing Confirm
 * retries it — whereas fanning out first would leave leads relabelled against a
 * mapping that was never saved.
 */
export async function confirmCampaignMapping(
  scope: AdminTenantScope,
  metaCampaignId: string,
  input: ConfirmCampaignInput,
): Promise<ConfirmCampaignResult> {
  const prepared = await withTenantConfigTx(
    { actorUserId: scope.actorUserId, tenantId: scope.tenantId },
    async (tx) => {
      await assertTenantExists(tx, scope.tenantId);
      const campaign = await loadCampaignForConfirm(tx, metaCampaignId);
      await assertTypeUsable(tx, input.campaign_type_id);

      let learnedKeyword: string | null = null;
      if (input.learn_keyword) {
        const typeRows = (await tx.execute(sql`
          SELECT COALESCE(
                   (SELECT array_agg(kw)
                      FROM marketing.campaign_types t2, unnest(t2.match_keywords) AS kw
                     WHERE t2.tenant_id = ct.tenant_id),
                   '{}'
                 ) AS tenant_keywords
          FROM marketing.campaign_types ct
          WHERE ct.id = ${input.campaign_type_id}::uuid
          LIMIT 1
        `)) as unknown as Array<{ tenant_keywords: string[] }>;
        learnedKeyword = keywordCandidate(campaign.name, typeRows[0]?.tenant_keywords ?? []);
      }

      if (input.dry_run) return { campaign, learnedKeyword };

      await tx.execute(sql`
        UPDATE ext.meta_campaigns
        SET campaign_type_id = ${input.campaign_type_id}::uuid,
            mapping_status   = 'confirmed',
            confirmed_by     = ${scope.actorUserId}::uuid,
            confirmed_at     = NOW(),
            updated_at       = NOW()
        WHERE meta_campaign_id = ${metaCampaignId}::bigint
      `);

      if (learnedKeyword) {
        // array_append, not a rewrite of the whole array: two admins confirming
        // different campaigns onto the same type at the same time would
        // otherwise each write back the array they read and one keyword would
        // vanish. The NOT-already-present guard keeps it idempotent.
        await tx.execute(sql`
          UPDATE marketing.campaign_types
          SET match_keywords = array_append(match_keywords, ${learnedKeyword}),
              updated_at     = NOW()
          WHERE id = ${input.campaign_type_id}::uuid
            AND NOT (${learnedKeyword} = ANY(match_keywords))
        `);
      }

      return { campaign, learnedKeyword };
    },
  );

  const reclassifyRequest = {
    meta_campaign_id: metaCampaignId,
    campaign_type_id: input.campaign_type_id,
    dry_run: input.dry_run,
    actor_id: scope.actorUserId,
  };
  const base = {
    dry_run: input.dry_run,
    meta_campaign_id: prepared.campaign.meta_campaign_id,
    campaign_type_id: input.campaign_type_id,
    learned_keyword: prepared.learnedKeyword,
  };

  // A preview that cannot be computed is simply an error — nothing was written,
  // so there is nothing to report as half-done.
  if (input.dry_run) {
    return {
      ...base,
      mapping_saved: false,
      reclassification: await reclassifyCampaign(reclassifyRequest),
      reclassification_error: null,
    };
  }

  // On a REAL confirm the mapping is already committed by this point. A fan-out
  // failure used to propagate as a 502, so the screen reported "did not confirm"
  // for a campaign that WAS confirmed and moved into the Confirmed grid — with
  // its existing leads silently left on the old label and owner. The truth is
  // "saved, but re-routing failed", and it is returned as exactly that so the
  // admin knows to press Confirm again (idempotent: the fan-out skips leads
  // already on the target type).
  try {
    return {
      ...base,
      mapping_saved: true,
      reclassification: await reclassifyCampaign(reclassifyRequest),
      reclassification_error: null,
    };
  } catch (err) {
    return {
      ...base,
      mapping_saved: true,
      reclassification: null,
      reclassification_error: err instanceof Error ? err.message : 'Lead re-routing failed',
    };
  }
}
