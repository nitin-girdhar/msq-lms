import { sql } from 'drizzle-orm';
import { withTenantConfigTx, withServiceTx, sqlUuidArr, sqlTextArr } from '@platform/db';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { assertTenantExists } from '../lib/admin-tenant.js';
import type { AdminTenantScope } from './page-org-map.admin.service.js';
import type { PullFilters } from './lead-pull.service.js';
import { IMPORTABLE_VERDICTS, classifyRunLeads } from './lead-reconcile.service.js';

// ── The request-side half of the lead-pull feature ──────────────────────────
//
// Everything here is an authenticated platform super_admin acting on ONE
// SELECTED tenant, taken from ?tenant_id= and never from the caller's own
// session — platform staff belong to a different tenant than the one they
// administer, so a silent fallback to ctx.tenant_id would scope every read to
// zero rows and stamp every write with the wrong owner. That precise bug was
// removed from the page-org-map API two phases ago and must not come back.
//
// tenantId is therefore CLIENT-SUPPLIED INPUT and is never the boundary:
//   * the controller gates on RANKS.SUPER_ADMIN before any of this is reached;
//   * assertTenantExists proves the id names a real tenant;
//   * withTenantConfigTx pins app.current_tenant_id and runs as app_user
//     (lms_svc here, a NOINHERIT member named on the policy by the widening
//     block at the foot of 08_rls.sql), under which scratch.meta_pull_*'s
//     admin_tenant_config_policy is what actually fences the rows.

/**
 * Statuses that mean a run is in flight, and therefore that another cannot start.
 * `apply_queued` included: a new Pull deletes the tenant's previous run, and one
 * waiting for the poller to apply it is very much still in use.
 */
const LIVE_STATUSES = ['queued', 'running', 'apply_queued', 'applying'];

export interface CreateRunResult {
  run_id: string;
}

/**
 * Clears the tenant's previous run and enqueues a new one.
 *
 * ORDER IS LOAD-BEARING: the 409 check comes BEFORE the DELETE. A second Pull
 * click while a run is live must not delete that run out from under the worker
 * mid-write, which is exactly what a delete-then-check would do — and the
 * worker would then keep staging leads against a run row that no longer exists.
 *
 * One fast transaction, returning run_id immediately: the pull itself takes
 * minutes and is done by the poller, so nothing here rides on the gateway
 * timeout.
 */
export type TriggerKind = 'manual' | 'scheduled';

export { SYSTEM_ACTOR_ID } from './lead-pull.service.js';

export async function createPullRun(
  scope: AdminTenantScope,
  filters: PullFilters,
  // 1.51.0: a tenant holds at most ONE run of each kind. The admin's run and
  // the scheduled catch-up run live side by side, so the catch-up never deletes
  // a pull someone is reviewing, and a busy catch-up never blocks a person.
  triggerKind: TriggerKind = 'manual',
): Promise<CreateRunResult> {
  return withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);

    // Serialise run creation PER TENANT for the rest of this transaction. The
    // 409 check below is a read, and two Pull presses landing together could
    // both see no live run, both DELETE, and both INSERT — two queued runs for
    // one tenant. A transaction-scoped advisory lock keyed on the tenant makes
    // the second wait for the first to commit, after which its check sees the
    // run the first one queued. Released automatically at commit/rollback.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lead_pull:${scope.tenantId}`}, 0))`);

    // Deliberately no `WHERE tenant_id = …`: admin_tenant_config_policy is the
    // scope on this READ, and a literal filter alongside it would make the
    // cross-tenant acceptance test pass whether or not the policy works.
    const live = (await tx.execute(sql`
      SELECT id, status FROM scratch.meta_pull_runs
      WHERE status = ANY(${sqlTextArr(LIVE_STATUSES)})
        AND trigger_kind = ${triggerKind}
      LIMIT 1
    `)) as unknown as Array<{ id: string; status: string }>;

    if (live[0]) {
      throw new ConflictError(
        `A pull is already ${live[0].status} for this tenant. Wait for it to finish, or let the `
        + 'reaper fail it if the service was restarted mid-run.',
        { run_id: live[0].id, status: live[0].status },
      );
    }

    // Nothing from a previous pull survives into the next: the FK cascade takes
    // scratch.meta_pull_leads with it. This is the statement that needs DELETE
    // in 07_grants.sql, against that file's own no-DELETE convention.
    //
    // The `tenant_id` filter here is belt-and-braces on a DESTRUCTIVE
    // statement, not the boundary — the policy above it already confines the
    // rows. Reads in this module deliberately carry no such filter, so they
    // still prove the policy; a wholesale DELETE is the one place where relying
    // on the policy alone is not worth the blast radius if it were ever
    // mis-applied.
    await tx.execute(sql`
      DELETE FROM scratch.meta_pull_runs
      WHERE tenant_id = ${scope.tenantId}::uuid AND trigger_kind = ${triggerKind}
    `);

    const createdBy = triggerKind === 'scheduled' ? null : scope.actorUserId;
    const inserted = (await tx.execute(sql`
      INSERT INTO scratch.meta_pull_runs (tenant_id, created_by, status, filters, trigger_kind)
      VALUES (${scope.tenantId}::uuid, ${createdBy}::uuid, 'queued', ${JSON.stringify(filters)}::jsonb, ${triggerKind})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    return { run_id: inserted[0]!.id };
  });
}

export interface PullRunStatus {
  id: string;
  status: string;
  trigger_kind: TriggerKind;
  filters: PullFilters;
  counts: Record<string, unknown>;
  heartbeat_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  applied_at: string | null;
  error_text: string | null;
  created_at: string;
  /** verdict → count, the delta summary the screen renders. */
  verdict_summary: Record<string, number>;
  /** applied_status → count, once Apply has run. */
  apply_summary: Record<string, number>;
  /** How many rows Apply would act on right now. */
  importable: number;
  /**
   * Distinct pages behind the unmapped_form verdict — what the summary links to
   * Meta Page Mapping, one link per page. Aggregated here over EVERY staged row:
   * the screen used to derive it from the first 500 rows it fetched, which
   * silently dropped pages on a large pull.
   */
  unmapped_page_ids: string[];
  /**
   * Honest about Meta's shape: there is NO campaign-scoped lead edge, so the
   * campaign filter narrowed the RESULT and not the WORK. Surfaced so the UI
   * can say so — otherwise the first thing an admin does is select a single
   * campaign and read the identical runtime as a bug.
   */
  campaign_filter_is_post_fetch: boolean;
}

export async function getPullRun(scope: AdminTenantScope, runId: string): Promise<PullRunStatus> {
  return withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);

    // No tenant filter: the policy is the scope. A run belonging to another
    // tenant is invisible and reaches here as "not found", which is the right
    // answer — distinguishing the two would confirm its existence.
    const rows = (await tx.execute(sql`
      SELECT r.id, r.status, r.trigger_kind, r.filters, r.counts, r.heartbeat_at, r.started_at,
             r.finished_at, r.applied_at, r.error_text, r.created_at,
             COALESCE((
               SELECT jsonb_object_agg(v.verdict, v.n)
               FROM (SELECT COALESCE(verdict, 'unclassified') AS verdict, COUNT(*)::int AS n
                       FROM scratch.meta_pull_leads WHERE run_id = r.id GROUP BY 1) v
             ), '{}'::jsonb) AS verdict_summary,
             COALESCE((
               SELECT jsonb_object_agg(a.applied_status, a.n)
               FROM (SELECT applied_status, COUNT(*)::int AS n
                       FROM scratch.meta_pull_leads WHERE run_id = r.id GROUP BY 1) a
             ), '{}'::jsonb) AS apply_summary,
             -- IMPORTABLE_VERDICTS, not a literal list: the same constant
             -- Apply selects on, so the button's count cannot drift from what
             -- pressing it acts on.
             (SELECT COUNT(*)::int FROM scratch.meta_pull_leads
               WHERE run_id = r.id
                 AND verdict = ANY(${sqlTextArr([...IMPORTABLE_VERDICTS])})
                 AND applied_status = 'pending') AS importable,
             COALESCE((
               SELECT array_agg(DISTINCT page_id::text ORDER BY page_id::text)
               FROM scratch.meta_pull_leads
               WHERE run_id = r.id AND verdict = 'unmapped_form' AND page_id IS NOT NULL
             ), '{}') AS unmapped_page_ids
      FROM scratch.meta_pull_runs r
      WHERE r.id = ${runId}::uuid
      LIMIT 1
    `)) as unknown as Array<Omit<PullRunStatus, 'campaign_filter_is_post_fetch'>>;

    const run = rows[0];
    if (!run) throw new NotFoundError('Pull run not found');

    return {
      ...run,
      // Campaign MODE walks the campaigns' own ads, so its filter is not post-fetch.
      campaign_filter_is_post_fetch:
        (run.filters?.campaign_ids?.length ?? 0) > 0 && run.filters?.mode !== 'campaign',
    };
  });
}

export interface LatestPullRun {
  run_id: string;
  status: string;
}

/**
 * The tenant's current run, if any — what the screen reopens on load.
 *
 * The run id used to live only in the page's React state, so leaving the page
 * mid-pull lost it, and a completed-but-unapplied run could never be reopened:
 * the next Pull silently deleted it. POST /runs deletes a tenant's previous run
 * before inserting the next, so there is normally exactly one; ORDER BY + LIMIT
 * is belt-and-braces.
 */
export async function getLatestPullRun(
  scope: AdminTenantScope,
  triggerKind: TriggerKind = 'manual',
): Promise<LatestPullRun | null> {
  return withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);

    // No tenant filter: admin_tenant_config_policy is the scope.
    const rows = (await tx.execute(sql`
      SELECT id AS run_id, status
      FROM scratch.meta_pull_runs
      WHERE trigger_kind = ${triggerKind}
      ORDER BY created_at DESC
      LIMIT 1
    `)) as unknown as LatestPullRun[];
    return rows[0] ?? null;
  });
}

export interface ListRunLeadsFilters {
  verdict?: string | undefined;
  page: number;
  page_size: number;
}

export async function listRunLeads(
  scope: AdminTenantScope,
  runId: string,
  filters: ListRunLeadsFilters,
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  return withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);

    // The run must be visible under the policy before its leads are listed.
    // Without this a caller could enumerate another tenant's staged rows only
    // if the leads policy were also broken — checking here means one failure is
    // not enough.
    const run = (await tx.execute(sql`
      SELECT id FROM scratch.meta_pull_runs WHERE id = ${runId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!run[0]) throw new NotFoundError('Pull run not found');

    const offset = (filters.page - 1) * filters.page_size;
    const verdictFilter = filters.verdict ? sql`AND l.verdict = ${filters.verdict}` : sql``;

    const rows = (await tx.execute(sql`
      SELECT l.id,
             l.org_id,
             l.page_id::text      AS page_id,
             l.form_id::text      AS form_id,
             l.form_name,
             l.meta_lead_id::text AS meta_lead_id,
             l.campaign_id::text  AS campaign_id,
             l.platform,
             l.lead_created_at,
             l.verdict,
             l.reason,
             l.existing_lead_id,
             l.is_hiring_form,
             l.suggested_campaign_type_id,
             ct.label             AS suggested_campaign_type_label,
             l.applied_status,
             l.applied_lead_id,
             l.applied_error,
             COUNT(*) OVER () AS total_count
      FROM scratch.meta_pull_leads l
      LEFT JOIN marketing.campaign_types ct ON ct.id = l.suggested_campaign_type_id
      WHERE l.run_id = ${runId}::uuid
      ${verdictFilter}
      ORDER BY l.lead_created_at DESC NULLS LAST, l.id
      LIMIT ${filters.page_size} OFFSET ${offset}
    `)) as unknown as Array<Record<string, unknown>>;

    // Contact values are NOT returned. The grid needs a lead's verdict and its
    // Meta ids to be actionable; it does not need the phone number and email of
    // someone who has not been imported yet, and shipping them would put
    // un-consented PII into a screen, a browser cache and every proxy log on
    // the way there.
    return {
      rows,
      total: rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0,
    };
  });
}

export interface PullCampaignOption {
  meta_campaign_id: string;
  name: string | null;
  effective_status: string | null;
  /** The confirmed type, else the suggestion. */
  campaign_type_label: string | null;
  mapping_status: string;
}

/**
 * The campaign multiselect.
 *
 * `page_ids` narrows the list to campaigns that have ALREADY DELIVERED a lead
 * on one of those pages, and that association is OBSERVED (ext.meta_leads),
 * not something Meta models: there is no page→campaign edge in the Graph API
 * and ext.meta_campaigns is an ad-account-scoped cache with no page dimension
 * at all. A campaign that has never delivered on the selected pages is
 * therefore absent from the picker even though a pull could still surface one —
 * which is the honest trade for a usable dropdown, and is why leaving the
 * multiselect empty (= every campaign) stays the default.
 */
export async function listPullCampaigns(
  scope: AdminTenantScope,
  pageIds: string[],
): Promise<PullCampaignOption[]> {
  const observed = pageIds.length ? await observedCampaignIds(scope, pageIds) : null;

  return withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);

    // 1.51.0: a campaign belongs to the selected pages when it has DELIVERED a
    // lead on one of them (observed) OR its ad sets PROMOTE one of them (the
    // page_ids the campaign fetch now records) — so a campaign with no leads yet
    // is pullable too.
    const pageArr = pageIds.length
      ? sql`ARRAY[${sql.join(pageIds.map((p) => sql`${p}::bigint`), sql`, `)}]::bigint[]`
      : sql`'{}'::bigint[]`;
    const idFilter = observed
      ? sql`AND (mc.page_ids && ${pageArr}
                 ${observed.length ? sql`OR mc.meta_campaign_id = ANY(ARRAY[${sql.join(observed.map((c) => sql`${c}::bigint`), sql`, `)}])` : sql``})`
      : sql``;

    // No tenant filter: admin_tenant_config_policy on ext.meta_campaigns is the
    // scope, exactly as in campaign-admin.service.ts.
    const rows = await tx.execute(sql`
      SELECT mc.meta_campaign_id::text AS meta_campaign_id,
             mc.name,
             mc.effective_status,
             COALESCE(ct.label, st.label) AS campaign_type_label,
             mc.mapping_status
      FROM ext.meta_campaigns mc
      LEFT JOIN marketing.campaign_types ct ON ct.id = mc.campaign_type_id
      LEFT JOIN marketing.campaign_types st ON st.id = mc.suggested_campaign_type_id
      WHERE TRUE
      ${idFilter}
      ORDER BY mc.name NULLS LAST, mc.meta_campaign_id
    `);
    return rows as unknown as PullCampaignOption[];
  });
}

/**
 * Campaign ids seen on the selected pages.
 *
 * The org set comes from `ext.meta_page_form_org_map` read UNDER THE POLICY, so
 * it can only ever contain branches of the administered tenant. The
 * ext.meta_leads read then has to be a system operation — that table is
 * ORG-scoped (its app_user policy keys on app.current_org_id, which
 * withTenantConfigTx deliberately never sets), so under the admin transaction
 * it returns zero rows with no error. Containment here is the explicit org
 * list, and that list was itself produced by the policy.
 */
async function observedCampaignIds(scope: AdminTenantScope, pageIds: string[]): Promise<string[]> {
  const pageArr = sql`ARRAY[${sql.join(pageIds.map((p) => sql`${p}::bigint`), sql`, `)}]`;

  const orgIds = await withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);
    const rows = (await tx.execute(sql`
      SELECT DISTINCT org_id FROM ext.meta_page_form_org_map
      WHERE is_active = true AND page_id = ANY(${pageArr})
    `)) as unknown as Array<{ org_id: string }>;
    return rows.map((r) => r.org_id);
  });

  if (orgIds.length === 0) return [];

  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT campaign_id::text AS campaign_id
      FROM ext.meta_leads
      WHERE campaign_id IS NOT NULL
        AND page_id = ANY(${pageArr})
        AND org_id = ANY(${sqlUuidArr(orgIds)})
    `)) as unknown as Array<{ campaign_id: string }>;
    return rows.map((r) => r.campaign_id);
  });
}

export interface RemapResult {
  /** Staged rows that now resolve to a branch. */
  remapped: number;
  /** Rows still on a page/form with no mapping. */
  still_unmapped: number;
  verdicts: Record<string, number>;
}

/**
 * Re-resolves the branch of every UNMAPPED staged row against the mappings as
 * they stand NOW, then re-classifies the run (1.51.0). This is the "map the page
 * inline, then apply those rows" flow: the admin creates the mapping from the
 * lead-pull screen and presses Remap, and the rows become importable without a
 * second Graph walk. Rows Apply had already skipped as unmapped go back to
 * pending, and queueApply accepts an 'applied' run again while it has pending
 * importable rows.
 *
 * Precedence is the one routing uses everywhere: exact form row, then the
 * page-level row. Under withTenantConfigTx, so both the staged rows and the
 * mappings are fenced to the administered tenant by their policies, and the
 * staged row's WITH CHECK re-proves the org belongs to that tenant.
 */
export async function remapRun(scope: AdminTenantScope, runId: string): Promise<RemapResult> {
  const run = await withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);
    const rows = (await tx.execute(sql`
      SELECT id, tenant_id, created_by, filters, status FROM scratch.meta_pull_runs
      WHERE id = ${runId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string; tenant_id: string; created_by: string | null; filters: PullFilters; status: string }>;
    const found = rows[0];
    if (!found) throw new NotFoundError('Pull run not found');
    if (!['completed', 'applied'].includes(found.status)) {
      throw new ConflictError(`A run in status '${found.status}' cannot be remapped — wait for it to finish`);
    }

    const updated = (await tx.execute(sql`
      UPDATE scratch.meta_pull_leads l
      SET org_id = m.org_id,
          applied_status = CASE WHEN l.applied_status = 'skipped' THEN 'pending' ELSE l.applied_status END,
          applied_error  = CASE WHEN l.applied_status = 'skipped' THEN NULL ELSE l.applied_error END
      FROM LATERAL (
        SELECT pm.org_id
        FROM ext.meta_page_form_org_map pm
        WHERE pm.is_active
          AND (pm.form_id = l.form_id OR (pm.form_id IS NULL AND pm.page_id = l.page_id))
        ORDER BY (pm.form_id IS NULL) ASC, pm.created_at DESC
        LIMIT 1
      ) m
      WHERE l.run_id = ${runId}::uuid
        AND l.org_id IS NULL
        AND l.applied_status IN ('pending', 'skipped')
      RETURNING l.id
    `)) as unknown as Array<{ id: string }>;
    return { ...found, remapped: updated.length };
  });

  const verdicts = await classifyRunLeads({
    id: run.id,
    tenant_id: run.tenant_id,
    created_by: run.created_by,
    filters: run.filters,
  });

  return { remapped: run.remapped, still_unmapped: verdicts['unmapped_form'] ?? 0, verdicts };
}
