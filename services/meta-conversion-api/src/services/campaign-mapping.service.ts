import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';
import { pgError } from '../lib/errors.js';

// ── Campaign -> TYPE resolution on the LIVE lead path ───────────────────────
//
// A tenant runs several kinds of Meta campaign — sales, hiring, more to come —
// and a hiring lead must reach the branch's HR pool rather than the sales
// rotation. `ext.meta_campaigns` is the single source of truth for which type a
// Meta campaign carries, and this module is what puts a row there the first time
// a campaign is ever seen, whether that is from an inbound lead (here) or from
// the Fetch button (campaign-sync.service.ts).
//
// TWO RULES GOVERN EVERYTHING BELOW.
//
//   1. ROUTING NEVER WAITS FOR A HUMAN. A `suggested` mapping routes exactly
//      like a `confirmed` one. The admin grid exists so a wrong guess can be
//      corrected, not so a lead can be held hostage until someone logs in.
//
//   2. A GRAPH FAILURE NEVER FAILS A LEAD. Every entry point here is
//      best-effort: on any error the caller is handed nulls and the lead is
//      created untyped-but-routable. A real customer lead dropped because a
//      metadata lookup was rate-limited is strictly worse than a temporarily
//      mistyped one.

export type MappingStatus = 'unmapped' | 'suggested' | 'confirmed';

/**
 * WHICH keyword fired, for the admin grid.
 *
 * `marketing.fn_match_campaign_type` decides WHICH TYPE and is the only
 * authority on that — it lives in SQL precisely so the TypeScript and Python
 * paths cannot drift on what "a hiring campaign" means. It returns just the type
 * id, though, and the grid needs to show the admin why a guess was made, so the
 * winning type's keywords are re-tested here with the same predicate the
 * function uses (db_scripts/04_functions_triggers.sql).
 *
 * This is a DISPLAY value only. Nothing routes on it, so the duplicated
 * predicate cannot cause a routing divergence — at worst the grid shows no
 * keyword next to a correct type.
 *
 * The predicate requires a non-alphanumeric character or the string end on both
 * sides rather than using Postgres' \m/\M escapes, which treat `_` as a word
 * character: Meta campaign names are overwhelmingly underscore-separated
 * ('HIR_Gurugram_Trainer_Sep26') and \mtrainer\M would never fire on one.
 */
const KEYWORD_ESCAPE_REPLACEMENT = '\\\\\\1';

export function KEYWORD_MATCH_SQL(nameParam: ReturnType<typeof sql>) {
  return sql`(
    SELECT kw
    FROM unnest(ct.match_keywords) AS kw
    WHERE kw <> ''
      AND ${nameParam} ~* ('(^|[^[:alnum:]])'
            || regexp_replace(kw, '([^[:alnum:]])', ${KEYWORD_ESCAPE_REPLACEMENT}, 'g')
            || '([^[:alnum:]]|$)')
    -- LONGEST match first, then alphabetical. Several keywords on one type
    -- routinely fire on the same name ('hr' and 'trainer' both hit
    -- 'HR_Gurugram_Trainer_Sep26'), and a bare LIMIT 1 would return whichever
    -- happens to sit earliest in the match_keywords ARRAY — so the grid's
    -- explanation would change when an admin merely reordered the column. The
    -- longest match is also the more informative of the two to show.
    ORDER BY length(kw) DESC, kw ASC
    LIMIT 1
  )`;
}

/**
 * The type a NAME implies, plus the keyword that said so. Both null when nothing
 * matched — which is a real answer, not a failure.
 */
export async function matchCampaignType(
  tx: DrizzleTx,
  tenantId: string,
  campaignName: string | null,
): Promise<{ campaign_type_id: string | null; matched_keyword: string | null }> {
  if (!campaignName) return { campaign_type_id: null, matched_keyword: null };

  const rows = (await tx.execute(sql`
    SELECT ct.id AS campaign_type_id,
           ${KEYWORD_MATCH_SQL(sql`${campaignName}`)} AS matched_keyword
    FROM marketing.campaign_types ct
    WHERE ct.id = marketing.fn_match_campaign_type(${tenantId}::uuid, ${campaignName})
    LIMIT 1
  `)) as unknown as Array<{ campaign_type_id: string; matched_keyword: string | null }>;

  const row = rows[0];
  return {
    campaign_type_id: row?.campaign_type_id ?? null,
    matched_keyword: row?.matched_keyword ?? null,
  };
}

/**
 * The form-level fallback: `ext.meta_page_form_org_map.default_campaign_type_id`.
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
async function tenantDefaultType(tx: DrizzleTx, tenantId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT id FROM marketing.campaign_types
    WHERE tenant_id = ${tenantId}::uuid AND is_default AND is_active AND NOT is_deleted
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export interface ResolveCampaignTypeInput {
  /** Meta's own campaign id, as a STRING — these run past Number.MAX_SAFE_INTEGER. */
  metaCampaignId: string;
  /** Null when the Graph lookup failed or was skipped; the row still gets created. */
  metaCampaignName?: string | null | undefined;
  metaCampaignObjective?: string | null | undefined;
  metaCampaignStatus?: string | null | undefined;
  pageId?: string | null | undefined;
  formId?: string | null | undefined;
}

export interface ResolvedCampaignType {
  campaign_type_id: string | null;
  mapping_status: MappingStatus;
  matched_keyword: string | null;
  /**
   * The form default, returned whether or not it was used. leads-service applies
   * its own fallback ladder (caller type -> form default -> tenant default) and
   * cannot read `ext.*` itself, so both ids travel with the lead.
   */
  default_campaign_type_id: string | null;
  /** True when this call is what created the ext.meta_campaigns row. */
  created: boolean;
  /**
   * Set when the campaign's mapped type has been deactivated or deleted and the
   * lead was typed from the fallback ladder instead. The caller logs it: the
   * mapping row now points at a retired pool and needs an admin.
   */
  inactive_mapped_type_id?: string | null;
}

/**
 * The campaign's type, creating the mapping row when the campaign is new.
 *
 * HIT — the row already exists: return its type, `confirmed` or `suggested`
 * alike. No Graph call, no re-match. The row IS the cache.
 *
 * MISS — insert it, typed by `marketing.fn_match_campaign_type`:
 *   * a keyword matched  -> `suggested`, with `matched_keyword` recording which;
 *   * nothing matched    -> `unmapped`, typed from the form default and then the
 *     tenant default, so the lead still routes somewhere sane while the row sits
 *     in the admin's "needs mapping" grid.
 *
 * Runs inside the CALLER's transaction. On the webhook path that is a
 * `withServiceTx` (BYPASSRLS): an inbound Meta delivery carries no session at
 * all, the same documented system operation the two resolvers in
 * page-org-map.service.ts run under. Because RLS is therefore NOT the fence
 * here, every statement above filters `tenant_id` explicitly.
 */
export async function resolveCampaignType(
  tx: DrizzleTx,
  tenantId: string,
  input: ResolveCampaignTypeInput,
): Promise<ResolvedCampaignType> {
  const formDefault = await resolveFormDefaultType(
    tx,
    tenantId,
    input.pageId ?? null,
    input.formId ?? null,
  );

  // uq_meta_campaigns_campaign_id is GLOBAL, not per-tenant (Meta ids are
  // globally unique and one row serves every branch), so this lookup does not
  // filter by tenant — it asks for THE row for this campaign. The tenant of the
  // row it finds is then checked below, because a row owned by another tenant
  // must not type this tenant's lead.
  // The mapped type's liveness travels with the row. A type an admin has since
  // deactivated or deleted must NOT be handed to leads-service, which refuses it
  // with a 400 — and an intake failure is a lost lead. Such a row falls through
  // to the fallback ladder below exactly as an untyped one does.
  const existing = (await tx.execute(sql`
    SELECT mc.tenant_id,
           mc.name,
           mc.campaign_type_id,
           (ct.id IS NOT NULL AND ct.is_active AND NOT ct.is_deleted) AS type_is_live,
           mc.mapping_status,
           mc.matched_keyword
    FROM ext.meta_campaigns mc
    LEFT JOIN marketing.campaign_types ct ON ct.id = mc.campaign_type_id
    WHERE mc.meta_campaign_id = ${input.metaCampaignId}::bigint
    LIMIT 1
  `)) as unknown as Array<{
    tenant_id: string;
    name: string | null;
    campaign_type_id: string | null;
    type_is_live: boolean;
    mapping_status: MappingStatus;
    matched_keyword: string | null;
  }>;

  const hit = existing[0];
  if (hit) {
    if (hit.tenant_id !== tenantId) {
      // A shared ad account reaching two tenants. The row belongs to the other
      // one and must not be read as this tenant's mapping (nor overwritten).
      // The lead still routes, on the defaults.
      return {
        campaign_type_id: formDefault ?? (await tenantDefaultType(tx, tenantId)),
        mapping_status: 'unmapped',
        matched_keyword: null,
        default_campaign_type_id: formDefault,
        created: false,
      };
    }
    // A row created without a name (a failed lookup on its first lead, or the
    // back-catalogue seed) gets it now that one is known. Metadata ONLY: the
    // mapping columns are not touched, so this can never re-type a campaign or
    // disturb a confirmed one. `name IS NULL` makes concurrent leads harmless.
    const knownName = input.metaCampaignName?.trim() || null;
    if (hit.name === null && knownName) {
      await tx.execute(sql`
        UPDATE ext.meta_campaigns
        SET name             = ${knownName},
            objective        = COALESCE(objective, ${input.metaCampaignObjective ?? null}),
            effective_status = COALESCE(effective_status, ${input.metaCampaignStatus ?? null}),
            last_synced_at   = NOW(),
            updated_at       = NOW()
        WHERE meta_campaign_id = ${input.metaCampaignId}::bigint
          AND name IS NULL
      `);
    }

    // Rule 1: a `suggested` type routes exactly like a `confirmed` one.
    if (hit.campaign_type_id && hit.type_is_live) {
      return {
        campaign_type_id: hit.campaign_type_id,
        mapping_status: hit.mapping_status,
        matched_keyword: hit.matched_keyword,
        default_campaign_type_id: formDefault,
        created: false,
      };
    }
    // Untyped (a back-catalogue row seeded with no type) or typed with a retired
    // pool: route on the same ladder as an unmatched new campaign. The mapping
    // row itself is left alone — correcting it is the admin's call, not the
    // webhook's.
    return {
      campaign_type_id: formDefault ?? (await tenantDefaultType(tx, tenantId)),
      mapping_status: hit.mapping_status,
      matched_keyword: null,
      default_campaign_type_id: formDefault,
      created: false,
      inactive_mapped_type_id: hit.campaign_type_id,
    };
  }

  const name = input.metaCampaignName?.trim() || null;
  const matched = await matchCampaignType(tx, tenantId, name);
  const status: MappingStatus = matched.campaign_type_id ? 'suggested' : 'unmapped';
  const fallback = matched.campaign_type_id
    ? null
    : (formDefault ?? (await tenantDefaultType(tx, tenantId)));
  const campaignTypeId = matched.campaign_type_id ?? fallback;

  // ON CONFLICT DO NOTHING, then re-select. Two webhook deliveries for the same
  // brand-new campaign arrive concurrently often enough that the race is
  // routine, and a bare INSERT would turn the loser into a 23505 that fails an
  // otherwise perfectly good lead. The loser still needs the winner's answer,
  // which DO NOTHING does not return — hence the re-select rather than
  // RETURNING. Same shape as leads-service's ensureBranchCampaign.
  try {
    await tx.execute(sql`
      INSERT INTO ext.meta_campaigns (
        tenant_id, meta_campaign_id, name, objective, effective_status,
        campaign_type_id, mapping_status, matched_keyword, first_seen_source, last_synced_at
      ) VALUES (
        ${tenantId}::uuid, ${input.metaCampaignId}::bigint, ${name},
        ${input.metaCampaignObjective ?? null}, ${input.metaCampaignStatus ?? null},
        ${campaignTypeId}::uuid, ${status}, ${matched.matched_keyword},
        'lead', NOW()
      )
      ON CONFLICT (meta_campaign_id) DO NOTHING
    `);
  } catch (err) {
    // 23505 cannot reach here (DO NOTHING absorbs it); 23503 can, if the
    // resolved type was deleted between the match and the insert. Either way the
    // lead is not the thing to fail.
    if (pgError(err).code === undefined) throw err;
    return {
      campaign_type_id: campaignTypeId,
      mapping_status: status,
      matched_keyword: matched.matched_keyword,
      default_campaign_type_id: formDefault,
      created: false,
    };
  }

  const settled = (await tx.execute(sql`
    SELECT tenant_id, campaign_type_id, mapping_status, matched_keyword
    FROM ext.meta_campaigns
    WHERE meta_campaign_id = ${input.metaCampaignId}::bigint
    LIMIT 1
  `)) as unknown as Array<{
    tenant_id: string;
    campaign_type_id: string | null;
    mapping_status: MappingStatus;
    matched_keyword: string | null;
  }>;

  const row = settled[0];
  if (!row || row.tenant_id !== tenantId) {
    return {
      campaign_type_id: campaignTypeId,
      mapping_status: status,
      matched_keyword: matched.matched_keyword,
      default_campaign_type_id: formDefault,
      created: false,
    };
  }

  return {
    campaign_type_id: row.campaign_type_id,
    mapping_status: row.mapping_status,
    matched_keyword: row.matched_keyword,
    default_campaign_type_id: formDefault,
    created: true,
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
