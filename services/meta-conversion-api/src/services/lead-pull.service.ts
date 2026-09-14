import { sql } from 'drizzle-orm';
import { withTenantConfigTx, type DrizzleTx } from '@platform/db';
import { config } from '../config/index.js';
import { NotFoundError } from '../lib/errors.js';
import { getIntegrationByTenantId } from './integration.service.js';
import {
  getManagedPageTokens,
  listLeadGenForms,
  fetchFormLeadsPage,
  type RawGraphLead,
} from './meta-api.service.js';
import { classifyRunLeads } from './lead-reconcile.service.js';
import type { LeadSyncLogger } from './lead-sync.service.js';

// ── The pull engine: page → forms → leads, staged for review ────────────────
//
// A TypeScript port of meta-sync-scripts/download_page_leads.py, moved off a
// developer's laptop and behind a button. It writes NOTHING to lms.* — every
// lead it finds lands in scratch.meta_pull_leads to be classified and reviewed,
// and only lead-apply.service.ts turns a staged row into a real lead.
//
// WHY PAGE-FIRST rather than iterating the mapped form_ids:
// ext.meta_page_form_org_map's form_id list goes stale the moment someone
// creates a new leadgen form on a Page, so a form_id-driven sync silently stops
// seeing new leads — confirmed live, ext.meta_leads already holds form ids with
// no mapping row at all. This asks each Page what forms it actually has RIGHT
// NOW and pulls from every one of them, mapped or not. A form with no mapping
// is staged with org_id NULL and reported, never guessed into an org: one Page
// here is shared by eight branch orgs, so "the page's org" is not a
// well-defined thing.
//
// TWO META CONSTRAINTS THIS IS DESIGNED WITH, NOT AROUND:
//
//  1. THERE IS NO CAMPAIGN-SCOPED LEAD EDGE. Leads come page →
//     /{page-id}/leadgen_forms → /{form-id}/leads, and campaign_id is only a
//     FIELD on each lead. So the campaign filter is POST-FETCH and narrowing
//     campaigns CANNOT make a pull faster or cheaper. `campaign_filter_applied`
//     is reported on the run so the screen can say so — otherwise the first
//     thing an admin does is select one campaign and read the identical runtime
//     as a bug.
//
//  2. META IGNORES THE `time_created` FILTER. It is sent anyway as an
//     optimisation, and every lead is re-filtered locally by `isInWindow`.

export interface PullFilters {
  /** Empty = every org in the tenant. */
  org_ids: string[];
  /** Empty = every page mapped to those orgs. Applied SERVER-SIDE. */
  page_ids: string[];
  /** Empty = every campaign. Applied POST-FETCH — see constraint 1 above. */
  campaign_ids: string[];
  /** Required. ISO-8601. */
  since: string;
  /** Optional upper bound; null = now. */
  until: string | null;
}

export interface PullRunRow {
  id: string;
  tenant_id: string;
  created_by: string;
  filters: PullFilters;
}

export interface PullPageError {
  page_id: string;
  reason: string;
}

export interface PullCounts {
  pages_in_scope: number;
  pages_walked: number;
  forms_walked: number;
  /** Leads Meta returned, before the local window/campaign filters. */
  leads_returned: number;
  /** Leads that survived both filters and were staged. */
  leads_staged: number;
  /**
   * Leads on a form mapped to a branch OUTSIDE the selected org_ids — dropped,
   * not staged. A page is often shared by several branches; before this count
   * existed those leads were staged with no org and misreported as
   * `unmapped_form`, sending the admin to "fix" a mapping that was fine.
   */
  out_of_scope: number;
  /** Forms whose walk hit the max_pages cap — older leads were NOT fetched. */
  truncated_forms: string[];
  /** True when ANY form truncated. The screen must surface this loudly. */
  truncated: boolean;
  /** Pages that could not be reached at all, with the reason. */
  page_errors: PullPageError[];
  /**
   * Honesty about constraint 1: the campaign filter narrowed the RESULT, never
   * the work. The UI says so; without it a slow single-campaign pull reads as
   * a bug.
   */
  campaign_filter_applied: boolean;
  /** Per-verdict tallies, filled in by the reconcile pass. */
  verdicts: Record<string, number>;
}

export interface PullOptions {
  log?: LeadSyncLogger | undefined;
  /** Called after each page completes, so the poller can write heartbeat_at. */
  onPageComplete?: (() => Promise<void>) | undefined;
}

// ── Date handling (port of graph_api.py's parse_created_time / in_window) ────

/**
 * Meta's Lead object returns `created_time` as an ISO-8601 string
 * ("2026-07-11T18:07:55+0000"), NOT a Unix timestamp — confirmed against a live
 * Graph response.
 *
 * The offset is written WITHOUT a colon, which is not what `Date` is specified
 * to parse; engines accept it by falling back to implementation-defined
 * parsing, which is not something to rely on for the column that decides
 * whether a lead is in the requested window. The colon is inserted first.
 */
export function parseMetaCreatedTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The client-side date filter that constraint 2 makes mandatory.
 *
 * A lead whose created_time cannot be parsed is KEPT, exactly as
 * graph_api.py::in_window does. Dropping a real lead over a format surprise is
 * worse than letting one through — the reconcile pass and the apply path's own
 * dedup both still see it, so the cost of a false keep is one extra row in a
 * review grid, while the cost of a false drop is a customer nobody calls.
 */
export function isInWindow(createdTime: string | undefined, since: Date, until: Date | null): boolean {
  const parsed = parseMetaCreatedTime(createdTime);
  if (parsed === null) return true;
  if (parsed < since) return false;
  if (until && parsed >= until) return false;
  return true;
}

function isBeforeCutoff(createdTime: string | undefined, since: Date): boolean {
  const parsed = parseMetaCreatedTime(createdTime);
  return parsed !== null && parsed < since;
}

// ── Scope resolution ────────────────────────────────────────────────────────

interface MappingRow {
  org_id: string;
  page_id: string;
  form_id: string | null;
  platform: 'fb' | 'ig' | 'wa';
}

/**
 * The tenant's active page→branch routing, narrowed by the requested pages only.
 *
 * NOT narrowed by org_ids, deliberately. A page is routinely shared by several
 * branches (form-level rows split it), and resolveMapping needs EVERY row for a
 * page to tell "this form belongs to another branch" from "this form is mapped
 * to nobody". Narrowing here made the first look like the second: leads for an
 * unselected branch were staged with no org and reported as unmapped_form.
 * runPull applies the org selection to the RESOLVED mapping instead.
 *
 * Read under `withTenantConfigTx`, so `ext.meta_page_form_org_map`'s
 * admin_tenant_config_policy is what fences these rows to the administered
 * tenant — there is deliberately no `WHERE tenant_id = $1` here. A literal
 * filter alongside the policy would make the cross-tenant acceptance test pass
 * whether or not the policy is doing its job, which is the failure this whole
 * shape exists to remove.
 *
 * The org/page narrowing IS applied as a WHERE, because those are the
 * OPERATOR'S selection — a product filter, not a security boundary.
 */
async function loadMappings(
  tx: DrizzleTx,
  filters: PullFilters,
): Promise<MappingRow[]> {
  // Built by hand for bigint, which has no sqlXxxArr helper. Each id is a
  // separate bind, so nothing is concatenated into SQL.
  const pageFilter = filters.page_ids.length
    ? sql`AND page_id = ANY(ARRAY[${sql.join(filters.page_ids.map((p) => sql`${p}::bigint`), sql`, `)}])`
    : sql``;

  const rows = await tx.execute(sql`
    SELECT org_id, page_id::text AS page_id, form_id::text AS form_id, platform
    FROM ext.meta_page_form_org_map
    WHERE is_active = true
    ${pageFilter}
  `);
  return rows as unknown as MappingRow[];
}

/**
 * Exact form row wins, the page-level catch-all (form_id IS NULL) is the
 * fallback, and anything else is UNMAPPED.
 *
 * Identical precedence to page-org-map.service.ts::resolveOrgId and to the
 * Python's mappings.py::resolve. The three must agree: routing a lead by one
 * rule here and another on the webhook path would send the same lead to
 * different branches depending on which door it came through.
 */
function resolveMapping(
  mappings: MappingRow[],
  pageId: string,
  formId: string,
): MappingRow | null {
  const exact = mappings.find((m) => m.form_id === formId);
  if (exact) return exact;
  return mappings.find((m) => m.page_id === pageId && m.form_id === null) ?? null;
}

// ── Staging ─────────────────────────────────────────────────────────────────

interface StagedLead {
  orgId: string | null;
  pageId: string;
  formId: string;
  formName: string | null;
  metaLeadId: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  platform: string | null;
  leadCreatedAt: string | null;
  fieldData: unknown;
}

/** Meta ids are up to 17 digits — past Number.MAX_SAFE_INTEGER — so they stay strings. */
function digitsOrNull(value: string | undefined | null): string | null {
  if (value == null || value === '') return null;
  return /^\d+$/.test(value) ? value : null;
}

async function stageLeads(tx: DrizzleTx, runId: string, tenantId: string, leads: StagedLead[]): Promise<number> {
  if (leads.length === 0) return 0;

  const values = leads.map(
    (l) => sql`(
      ${runId}::uuid, ${tenantId}::uuid, ${l.orgId}::uuid,
      ${l.pageId}::bigint, ${l.formId}::bigint, ${l.formName},
      ${l.metaLeadId}::bigint, ${l.campaignId}::bigint, ${l.adsetId}::bigint, ${l.adId}::bigint,
      ${l.platform}, ${l.leadCreatedAt}::timestamptz, ${JSON.stringify(l.fieldData ?? [])}::jsonb
    )`,
  );

  // ON CONFLICT DO NOTHING against uq_meta_pull_leads_run_lead: Meta pages the
  // same lead across cursor pages more often than its docs admit, and a
  // duplicate must not abort a page's whole insert.
  const rows = await tx.execute(sql`
    INSERT INTO scratch.meta_pull_leads (
      run_id, tenant_id, org_id, page_id, form_id, form_name,
      meta_lead_id, campaign_id, adset_id, ad_id, platform, lead_created_at, raw_field_data
    )
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (run_id, meta_lead_id) DO NOTHING
    RETURNING id
  `);
  return (rows as unknown as Array<{ id: string }>).length;
}

// ── The walk ────────────────────────────────────────────────────────────────

interface FormLeadsResult {
  leads: RawGraphLead[];
  /** True when the max_pages cap stopped the walk before pagination ended. */
  truncated: boolean;
  /** Every lead Meta returned, before the local window filter. */
  returned: number;
}

/**
 * Every lead on one form inside the window, paginated.
 *
 * Meta returns this edge NEWEST-FIRST, so once a WHOLE page lands before
 * `since` there is nothing newer further back and the walk stops — that early
 * stop is what keeps a bounded pull from crawling years of history. A PARTIALLY
 * old page is not enough to stop on, because the boundary page straddles the
 * cutoff.
 */
async function fetchFormLeads(
  formId: string,
  pageAccessToken: string,
  graphApiVersion: string,
  since: Date,
  until: Date | null,
  options: PullOptions,
): Promise<FormLeadsResult> {
  const maxPages = config.leadPullMaxGraphPagesPerForm;
  const collected: RawGraphLead[] = [];
  let after: string | undefined;
  let returned = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchFormLeadsPage(
      formId,
      pageAccessToken,
      graphApiVersion,
      { ...(after ? { after } : {}), since, ...(until ? { until } : {}), limit: 100 },
      {
        onBackoff: (info) => {
          options.log?.warn(
            { evt: 'lead_pull.graph_backoff', formId, attempt: info.attempt, delayMs: info.delay_ms, reason: info.reason },
            'Backing off a Meta Graph call',
          );
        },
      },
    );

    returned += result.leads.length;
    if (result.leads.length === 0) return { leads: collected, truncated: false, returned };

    const kept = result.leads.filter((lead) => isInWindow(lead.created_time, since, until));
    collected.push(...kept);

    // Whole page older than the cutoff → nothing newer remains behind it.
    if (kept.length === 0 && result.leads.every((lead) => isBeforeCutoff(lead.created_time, since))) {
      return { leads: collected, truncated: false, returned };
    }

    if (!result.nextCursor) return { leads: collected, truncated: false, returned };
    after = result.nextCursor;
  }

  // Cap reached with pagination still going. LOUD, not silent: the admin has an
  // incomplete answer and the only way to know is to be told.
  return { leads: collected, truncated: true, returned };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

/**
 * Runs one pull. Called by the poller, never from a request.
 *
 * `run.tenant_id` is the tenant the operator SELECTED, taken from the run row
 * the API wrote — never a caller's own session tenant, since platform staff
 * administer a tenant other than their own.
 */
export async function runPull(run: PullRunRow, options: PullOptions = {}): Promise<PullCounts> {
  const filters = run.filters;
  const since = new Date(filters.since);
  const until = filters.until ? new Date(filters.until) : null;
  const campaignFilter = new Set(filters.campaign_ids);

  const scope = { actorUserId: run.created_by, tenantId: run.tenant_id };

  const mappings = await withTenantConfigTx(scope, (tx) => loadMappings(tx, filters));

  const counts: PullCounts = {
    pages_in_scope: 0,
    pages_walked: 0,
    forms_walked: 0,
    leads_returned: 0,
    leads_staged: 0,
    out_of_scope: 0,
    truncated_forms: [],
    truncated: false,
    page_errors: [],
    campaign_filter_applied: campaignFilter.size > 0,
    verdicts: {},
  };

  // Pages come from the mapping table, narrowed by ?page_ids=. An explicitly
  // requested page with no mapping row at all still has nothing to pull FROM
  // in this model — its forms would all be unmapped — but it is walked anyway
  // so those unmapped forms become visible, which is the point of the screen.
  //
  // Without explicit pages, the pages walked are those mapped to the SELECTED
  // orgs (all orgs when none selected) — mappings is no longer org-narrowed, so
  // the selection is applied here.
  const selectedOrgs = new Set(filters.org_ids);
  const pageIds = filters.page_ids.length
    ? [...new Set(filters.page_ids)]
    : [...new Set(
      mappings
        .filter((m) => selectedOrgs.size === 0 || selectedOrgs.has(m.org_id))
        .map((m) => m.page_id),
    )];
  counts.pages_in_scope = pageIds.length;

  if (pageIds.length === 0) return counts;

  const integration = await getIntegrationByTenantId(run.tenant_id);
  if (!integration || !integration.is_active) {
    throw new NotFoundError('No active Meta integration configured for this tenant');
  }

  // MANDATORY, not an optimisation: /leadgen_forms and /{form-id}/leads accept
  // a PAGE token only, and the tenant-level token stored on
  // ext.meta_tenant_config is a User/System-User token that both edges reject
  // with Meta error #190.
  const pageTokens = await getManagedPageTokens(
    integration.access_token,
    integration.graph_api_version,
    {
      onBackoff: (info) => {
        options.log?.warn(
          { evt: 'lead_pull.graph_backoff', edge: 'me/accounts', attempt: info.attempt, delayMs: info.delay_ms, reason: info.reason },
          'Backing off a Meta Graph call',
        );
      },
    },
  );

  for (const pageId of pageIds) {
    const pageToken = pageTokens.get(pageId);
    if (!pageToken) {
      // Counted and REPORTED WITH THE REASON, never swallowed — same as
      // download_page_leads.py:242-249. An admin can only act on this if they
      // can see it.
      counts.page_errors.push({
        page_id: pageId,
        reason:
          'Not among any active token\'s managed Pages (/me/accounts). The Page may have moved to '
          + 'another Business or ad account, or the token lost access to it.',
      });
      continue;
    }

    let forms;
    try {
      forms = await listLeadGenForms(pageId, pageToken, integration.graph_api_version, {
        onBackoff: (info) => {
          options.log?.warn(
            { evt: 'lead_pull.graph_backoff', pageId, attempt: info.attempt, delayMs: info.delay_ms, reason: info.reason },
            'Backing off a Meta Graph call',
          );
        },
      });
    } catch (err) {
      counts.page_errors.push({ page_id: pageId, reason: `Could not list leadgen forms: ${errorMessage(err)}` });
      continue;
    }

    counts.pages_walked += 1;

    for (const form of forms) {
      counts.forms_walked += 1;

      let fetched: FormLeadsResult;
      try {
        fetched = await fetchFormLeads(form.form_id, pageToken, integration.graph_api_version, since, until, options);
      } catch (err) {
        // One dead form must not abort the page. Recorded against the page,
        // since that is the unit an admin can act on.
        counts.page_errors.push({
          page_id: pageId,
          reason: `Form ${form.form_id}${form.name ? ` (${form.name})` : ''}: ${errorMessage(err)}`,
        });
        continue;
      }

      counts.leads_returned += fetched.returned;
      if (fetched.truncated) {
        counts.truncated = true;
        counts.truncated_forms.push(form.form_id);
        options.log?.warn(
          { evt: 'lead_pull.truncated', pageId, formId: form.form_id, maxPages: config.leadPullMaxGraphPagesPerForm },
          'Hit the per-form Graph page cap before pagination ended; older leads in this form were NOT pulled',
        );
      }

      const mapping = resolveMapping(mappings, pageId, form.form_id);

      // Mapped, but to a branch the operator did not select: not this pull's
      // business. Counted (after the window/campaign filters, so the number is
      // comparable to leads_staged) and dropped. A form mapped to NOBODY still
      // stages, as unmapped_form — that one the admin needs to see whatever
      // they selected.
      const outOfScope = mapping !== null && selectedOrgs.size > 0 && !selectedOrgs.has(mapping.org_id);

      const staged: StagedLead[] = [];
      for (const lead of fetched.leads) {
        const metaLeadId = digitsOrNull(lead.id);
        // A non-numeric lead id cannot be staged: meta_lead_id is BIGINT and it
        // is also the dedup key syncLeadToDatabase would throw on. Nothing is
        // lost by skipping it here, because it could never be applied.
        if (!metaLeadId) continue;

        const campaignId = digitsOrNull(lead.campaign_id);
        // POST-FETCH, and it cannot make the pull cheaper — see constraint 1.
        // A lead with no campaign id cannot match a selected campaign.
        if (campaignFilter.size > 0 && (!campaignId || !campaignFilter.has(campaignId))) continue;

        if (outOfScope) {
          counts.out_of_scope += 1;
          continue;
        }

        const createdAt = parseMetaCreatedTime(lead.created_time);
        staged.push({
          orgId: mapping?.org_id ?? null,
          pageId,
          formId: form.form_id,
          formName: form.name,
          metaLeadId,
          campaignId,
          adsetId: digitsOrNull(lead.adset_id),
          adId: digitsOrNull(lead.ad_id),
          platform:
            lead.platform === 'fb' || lead.platform === 'ig' || lead.platform === 'wa'
              ? lead.platform
              : mapping?.platform ?? null,
          leadCreatedAt: createdAt ? createdAt.toISOString() : null,
          fieldData: lead.field_data ?? [],
        });
      }

      if (staged.length > 0) {
        // One transaction per FORM. A form-sized batch is small enough that a
        // failure costs little and large enough that a page with forty forms is
        // not forty thousand round trips.
        const inserted = await withTenantConfigTx(scope, (tx) =>
          stageLeads(tx, run.id, run.tenant_id, staged),
        );
        counts.leads_staged += inserted;
      }
    }

    // Per page, not per form: this is what the reaper reads, and a page is the
    // largest unit of work that can be slow for a legitimate reason.
    await options.onPageComplete?.();
  }

  counts.verdicts = await classifyRunLeads(run);

  return counts;
}
