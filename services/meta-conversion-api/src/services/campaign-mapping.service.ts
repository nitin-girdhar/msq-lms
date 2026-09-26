import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';
import { pgError } from '../lib/errors.js';

// ── Campaign -> TYPE resolution on the LIVE lead path ───────────────────────
//
// A tenant runs several kinds of Meta campaign — sales, hiring, more to come —
// and a hiring lead must reach the branch's HR pool rather than the sales
// rotation. This module decides a lead's TYPE, and puts a row in
// `ext.meta_campaigns` the first time a campaign is ever seen.
//
// THE PRECEDENCE (product decision 2026-09-26, schema 1.51.0), per LEAD:
//
//   1. the campaign's CONFIRMED type          (an admin's decision, never guessed)
//   2. the first matching ORDERED RULE        (marketing.campaign_type_rules, on the
//                                              campaign / form / ad set / ad name)
//   3. the page (or form-override) default    (ext.meta_page_form_org_map)
//   4. the tenant's default type
//
// Rules are evaluated PER LEAD because three of the four names they can match
// (form, ad set, ad) belong to the lead, not the campaign. The campaign-name-only
// result is ALSO stored on the campaign row as `suggested_campaign_type_id`, for
// the admin grid — but a suggestion is never read back as the campaign's type.
//
// THREE RULES GOVERN EVERYTHING BELOW.
//
//   1. ROUTING NEVER WAITS FOR A HUMAN. An unconfirmed campaign routes on the
//      rules immediately; the grid exists so a wrong guess can be corrected.
//
//   2. A GUESS NEVER HARDENS. `ext.meta_campaigns.campaign_type_id` is written
//      ONLY by an admin confirm. Before 1.51.0 the first lead of an unmatched
//      campaign stored the fallback (usually Sales) there and every later lead
//      inherited it — a hiring campaign whose name lookup failed stayed Sales.
//
//   3. A GRAPH FAILURE NEVER FAILS A LEAD. Every entry point is best-effort.

export type MappingStatus = 'unmapped' | 'suggested' | 'confirmed';

/** Where a lead's type came from — logged, and surfaced on the lead-pull grid. */
export type TypeSource = 'confirmed' | 'rule' | 'page_default' | 'tenant_default' | 'none';

export type RuleMatchField = 'campaign_name' | 'form_name' | 'adset_name' | 'ad_name';

export interface RuleNames {
  campaignName?: string | null | undefined;
  formName?: string | null | undefined;
  adsetName?: string | null | undefined;
  adName?: string | null | undefined;
}

export interface RuleMatch {
  campaign_type_id: string;
  rule_id: string;
  match_field: RuleMatchField;
  pattern: string;
}

function clean(name: string | null | undefined): string | null {
  const t = name?.trim();
  return t ? t : null;
}

/**
 * The first ordered rule that matches, or null. The matching itself is SQL
 * (`marketing.fn_match_campaign_type_rules`) so every intake path — webhook,
 * lead-pull apply, the campaign fetch — agrees on what a rule means.
 */
export async function matchCampaignRules(
  tx: DrizzleTx,
  tenantId: string,
  names: RuleNames,
): Promise<RuleMatch | null> {
  const rows = (await tx.execute(sql`
    SELECT campaign_type_id, rule_id, match_field, pattern
    FROM marketing.fn_match_campaign_type_rules(
      ${tenantId}::uuid,
      ${clean(names.campaignName)}::text,
      ${clean(names.formName)}::text,
      ${clean(names.adsetName)}::text,
      ${clean(names.adName)}::text
    )
  `)) as unknown as RuleMatch[];
  return rows[0] ?? null;
}

/**
 * Which name fields the tenant has at least one live rule on. The lead path
 * asks this BEFORE spending a Graph call on an ad set or ad name: a tenant with
 * no ad-name rules must not pay a Graph call per new ad to learn a name nothing
 * will read.
 */
export async function activeRuleFields(tx: DrizzleTx, tenantId: string): Promise<Set<RuleMatchField>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT r.match_field
    FROM marketing.campaign_type_rules r
    JOIN marketing.campaign_types ct ON ct.id = r.campaign_type_id AND ct.is_active AND NOT ct.is_deleted
    WHERE r.tenant_id = ${tenantId}::uuid AND r.is_active AND NOT r.is_deleted
  `)) as unknown as Array<{ match_field: RuleMatchField }>;
  return new Set(rows.map((r) => r.match_field));
}

/**
 * The page/form fallback: `ext.meta_page_form_org_map.default_campaign_type_id`.
 *
 * Precedence mirrors page-org-map.service.ts::resolveOrgId exactly — the exact
 * form row wins, the page-level catch-all (form_id IS NULL) is the fallback.
 * The two must agree: routing a lead to a branch by one rule and typing it by
 * another would be its own class of bug.
 */
export async function resolveFormDefaultType(
  tx: DrizzleTx,
  tenantId: string,
  pageId: string | null,
  formId: string | null,
): Promise<string | null> {
  if (!pageId && !formId) return null;

  // A default pointing at a deactivated or deleted type is treated as no default.
  // leads-service refuses an inactive type outright, so forwarding one would turn
  // an admin retiring a pool into every lead on that form failing intake.
  const rows = (await tx.execute(sql`
    SELECT m.default_campaign_type_id
    FROM ext.meta_page_form_org_map m
    JOIN marketing.campaign_types ct
      ON ct.id = m.default_campaign_type_id AND ct.is_active AND NOT ct.is_deleted
    WHERE m.tenant_id = ${tenantId}::uuid
      AND m.is_active = true
      AND (
        (${formId}::text IS NOT NULL AND m.form_id = ${formId}::bigint)
        OR (m.form_id IS NULL AND ${pageId}::text IS NOT NULL AND m.page_id = ${pageId}::bigint)
      )
    ORDER BY (m.form_id IS NULL) ASC, m.created_at DESC
    LIMIT 1
  `)) as unknown as Array<{ default_campaign_type_id: string | null }>;

  return rows[0]?.default_campaign_type_id ?? null;
}

/** The tenant's catch-all pool. At most one per tenant (uix_campaign_types_one_default). */
export async function tenantDefaultType(tx: DrizzleTx, tenantId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT id FROM marketing.campaign_types
    WHERE tenant_id = ${tenantId}::uuid AND is_default AND is_active AND NOT is_deleted
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export interface ResolveCampaignTypeInput {
  /** Meta's own campaign id, as a STRING — these run past Number.MAX_SAFE_INTEGER. Null for an organic lead. */
  metaCampaignId?: string | null | undefined;
  /** Null when the Graph lookup failed or was skipped; the row still gets created. */
  metaCampaignName?: string | null | undefined;
  metaCampaignObjective?: string | null | undefined;
  metaCampaignStatus?: string | null | undefined;
  pageId?: string | null | undefined;
  formId?: string | null | undefined;
  /** Per-lead names the ordered rules can match on. */
  formName?: string | null | undefined;
  adsetName?: string | null | undefined;
  adName?: string | null | undefined;
}

export interface ResolvedCampaignType {
  /** The type THIS LEAD gets — the outcome of the full precedence ladder. */
  campaign_type_id: string | null;
  type_source: TypeSource;
  /** The campaign row's status; 'unmapped' for an organic lead with no campaign. */
  mapping_status: MappingStatus;
  /** The rule that decided the type, when type_source = 'rule'. */
  matched_rule: RuleMatch | null;
  /**
   * The page/form default, returned whether or not it was used. leads-service
   * applies its own fallback ladder and cannot read `ext.*` itself, so it travels
   * with the lead.
   */
  default_campaign_type_id: string | null;
  /** True when this call is what created the ext.meta_campaigns row. */
  created: boolean;
  /** The campaign row belongs to ANOTHER tenant — flagged on the row, not used. */
  cross_tenant: boolean;
  /**
   * Set when the campaign's CONFIRMED type has been deactivated or deleted and
   * the lead was typed from the rest of the ladder instead. The caller logs it:
   * the mapping row points at a retired pool and needs an admin.
   */
  inactive_mapped_type_id?: string | null;
}

interface CampaignRow {
  tenant_id: string;
  name: string | null;
  campaign_type_id: string | null;
  type_is_live: boolean;
  mapping_status: MappingStatus;
}

async function readCampaignRow(tx: DrizzleTx, metaCampaignId: string): Promise<CampaignRow | null> {
  // uq_meta_campaigns_campaign_id is GLOBAL (Meta ids are globally unique), so
  // this asks for THE row; its tenant is checked by the caller.
  const rows = (await tx.execute(sql`
    SELECT mc.tenant_id,
           mc.name,
           mc.campaign_type_id,
           (ct.id IS NOT NULL AND ct.is_active AND NOT ct.is_deleted) AS type_is_live,
           mc.mapping_status
    FROM ext.meta_campaigns mc
    LEFT JOIN marketing.campaign_types ct ON ct.id = mc.campaign_type_id
    WHERE mc.meta_campaign_id = ${metaCampaignId}::bigint
    LIMIT 1
  `)) as unknown as CampaignRow[];
  return rows[0] ?? null;
}

/**
 * Re-derive an UNCONFIRMED campaign's suggestion from its name. Called when a
 * name first becomes known, so a campaign created nameless (a failed lookup on
 * its first lead) gets a real suggestion instead of staying 'unmapped' forever.
 * Never touches a confirmed row.
 */
export async function refreshSuggestion(
  tx: DrizzleTx,
  tenantId: string,
  metaCampaignId: string,
  campaignName: string,
): Promise<void> {
  const m = await matchCampaignRules(tx, tenantId, { campaignName });
  await tx.execute(sql`
    UPDATE ext.meta_campaigns
    SET suggested_campaign_type_id = ${m?.campaign_type_id ?? null}::uuid,
        matched_rule_id            = ${m?.rule_id ?? null}::uuid,
        matched_keyword            = ${m?.pattern ?? null},
        mapping_status             = ${m ? 'suggested' : 'unmapped'},
        updated_at                 = NOW()
    WHERE meta_campaign_id = ${metaCampaignId}::bigint
      AND tenant_id = ${tenantId}::uuid
      AND mapping_status <> 'confirmed'
  `);
}

/**
 * The type for ONE lead, creating/refreshing the campaign row on the way.
 *
 * Runs inside the CALLER's transaction. On the webhook and apply paths that is
 * a `withServiceTx` (BYPASSRLS): an inbound Meta delivery carries no session at
 * all. Because RLS is therefore NOT the fence here, every statement filters
 * `tenant_id` explicitly.
 */
export async function resolveCampaignType(
  tx: DrizzleTx,
  tenantId: string,
  input: ResolveCampaignTypeInput,
): Promise<ResolvedCampaignType> {
  const formDefault = await resolveFormDefaultType(tx, tenantId, input.pageId ?? null, input.formId ?? null);
  const campaignId = clean(input.metaCampaignId);
  const knownName = clean(input.metaCampaignName);

  let mappingStatus: MappingStatus = 'unmapped';
  let created = false;
  let crossTenant = false;
  let inactiveMapped: string | null = null;
  let campaignName = knownName;

  if (campaignId) {
    let row = await readCampaignRow(tx, campaignId);

    if (!row) {
      // First sight of this campaign. The row records the SUGGESTION only;
      // campaign_type_id stays NULL until an admin confirms (rule 2).
      const suggestion = knownName ? await matchCampaignRules(tx, tenantId, { campaignName: knownName }) : null;
      let inserted = false;
      try {
        // ON CONFLICT DO NOTHING then re-read: two deliveries for a brand-new
        // campaign race routinely, and the loser still needs the winner's row.
        const ins = (await tx.execute(sql`
          INSERT INTO ext.meta_campaigns (
            tenant_id, meta_campaign_id, name, objective, effective_status,
            campaign_type_id, suggested_campaign_type_id, matched_rule_id, matched_keyword,
            mapping_status, first_seen_source, last_synced_at
          ) VALUES (
            ${tenantId}::uuid, ${campaignId}::bigint, ${knownName},
            ${input.metaCampaignObjective ?? null}, ${input.metaCampaignStatus ?? null},
            NULL, ${suggestion?.campaign_type_id ?? null}::uuid, ${suggestion?.rule_id ?? null}::uuid,
            ${suggestion?.pattern ?? null},
            ${suggestion ? 'suggested' : 'unmapped'}, 'lead', NOW()
          )
          ON CONFLICT (meta_campaign_id) DO NOTHING
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        inserted = ins.length > 0;
      } catch (err) {
        // 23503 if the suggested type/rule vanished between the match and the
        // insert. The lead is not the thing to fail.
        if (pgError(err).code === undefined) throw err;
      }
      created = inserted;
      row = await readCampaignRow(tx, campaignId);
    }

    if (row) {
      if (row.tenant_id !== tenantId) {
        // A campaign must never span tenants (product decision 2026-09-26). The
        // row belongs to the other tenant: its type is NOT applied here, and the
        // row is flagged so the admin grid shows the conflict. This lead is still
        // typed from its own rules and defaults below.
        crossTenant = true;
        await tx.execute(sql`
          UPDATE ext.meta_campaigns
          SET conflict_reason = 'Leads for this campaign arrive on pages of more than one tenant.',
              updated_at = NOW()
          WHERE meta_campaign_id = ${campaignId}::bigint AND conflict_reason IS NULL
        `);
      } else {
        mappingStatus = row.mapping_status;
        campaignName = knownName ?? row.name;

        // A row created nameless gets its name now, and — being unconfirmed —
        // a fresh suggestion from it. Metadata only on a confirmed row.
        if (row.name === null && knownName) {
          await tx.execute(sql`
            UPDATE ext.meta_campaigns
            SET name             = ${knownName},
                objective        = COALESCE(objective, ${input.metaCampaignObjective ?? null}),
                effective_status = COALESCE(effective_status, ${input.metaCampaignStatus ?? null}),
                last_synced_at   = NOW(),
                updated_at       = NOW()
            WHERE meta_campaign_id = ${campaignId}::bigint AND name IS NULL
          `);
          if (row.mapping_status !== 'confirmed') {
            await refreshSuggestion(tx, tenantId, campaignId, knownName);
          }
        }

        // Step 1 of the ladder: an admin's confirmed type.
        if (row.mapping_status === 'confirmed' && row.campaign_type_id) {
          if (row.type_is_live) {
            return {
              campaign_type_id: row.campaign_type_id,
              type_source: 'confirmed',
              mapping_status: 'confirmed',
              matched_rule: null,
              default_campaign_type_id: formDefault,
              created,
              cross_tenant: false,
            };
          }
          inactiveMapped = row.campaign_type_id;
        }
      }
    }
  }

  // Step 2: ordered rules, per lead.
  const rule = await matchCampaignRules(tx, tenantId, {
    campaignName,
    formName: input.formName,
    adsetName: input.adsetName,
    adName: input.adName,
  });
  if (rule) {
    return {
      campaign_type_id: rule.campaign_type_id,
      type_source: 'rule',
      mapping_status: mappingStatus,
      matched_rule: rule,
      default_campaign_type_id: formDefault,
      created,
      cross_tenant: crossTenant,
      inactive_mapped_type_id: inactiveMapped,
    };
  }

  // Steps 3 and 4.
  const tenantDefault = formDefault ? null : await tenantDefaultType(tx, tenantId);
  return {
    campaign_type_id: formDefault ?? tenantDefault,
    type_source: formDefault ? 'page_default' : tenantDefault ? 'tenant_default' : 'none',
    mapping_status: mappingStatus,
    matched_rule: null,
    default_campaign_type_id: formDefault,
    created,
    cross_tenant: crossTenant,
    inactive_mapped_type_id: inactiveMapped,
  };
}

// ── Campaign-name cache for the webhook burst ───────────────────────────────
//
// `ext.meta_campaigns` is the real cache: once the row exists no Graph call is
// ever made for that campaign again. The window this LRU closes is the one
// BEFORE the first row commits — a new campaign goes live and twenty leads
// arrive inside a few seconds, every one of them a miss, every one of them
// firing its own `GET /{campaign-id}`. That is precisely how a token gets rate
// limited, and it happens on the busiest path in the service.
//
// In-flight PROMISES are cached, not just resolved values, so concurrent callers
// share one request rather than each starting their own. Bounded and
// insertion-ordered: Map preserves insertion order, so the oldest key is the
// first one `keys().next()` yields.

const CAMPAIGN_NAME_CACHE_MAX = 500;
const CAMPAIGN_NAME_CACHE_TTL_MS = 300_000;
// A lookup that came back empty. fetchCampaign returns null rather than throwing
// on ANY Graph failure (throttling included), so a null is usually transient;
// held only long enough to collapse a burst of leads into one call.
const CAMPAIGN_NAME_NULL_TTL_MS = 60_000;

interface CachedCampaignLookup {
  loadedAt: number;
  ttlMs: number;
  value: Promise<MetaCampaignMetadata | null>;
}

export interface MetaCampaignMetadata {
  name: string | null;
  objective: string | null;
  effective_status: string | null;
}

const campaignNameCache = new Map<string, CachedCampaignLookup>();

/** Test/ops hook — the cache is per-process and otherwise invisible. */
export function clearCampaignNameCache(): void {
  campaignNameCache.clear();
}

/**
 * One Graph lookup per NEW campaign, shared across every concurrent caller.
 *
 * A REJECTED lookup is evicted rather than cached. A resolved `null` is kept for
 * CAMPAIGN_NAME_NULL_TTL_MS only: fetchCampaign turns every Graph failure —
 * throttling included — into null rather than a rejection, so the old "a null is
 * Meta's real answer, keep it five minutes" assumption meant one throttled call
 * left a new campaign nameless for five minutes of leads.
 */
export async function fetchCampaignMetadataCached(
  metaCampaignId: string,
  load: () => Promise<MetaCampaignMetadata | null>,
): Promise<MetaCampaignMetadata | null> {
  const hit = campaignNameCache.get(metaCampaignId);
  if (hit && Date.now() - hit.loadedAt < hit.ttlMs) return hit.value;

  const value = load();
  const entry: CachedCampaignLookup = { loadedAt: Date.now(), ttlMs: CAMPAIGN_NAME_CACHE_TTL_MS, value };
  campaignNameCache.set(metaCampaignId, entry);
  value.then(
    (result) => {
      if (result === null) entry.ttlMs = CAMPAIGN_NAME_NULL_TTL_MS;
    },
    () => campaignNameCache.delete(metaCampaignId),
  );

  while (campaignNameCache.size > CAMPAIGN_NAME_CACHE_MAX) {
    const oldest = campaignNameCache.keys().next();
    if (oldest.done) break;
    campaignNameCache.delete(oldest.value);
  }

  return value;
}

/**
 * True when this campaign has no NAMED `ext.meta_campaigns` row yet — i.e. when
 * the one Graph call for its NAME is warranted.
 *
 * A row that exists without a name counts as unknown: the webhook creates the
 * row even when the name lookup failed (the lead must not wait), and
 * backfill_campaign_types.sql seeds the back-catalogue with no names at all.
 * Treating those as known left them nameless forever; resolveCampaignType fills
 * the name in once a later lookup succeeds, never touching the mapping.
 *
 * Split out so the webhook path can check the cheap thing (a primary-key-ish
 * index lookup) before spending a Graph call, and so the expensive thing happens
 * OUTSIDE the transaction that then writes the row.
 */
export async function campaignIsUnknown(
  tx: DrizzleTx,
  metaCampaignId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 AS hit FROM ext.meta_campaigns
    WHERE meta_campaign_id = ${metaCampaignId}::bigint
      AND name IS NOT NULL
    LIMIT 1
  `)) as unknown as Array<{ hit: number }>;
  return rows.length === 0;
}
