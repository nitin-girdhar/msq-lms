import { sql } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@platform/db';
import { organizationsTable } from '@platform/db/schema';
import { eq } from 'drizzle-orm';
import { METRIC_KEYS, toBranchRow, toUserRow, zeroMetrics } from '../../../lib/reports/lead-report.types.js';
import type {
  BranchReportRow, LeadReportMetrics, TenantReport, UserReportRow,
} from '../../../lib/reports/lead-report.types.js';
import { toSourceBranchRow, toSourceUserRow } from '../../../lib/reports/source-report.types.js';
import type { SourceBranchRow, SourceUserRow } from '../../../lib/reports/source-report.types.js';

/**
 * An inclusive lead-CREATION-date window, both ends `YYYY-MM-DD`, interpreted in
 * each branch's own timezone (see rangeFilter). Used by the public report page's
 * start/end filter; every other caller leaves it undefined and keeps the
 * all-time behaviour.
 */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * The created_at bound shared by sourceBranchQuery and sourceUserQuery, or an
 * empty fragment when no range is active.
 *
 * `AT TIME ZONE o.timezone` is load-bearing, not cosmetic: ::date on a
 * timestamptz truncates in UTC, which for an Asia/Kolkata branch (UTC+5:30)
 * files everything created before 05:30 local under the previous day — the same
 * reasoning spelled out above lms.vw_lead_report_branch in db_scripts/05_views.sql.
 */
function rangeFilter(range?: DateRange) {
  if (!range) return sql``;
  return sql`AND (ml.created_at AT TIME ZONE o.timezone)::date
               BETWEEN ${range.start}::date AND ${range.end}::date`;
}

async function resolveTenantId(orgId: string): Promise<string> {
  return withServiceTx(async (tx) => {
    const [row] = await tx
      .select({ tenantId: organizationsTable.tenantId })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    if (!row) throw new Error(`Organization not found: ${orgId}`);
    return row.tenantId;
  });
}

/**
 * All org_ids one user is actively mapped to via iam.user_org_mapping — used
 * to detect a multi-branch, non-tenant-wide actor (e.g. a Fitclass "Wingman",
 * role org_manager) whose session org_id is only their single home org.
 *
 * Read with withServiceTx: this is not itself an RLS boundary, it only tells
 * the caller which per-org org_admin transactions to open next.
 */
export async function getUserOrgIds(userId: string): Promise<string[]> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT org_id::text AS org_id
      FROM iam.user_org_mapping
      WHERE user_id = ${userId}::uuid AND is_active
    `)) as Array<{ org_id: string }>;
    return rows.map((r) => r.org_id);
  });
}

export async function getOrgPerformanceSnapshot(orgId: string, userId: string) {
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM lms.vw_org_performance_snapshot WHERE org_id = ${orgId}::uuid
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

export async function getTenantDashboard(orgId: string, userId: string) {
  const tenantId = await resolveTenantId(orgId);
  return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT * FROM lms.vw_tenant_full_dashboard WHERE tenant_id = ${tenantId}::uuid
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getTenantCampaignSummary(orgId: string, userId: string) {
  const tenantId = await resolveTenantId(orgId);
  return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT * FROM marketing.vw_tenant_campaign_summary WHERE tenant_id = ${tenantId}::uuid ORDER BY campaign_name
    `)) as Array<Record<string, unknown>>;
  });
}

/**
 * `range` narrows to leads created in the window. It belongs in the LEFT JOIN's
 * ON clause, NOT in a WHERE: a WHERE would discard the NULL-extended rows the
 * outer join produces and silently drop every stage with no leads in the
 * window, defeating the zero-fill this query exists to provide.
 *
 * The timezone comes from a scalar subquery because there is no organizations
 * alias to hang `AT TIME ZONE` off here — same branch-local semantics as
 * rangeFilter, reached a different way.
 */
export async function getPipelineByStage(orgId: string, userId: string, range?: DateRange) {
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT ls.name AS stage, ls.label AS stage_label, COUNT(ml.id)::INT AS count
      FROM lms.lead_stage ls
      LEFT JOIN lms.marketing_leads ml
        ON ml.stage_id = ls.id AND ml.org_id = ${orgId}::uuid AND NOT ml.is_deleted AND ml.superseded_by IS NULL
        ${range
          ? sql`AND (ml.created_at AT TIME ZONE (SELECT timezone FROM entity.organizations WHERE id = ${orgId}::uuid))::date
                  BETWEEN ${range.start}::date AND ${range.end}::date`
          : sql``}
      GROUP BY ls.id, ls.name, ls.label
      ORDER BY ls.sort_order
    `)) as Array<Record<string, unknown>>;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generated metric fragments.
//
// Seven query sites below enumerate all 29 metric columns. Hand-listing them
// seven times is how one site silently drifts from the others — a missed column
// in an INSERT is a constraint violation, but a missed one in a SUM list is a
// zero that looks like real data. So every repeated list is derived from the
// single METRIC_KEYS array in lead-report.types.ts, which is itself kept in
// lock-step with the two views and lms.lead_report_snapshot.
//
// sql.raw is safe here and only here: METRIC_KEYS is a compile-time `as const`
// tuple of identifiers, never user input.
// ─────────────────────────────────────────────────────────────────────────────

/** `total_leads, unassigned_count, …` — INSERT column lists. */
const METRIC_COLS = sql.join(METRIC_KEYS.map((k) => sql.raw(k)), sql`, `);

/** `SUM(total_leads)::INT AS total_leads, …` — every rollup/snapshot read. */
const METRIC_SUMS = sql.join(
  METRIC_KEYS.map((k) => sql`SUM(${sql.raw(k)})::INT AS ${sql.raw(k)}`),
  sql`, `,
);

/** `0, 0, …` — the zero-fill snapshot row for a (branch, source) with no users. */
const METRIC_ZEROS = sql.join(METRIC_KEYS.map(() => sql`0`), sql`, `);

/** `total_leads = EXCLUDED.total_leads, …` — ON CONFLICT DO UPDATE. */
const METRIC_UPSERT = sql.join(
  METRIC_KEYS.map((k) => sql`${sql.raw(k)} = EXCLUDED.${sql.raw(k)}`),
  sql`, `,
);

/** `c.total_leads, …` — projecting a counters CTE through an outer SELECT. */
function metricCols(prefix: string) {
  return sql.join(METRIC_KEYS.map((k) => sql`${sql.raw(prefix)}.${sql.raw(k)}`), sql`, `);
}

/** The metric values off one row, positionally matching METRIC_COLS. */
function metricValues(row: LeadReportMetrics) {
  return sql.join(METRIC_KEYS.map((k) => sql`${row[k]}`), sql`, `);
}

/**
 * The live COUNT(*) FILTER list, shared by sourceBranchQuery and
 * sourceUserQuery — both alias ml / o / ls / lo the same way. This is the one
 * list that cannot be generated from METRIC_KEYS, because each metric has its
 * own predicate; it is the same set of expressions as the two views in
 * db_scripts/05_views.sql and has to be changed with them.
 */
const METRIC_COUNTERS = sql`
      -- core
      COUNT(*)::INT                                                                AS total_leads,
      COUNT(*) FILTER (WHERE ml.assigned_user_id IS NULL)::INT                     AS unassigned_count,
      COUNT(*) FILTER (WHERE ml.scheduled_at IS NOT NULL
                             AND ml.scheduled_at >= NOW())::INT                    AS followup_scheduled,
      COUNT(*) FILTER (WHERE ml.scheduled_at IS NOT NULL
                             AND ml.scheduled_at <  NOW())::INT                    AS followup_overdue,
      COUNT(*) FILTER (WHERE (ml.created_at AT TIME ZONE o.timezone)::date
                               = (NOW()          AT TIME ZONE o.timezone)::date)::INT AS new_leads_today,
      COUNT(*) FILTER (WHERE date_trunc('month', ml.created_at AT TIME ZONE o.timezone)
                               = date_trunc('month', NOW()          AT TIME ZONE o.timezone))::INT AS new_leads_this_month,
      -- per stage (lms.lead_stage.name, in sort_order)
      COUNT(*) FILTER (WHERE ls.name = 'new')::INT                                 AS new_count,
      COUNT(*) FILTER (WHERE ls.name = 'contacting')::INT                          AS contacting_count,
      COUNT(*) FILTER (WHERE ls.name = 'on_hold')::INT                             AS on_hold_count,
      COUNT(*) FILTER (WHERE ls.name = 'qualified')::INT                           AS qualified_count,
      COUNT(*) FILTER (WHERE ls.name = 'converted')::INT                           AS converted_count,
      COUNT(*) FILTER (WHERE ls.name = 'unqualified')::INT                         AS unqualified_count,
      COUNT(*) FILTER (WHERE ls.name = 'transferred_out')::INT                     AS transferred_out_count,
      -- per stage outcome (lms.lead_stage_outcome.name, by parent stage)
      --   contacting
      COUNT(*) FILTER (WHERE lo.name = 'not_connected')::INT                       AS oc_not_connected_count,
      COUNT(*) FILTER (WHERE lo.name = 'switch_off')::INT                          AS oc_switch_off_count,
      COUNT(*) FILTER (WHERE lo.name = 'not_answered')::INT                        AS oc_not_answered_count,
      COUNT(*) FILTER (WHERE lo.name = 'call_back_later')::INT                     AS oc_call_back_later_count,
      --   on_hold
      COUNT(*) FILTER (WHERE lo.name = 'on_hold')::INT                             AS oc_on_hold_count,
      --   qualified
      COUNT(*) FILTER (WHERE lo.name = 'visit_scheduled')::INT                     AS oc_visit_scheduled_count,
      COUNT(*) FILTER (WHERE lo.name = 'visited')::INT                             AS oc_visited_count,
      --   converted
      COUNT(*) FILTER (WHERE lo.name = 'membership_sold')::INT                     AS oc_membership_sold_count,
      --   unqualified
      COUNT(*) FILTER (WHERE lo.name = 'no_response_after_multiple_attempts')::INT AS oc_no_response_after_multiple_attempts_count,
      COUNT(*) FILTER (WHERE lo.name = 'wrong_number')::INT                        AS oc_wrong_number_count,
      COUNT(*) FILTER (WHERE lo.name = 'job_applicant')::INT                       AS oc_job_applicant_count,
      COUNT(*) FILTER (WHERE lo.name = 'budget_issue')::INT                        AS oc_budget_issue_count,
      COUNT(*) FILTER (WHERE lo.name = 'not_interested')::INT                      AS oc_not_interested_count,
      COUNT(*) FILTER (WHERE lo.name = 'location_issue')::INT                      AS oc_location_issue_count,
      COUNT(*) FILTER (WHERE lo.name = 'duplicate_lead')::INT                      AS oc_duplicate_lead_count,
      --   transferred_out
      COUNT(*) FILTER (WHERE lo.name = 'transferred_to_other_branch')::INT         AS oc_transferred_to_other_branch_count`;

// ─────────────────────────────────────────────────────────────────────────────
// Daily lead report (lms.vw_lead_report_branch / lms.vw_lead_report_user).
//
// Metric semantics live in the views' header comments in db_scripts/02_schema.sql
// — read those before changing anything here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-branch rows for one tenant plus an "ALL BRANCHES" rollup row (is_total).
 *
 * The rollup is a GROUPING SETS row rather than a sum in TS so the API, the
 * email and a manual psql check can never disagree about the total.
 *
 * MUST run as tenant_admin. org_isolation_policy on lms.marketing_leads
 * restricts app_user to app.current_org_id, so an app_user/org_admin path here
 * returns a SINGLE-branch report labelled as a tenant report — wrong numbers,
 * no error.
 *
 * Caveat: new_leads_today summed across branches in different timezones is a sum
 * of each branch's own local day. Deliberate — hence org_timezone on each row.
 */
function tenantBranchReportQuery(tenantId: string) {
  return sql`
    SELECT
      ${tenantId}::uuid                AS tenant_id,
      org_id,
      -- GROUPING(), not "org_id IS NULL" + COALESCE(MAX(org_name)): in the ()
      -- grouping set MAX(org_name) still returns a real branch name (the
      -- alphabetically last one), so a COALESCE would never fire and the rollup
      -- row would be labelled with an arbitrary branch.
      CASE WHEN GROUPING(org_id) = 1 THEN 'ALL BRANCHES' ELSE MAX(org_name) END  AS org_name,
      CASE WHEN GROUPING(org_id) = 1 THEN NULL           ELSE MAX(org_timezone) END AS org_timezone,
      -- MAX over the branches' local dates: the right label for a tenant whose
      -- branches span timezones.
      MAX(report_date)                 AS report_date,
      (GROUPING(org_id) = 1)           AS is_total,
      ${METRIC_SUMS},
      CLOCK_TIMESTAMP()            AS snapshot_at
    FROM lms.vw_lead_report_branch
    WHERE tenant_id = ${tenantId}::uuid
    GROUP BY GROUPING SETS ((org_id), ())
    ORDER BY GROUPING(org_id), MAX(org_name)
  `;
}

export async function getTenantBranchReport(orgId: string, userId: string) {
  const tenantId = await resolveTenantId(orgId);
  return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
    return (await tx.execute(tenantBranchReportQuery(tenantId))) as Array<Record<string, unknown>>;
  });
}

/** Single-branch report row. */
export async function getBranchReport(orgId: string, userId: string) {
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT * FROM lms.vw_lead_report_branch WHERE org_id = ${orgId}::uuid
    `)) as Array<Record<string, unknown>>;
  });
}

/** Sums the LeadReportMetrics-shaped numeric fields across raw branch rows into one rollup row. */
function sumBranchRows(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const rollup: Record<string, unknown> = {
    tenant_id: rows[0]?.['tenant_id'] ?? null,
    org_id: null,
    org_name: 'ALL BRANCHES',
    org_timezone: null,
    report_date: rows.reduce<string | null>((max, r) => {
      const d = r['report_date'] == null ? null : String(r['report_date']);
      return d && (!max || d > max) ? d : max;
    }, null),
    is_total: true,
  };
  for (const key of METRIC_KEYS) {
    rollup[key] = rows.reduce((sum, r) => sum + Number(r[key] ?? 0), 0);
  }
  return rollup;
}

/**
 * Combined branch report across exactly the given org_ids (a Wingman's
 * assigned-branch cluster), NOT a full tenant. Runs getBranchReport's
 * existing org_admin RLS transaction once per org — the same per-org RLS
 * boundary already used for single-branch admins — and adds a synthetic
 * "ALL BRANCHES" rollup row computed in TS, mirroring tenantBranchReportQuery's
 * shape so the frontend needs no changes.
 */
export async function getMultiOrgBranchReport(orgIds: string[], userId: string) {
  const perOrg = await Promise.all(orgIds.map((orgId) => getBranchReport(orgId, userId)));
  const rows = perOrg.flat();
  return [...rows, sumBranchRows(rows)];
}

/**
 * Per-assignee rows, including one "Unassigned" row per branch.
 *
 * ORDER BY ... is_unassigned first within each branch puts the actionable
 * Unassigned bucket at the top of its block.
 */
export async function getUserReport(orgId: string, userId: string, isTenantWide: boolean) {
  if (isTenantWide) {
    const tenantId = await resolveTenantId(orgId);
    return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
      return (await tx.execute(sql`
        SELECT * FROM lms.vw_lead_report_user
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY org_name, is_unassigned DESC, assignee
      `)) as Array<Record<string, unknown>>;
    });
  }
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT * FROM lms.vw_lead_report_user
      WHERE org_id = ${orgId}::uuid
      ORDER BY is_unassigned DESC, assignee
    `)) as Array<Record<string, unknown>>;
  });
}

/** Combined per-assignee report across a Wingman's assigned-branch cluster. */
export async function getMultiOrgUserReport(orgIds: string[], userId: string) {
  const perOrg = await Promise.all(orgIds.map((orgId) => getUserReport(orgId, userId, false)));
  return perOrg.flat();
}

/**
 * Both report shapes for one tenant, read with the service role.
 *
 * For the cron job only: there is no actor and no session GUC to scope RLS with,
 * so it reads as root_service (BYPASSRLS) and scopes on tenant_id explicitly.
 * Never reachable from an HTTP handler.
 */
export async function getTenantReportForJob(tenantId: string) {
  return withServiceTx(async (tx) => {
    const branches = (await tx.execute(tenantBranchReportQuery(tenantId))) as Array<Record<string, unknown>>;
    const users = (await tx.execute(sql`
      SELECT * FROM lms.vw_lead_report_user
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY org_name, is_unassigned DESC, assignee
    `)) as Array<Record<string, unknown>>;
    return { branches, users };
  });
}

/**
 * Writes one row per (org_id, assigned_user_id, source_id) bucket from
 * `sourceReport.users`, plus a synthetic all-zero row for any (branch, source)
 * combination in `sourceReport.branches` that has no user rows at all — the
 * exact same zero-filled data the live "By source" grids render from, so
 * history can never disagree with what the page showed on the day it was
 * captured.
 *
 * Sourced from `sourceReport` (not `report`) because it is a strict
 * superset: summing a source-segmented row set across source_id for a given
 * (org_id, assigned_user_id) recovers the plain, non-source total exactly —
 * see getSnapshotForDate, which does that summing at read time. Writing only
 * one table keyed this way means the plain and per-source compare views can
 * never drift apart the way two independently-written tables could.
 *
 * Idempotent (ON CONFLICT ... DO UPDATE): re-running for the same tenant/day
 * overwrites those rows rather than duplicating them.
 */
export async function upsertReportSnapshot(
  report: TenantReport,
  sourceReport: { branches: SourceBranchRow[]; users: SourceUserRow[] },
): Promise<void> {
  return withServiceTx(async (tx) => {
    const covered = new Set(sourceReport.users.map((u) => `${u.org_id}:${u.source_id ?? 'null'}`));

    for (const u of sourceReport.users) {
      await tx.execute(sql`
        INSERT INTO lms.lead_report_snapshot
          (tenant_id, org_id, org_name, assigned_user_id, assignee, is_unassigned,
           source_id, source_label, report_date,
           ${METRIC_COLS})
        VALUES (
          ${report.tenant_id}::uuid, ${u.org_id}::uuid, ${u.org_name}, ${u.assigned_user_id}::uuid,
          ${u.assignee}, ${u.is_unassigned}, ${u.source_id}::uuid, ${u.source_label}, ${u.report_date}::date,
          ${metricValues(u)}
        )
        ON CONFLICT (tenant_id, org_id, assigned_user_id, source_id, report_date) DO UPDATE SET
          org_name = EXCLUDED.org_name, assignee = EXCLUDED.assignee, is_unassigned = EXCLUDED.is_unassigned,
          source_label = EXCLUDED.source_label,
          ${METRIC_UPSERT},
          captured_at = CLOCK_TIMESTAMP()
      `);
    }

    for (const b of sourceReport.branches) {
      if (b.is_total || !b.org_id) continue;
      if (covered.has(`${b.org_id}:${b.source_id ?? 'null'}`)) continue;
      await tx.execute(sql`
        INSERT INTO lms.lead_report_snapshot
          (tenant_id, org_id, org_name, assigned_user_id, assignee, is_unassigned,
           source_id, source_label, report_date,
           ${METRIC_COLS})
        VALUES (
          ${report.tenant_id}::uuid, ${b.org_id}::uuid, ${b.org_name}, NULL, 'Unassigned', TRUE,
          ${b.source_id}::uuid, ${b.source_label}, ${b.report_date}::date,
          ${METRIC_ZEROS}
        )
        ON CONFLICT (tenant_id, org_id, assigned_user_id, source_id, report_date) DO UPDATE SET
          org_name = EXCLUDED.org_name, source_label = EXCLUDED.source_label, captured_at = CLOCK_TIMESTAMP()
      `);
    }
  });
}

/**
 * The prior day's (or any historical day's) PLAIN report (no source
 * breakdown), reconstructed from lms.lead_report_snapshot for the "By branch"
 * / "By assignee" compare view. `null` when nothing was recorded for that
 * tenant/date — expected for any day before the snapshot job first ran, not
 * an error condition.
 *
 * The table now stores one row per (branch, assignee, source); this query
 * SUMs across source_id per (org_id, assigned_user_id) to recover the same
 * combined-across-sources total the pre-source-tracking version of this table
 * stored directly. Branch/rollup totals are derived with the same GROUPING
 * SETS technique tenantBranchReportQuery uses over live data — see that
 * function's header comment.
 */
export async function getSnapshotForDate(
  tenantId: string,
  date: string,
): Promise<{ branches: BranchReportRow[]; users: UserReportRow[] } | null> {
  return withServiceTx(async (tx) => {
    const users = (await tx.execute(sql`
      SELECT
        tenant_id, org_id, MAX(org_name) AS org_name, assigned_user_id, MAX(assignee) AS assignee,
        (assigned_user_id IS NULL) AS is_unassigned, ${date}::date AS report_date,
        ${METRIC_SUMS}
      FROM lms.lead_report_snapshot
      WHERE tenant_id = ${tenantId}::uuid AND report_date = ${date}::date
      GROUP BY tenant_id, org_id, assigned_user_id
      ORDER BY org_name, is_unassigned DESC, assignee
    `)) as Array<Record<string, unknown>>;
    if (users.length === 0) return null;

    const branches = (await tx.execute(sql`
      SELECT
        ${tenantId}::uuid AS tenant_id,
        org_id,
        CASE WHEN GROUPING(org_id) = 1 THEN 'ALL BRANCHES' ELSE MAX(org_name) END AS org_name,
        (GROUPING(org_id) = 1) AS is_total,
        ${date}::date AS report_date,
        ${METRIC_SUMS}
      FROM lms.lead_report_snapshot
      WHERE tenant_id = ${tenantId}::uuid AND report_date = ${date}::date
      GROUP BY GROUPING SETS ((org_id), ())
      ORDER BY GROUPING(org_id), MAX(org_name)
    `)) as Array<Record<string, unknown>>;

    return { branches: branches.map(toBranchRow), users: users.map(toUserRow) };
  });
}

/**
 * The prior day's (or any historical day's) SOURCE-segmented report, for the
 * public page's "By source" grids and the Source column on "By assignee".
 * `null` when nothing was recorded for that tenant/date — same "no history
 * yet" case as getSnapshotForDate, not an error.
 *
 * Per-source branch rollups use the same GROUPING SETS technique as the live
 * sourceBranchQuery, just over stored rows instead of lms.marketing_leads.
 */
export async function getSourceSnapshotForDate(
  tenantId: string,
  date: string,
): Promise<{ branches: SourceBranchRow[]; users: SourceUserRow[] } | null> {
  return withServiceTx(async (tx) => {
    const users = (await tx.execute(sql`
      SELECT * FROM lms.lead_report_snapshot
      WHERE tenant_id = ${tenantId}::uuid AND report_date = ${date}::date
      ORDER BY org_name, source_label, is_unassigned DESC, assignee
    `)) as Array<Record<string, unknown>>;
    if (users.length === 0) return null;

    const branches = (await tx.execute(sql`
      SELECT
        ${tenantId}::uuid AS tenant_id,
        org_id,
        CASE WHEN GROUPING(org_id) = 1 THEN 'ALL BRANCHES' ELSE MAX(org_name) END AS org_name,
        source_id,
        MAX(source_label) AS source_label,
        (GROUPING(org_id) = 1) AS is_total,
        ${date}::date AS report_date,
        ${METRIC_SUMS}
      FROM lms.lead_report_snapshot
      WHERE tenant_id = ${tenantId}::uuid AND report_date = ${date}::date
      GROUP BY GROUPING SETS ((org_id, source_id), (source_id))
      ORDER BY source_label, is_total, org_name
    `)) as Array<Record<string, unknown>>;

    return { branches: branches.map(toSourceBranchRow), users: users.map(toSourceUserRow) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead-source segmented report (public report page only — see
// public-report.render.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per (branch, source) row — no zero-fill: a branch/source combination with no
 * leads produces no row, and a source with no leads anywhere in the tenant
 * produces no rows (and no "ALL BRANCHES" rollup) at all. Deliberately
 * different from tenantBranchReportQuery, which zero-fills every branch —
 * "By source" is meant to show only where lead data actually exists, per
 * product ask, so a tenant with sources configured but unused doesn't render
 * a wall of empty grids.
 *
 * The rollup is summed from `counters` directly, so it can never disagree
 * with what a manual SUM() over the per-branch rows would show — same
 * reasoning as tenantBranchReportQuery's rollup.
 *
 * 'Unknown' is the bucket for ml.source_id IS NULL, mirroring the "Unassigned"
 * convention used for assigned_user_id IS NULL elsewhere in this file. Also
 * the bucket a lead's source_id falls into once looked up if that source was
 * later deactivated/deleted — LEFT JOIN + COALESCE, same as sourceUserQuery,
 * so a stale source_id doesn't drop the lead's counters row from the whole
 * report the way an INNER JOIN against only *active* sources previously did.
 */
function sourceBranchQuery(tenantId: string, orgId?: string, range?: DateRange) {
  return sql`
    WITH counters AS (
      SELECT
        ml.org_id,
        ml.source_id,
        ${METRIC_COUNTERS}
      FROM lms.marketing_leads ml
      JOIN entity.organizations o ON o.id = ml.org_id
      LEFT JOIN lms.lead_stage         ls ON ls.id = ml.stage_id AND ls.tenant_id = o.tenant_id
      LEFT JOIN lms.lead_stage_outcome lo ON lo.id = ml.outcome_id
      WHERE NOT ml.is_deleted AND ml.is_active AND o.tenant_id = ${tenantId}::uuid
        ${orgId ? sql`AND ml.org_id = ${orgId}::uuid` : sql``}
        ${rangeFilter(range)}
      GROUP BY ml.org_id, ml.source_id
    )
    SELECT
      o.tenant_id, o.id AS org_id, o.name AS org_name,
      c.source_id AS source_id, COALESCE(src.label, 'Unknown') AS source_label,
      (NOW() AT TIME ZONE o.timezone)::date AS report_date,
      FALSE AS is_total,
      ${metricCols('c')}
    FROM counters c
    JOIN entity.organizations o ON o.id = c.org_id AND NOT o.is_deleted
    LEFT JOIN lms.lead_sources src ON src.id = c.source_id
    WHERE o.tenant_id = ${tenantId}::uuid
      ${orgId ? sql`AND o.id = ${orgId}::uuid` : sql``}

    ${orgId ? sql`` : sql`
    UNION ALL

    SELECT
      ${tenantId}::uuid AS tenant_id, NULL AS org_id, 'ALL BRANCHES' AS org_name,
      c.source_id AS source_id, COALESCE(src.label, 'Unknown') AS source_label,
      CURRENT_DATE AS report_date,
      TRUE AS is_total,
      ${METRIC_SUMS}
    FROM counters c
    LEFT JOIN lms.lead_sources src ON src.id = c.source_id
    GROUP BY c.source_id, src.label
    `}

    ORDER BY source_label, is_total, org_name
  `;
}

/**
 * Per (branch, assignee, source) row — no zero-fill, same as
 * lms.vw_lead_report_user: a branch/assignee/source combination with no leads
 * produces no row. 'Unknown' bucket for ml.source_id IS NULL, as above.
 *
 * Ordered by assignee then source (not source then assignee) so every source
 * an assignee has leads in sits together in the grid instead of scattered
 * across separate source-first blocks. role_label rides along per assignee
 * (NULL for the Unassigned bucket) so the render can disambiguate two
 * distinct users who share a full_name.
 */
function sourceUserQuery(tenantId: string, orgId?: string, range?: DateRange) {
  return sql`
    SELECT
      o.tenant_id, ml.org_id, o.name AS org_name,
      ml.assigned_user_id,
      COALESCE(u.full_name, 'Unassigned') AS assignee,
      ur.label AS role_label,
      (ml.assigned_user_id IS NULL) AS is_unassigned,
      ml.source_id,
      COALESCE(src.label, 'Unknown') AS source_label,
      (NOW() AT TIME ZONE o.timezone)::date AS report_date,
      ${METRIC_COUNTERS}
    FROM lms.marketing_leads ml
    JOIN entity.organizations o ON o.id = ml.org_id AND NOT o.is_deleted
    LEFT JOIN lms.lead_stage ls   ON ls.id  = ml.stage_id  AND ls.tenant_id = o.tenant_id
    LEFT JOIN lms.lead_stage_outcome lo ON lo.id = ml.outcome_id
    LEFT JOIN iam.users u         ON u.id   = ml.assigned_user_id AND NOT u.is_deleted
    LEFT JOIN iam.user_roles ur   ON ur.id  = u.role_id
                                 AND (ur.tenant_id = o.tenant_id OR ur.tenant_id IS NULL)
    LEFT JOIN lms.lead_sources src ON src.id = ml.source_id
    WHERE NOT ml.is_deleted AND ml.is_active AND o.tenant_id = ${tenantId}::uuid
      ${orgId ? sql`AND ml.org_id = ${orgId}::uuid` : sql``}
      ${rangeFilter(range)}
    GROUP BY o.tenant_id, ml.org_id, o.name, o.timezone, ml.assigned_user_id, u.full_name,
             ur.label, ml.source_id, src.label
    ORDER BY org_name, is_unassigned DESC, assignee, source_label
  `;
}

/**
 * `range` narrows every row to leads CREATED inside that window; the status
 * counters (converted, followup_overdue, …) are still evaluated as of now over
 * that cohort, which is the only reading the schema supports — there is no
 * per-status history table. Left undefined by the snapshot cron and by
 * getSourceReport, which must keep their all-time behaviour.
 */
export async function getTenantSourceReport(
  tenantId: string,
  range?: DateRange,
): Promise<{ branches: SourceBranchRow[]; users: SourceUserRow[] }> {
  return withServiceTx(async (tx) => {
    const branches = (await tx.execute(sourceBranchQuery(tenantId, undefined, range))) as Array<Record<string, unknown>>;
    const users = (await tx.execute(sourceUserQuery(tenantId, undefined, range))) as Array<Record<string, unknown>>;
    return { branches: branches.map(toSourceBranchRow), users: users.map(toSourceUserRow) };
  });
}

/**
 * Authenticated, RLS-scoped counterpart to getTenantSourceReport (which uses
 * withServiceTx and is reserved for the cron job / public report, where there
 * is no session actor). Tenant-wide callers get every branch + an "ALL
 * BRANCHES" rollup per source, same as the branch/user report endpoints;
 * others get their one org's source breakdown only.
 */
export async function getSourceReport(
  orgId: string,
  userId: string,
  isTenantWide: boolean,
  range?: DateRange,
): Promise<{ branches: SourceBranchRow[]; users: SourceUserRow[] }> {
  if (isTenantWide) {
    const tenantId = await resolveTenantId(orgId);
    return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
      const branches = (await tx.execute(sourceBranchQuery(tenantId, undefined, range))) as Array<Record<string, unknown>>;
      const users = (await tx.execute(sourceUserQuery(tenantId, undefined, range))) as Array<Record<string, unknown>>;
      return { branches: branches.map(toSourceBranchRow), users: users.map(toSourceUserRow) };
    });
  }
  const tenantId = await resolveTenantId(orgId);
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    const branches = (await tx.execute(sourceBranchQuery(tenantId, orgId, range))) as Array<Record<string, unknown>>;
    const users = (await tx.execute(sourceUserQuery(tenantId, orgId, range))) as Array<Record<string, unknown>>;
    return { branches: branches.map(toSourceBranchRow), users: users.map(toSourceUserRow) };
  });
}

/** Sums SourceBranchRow metrics per source into "ALL BRANCHES" rollup rows, one per source. */
function rollupSourceBranches(rows: SourceBranchRow[]): SourceBranchRow[] {
  const bySource = new Map<string, SourceBranchRow[]>();
  for (const r of rows) {
    const key = r.source_id ?? r.source_label;
    const list = bySource.get(key);
    if (list) list.push(r);
    else bySource.set(key, [r]);
  }
  return [...bySource.values()].map((group) => {
    const first = group[0]!;
    const rollup: SourceBranchRow = {
      tenant_id: first.tenant_id,
      org_id: null,
      org_name: 'ALL BRANCHES',
      source_id: first.source_id,
      source_label: first.source_label,
      report_date: group.reduce((max, r) => (r.report_date > max ? r.report_date : max), first.report_date),
      is_total: true,
      ...zeroMetrics(),
    };
    for (const r of group) {
      for (const key of METRIC_KEYS) rollup[key] += r[key];
    }
    return rollup;
  });
}

/**
 * Plain per-branch rows (+ the "ALL BRANCHES" rollup) summed out of the
 * source-segmented rows, instead of read from lms.vw_lead_report_branch.
 *
 * Exists because that view has no date bound and cannot take one without a
 * schema change, while sourceBranchQuery can — so the public report's
 * start/end filter derives its branch level from the filtered source rows.
 * Summing across source_id recovers the plain total exactly; getSnapshotForDate
 * already relies on that same identity when it reconstructs a historical day.
 *
 * Two deliberate differences from the view: org_timezone is null (a source row
 * doesn't carry it, and the view's own rollup row is null there too), and there
 * is NO zero-fill — a branch with no leads in the window produces no row at all
 * rather than a row of zeroes. For a date-ranged report that is the wanted
 * behaviour, but it is a visible difference from the unfiltered page.
 */
export function rollupBranchesFromSources(rows: SourceBranchRow[]): BranchReportRow[] {
  const byOrg = new Map<string, SourceBranchRow[]>();
  for (const r of rows) {
    if (r.is_total || !r.org_id) continue;
    const list = byOrg.get(r.org_id);
    if (list) list.push(r);
    else byOrg.set(r.org_id, [r]);
  }

  const raw = [...byOrg.entries()].map(([orgId, group]) => {
    const first = group[0]!;
    const row: Record<string, unknown> = {
      tenant_id: first.tenant_id,
      org_id: orgId,
      org_name: first.org_name,
      org_timezone: null,
      report_date: group.reduce((max, r) => (r.report_date > max ? r.report_date : max), first.report_date),
      is_total: false,
    };
    for (const key of METRIC_KEYS) {
      row[key] = group.reduce((sum, r) => sum + Number(r[key] ?? 0), 0);
    }
    return row;
  });

  raw.sort((a, b) => String(a['org_name']).localeCompare(String(b['org_name'])));
  if (!raw.length) return [];
  return [...raw, sumBranchRows(raw)].map(toBranchRow);
}

/**
 * Combined source report across exactly the given org_ids (a Wingman's
 * assigned-branch cluster). Runs the existing org_admin-scoped query once per
 * org and merges in TS, adding a per-source "ALL BRANCHES" rollup row —
 * mirrors getTenantSourceReport's shape without using the tenant_admin RLS
 * bypass for a non-tenant-wide actor.
 */
export async function getMultiOrgSourceReport(
  orgIds: string[],
  userId: string,
  range?: DateRange,
): Promise<{ branches: SourceBranchRow[]; users: SourceUserRow[] }> {
  const tenantId = await resolveTenantId(orgIds[0]!);
  const perOrg = await Promise.all(orgIds.map((orgId) =>
    withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => ({
      branches: (await tx.execute(sourceBranchQuery(tenantId, orgId, range))) as Array<Record<string, unknown>>,
      users: (await tx.execute(sourceUserQuery(tenantId, orgId, range))) as Array<Record<string, unknown>>,
    })),
  ));
  const branchRows = perOrg.flatMap((p) => p.branches).map(toSourceBranchRow);
  const userRows = perOrg.flatMap((p) => p.users).map(toSourceUserRow);
  return { branches: [...branchRows, ...rollupSourceBranches(branchRows)], users: userRows };
}

/**
 * Active tenants entitled to LMS. Skipping non-LMS tenants keeps the job from
 * mailing an all-zeros report to an HR-only tenant.
 *
 * `entity.tenant_modules.module` is the entitlement key column ('lms').
 */
export async function listReportTenants(tenantIds: string[] | null) {
  return withServiceTx(async (tx) => {
    return (await tx.execute(sql`
      SELECT t.id::text AS tenant_id, t.name AS tenant_name
      FROM entity.tenants t
      WHERE t.is_active AND NOT t.is_deleted
        AND EXISTS (
          SELECT 1 FROM entity.tenant_modules tm
          WHERE tm.tenant_id = t.id AND tm.module = 'lms' AND tm.is_active
        )
        ${tenantIds && tenantIds.length > 0
          // One bound text param split server-side, so the id list can never be
          // concatenated into the statement even if a caller skips validation.
          ? sql`AND t.id = ANY(string_to_array(${tenantIds.join(',')}, ',')::uuid[])`
          : sql``}
      ORDER BY t.name
    `)) as Array<{ tenant_id: string; tenant_name: string }>;
  });
}

/**
 * Report recipients for one tenant: its tenant_admins, matched via their HOME
 * org (iam.users.org_id).
 *
 * Home org is sufficient because iam.auto_grant_all_orgs_on_tenant_admin
 * (db_scripts/02_schema.sql) guarantees a tenant_admin is mapped to every org in
 * exactly one tenant — there is no cross-tenant tenant_admin to miss.
 */
export async function listTenantAdminEmails(tenantId: string) {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT LOWER(u.email) AS email
      FROM iam.users u
      JOIN entity.organizations o ON o.id = u.org_id AND NOT o.is_deleted
      WHERE o.tenant_id = ${tenantId}::uuid
        AND u.platform_role = 'tenant_admin'
        AND u.is_active AND NOT u.is_deleted
        AND u.email IS NOT NULL AND u.email <> ''
      ORDER BY 1
    `)) as Array<{ email: string }>;
    return rows.map((r) => r.email);
  });
}

/**
 * Platform super_admins, deliberately NOT tenant-filtered and with no org join:
 * a super_admin's home org may sit in an unrelated tenant, and they are entitled
 * to every tenant's report. Loaded once per run, not per tenant.
 */
export async function listSuperAdminEmails() {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT LOWER(email) AS email
      FROM iam.users
      WHERE platform_role = 'super_admin'
        AND is_active AND NOT is_deleted
        AND email IS NOT NULL AND email <> ''
      ORDER BY 1
    `)) as Array<{ email: string }>;
    return rows.map((r) => r.email);
  });
}

/**
 * Tenant display name for the report header and subject.
 *
 * Read with the service role deliberately: the report views do not join
 * entity.tenants because neither app_user nor tenant_admin can SELECT it under
 * security_invoker (see the views' header comment in db_scripts/02_schema.sql).
 * root_service can, so the name is resolved here instead.
 */
export async function resolveTenantName(tenantId: string): Promise<string> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT name FROM entity.tenants WHERE id = ${tenantId}::uuid
    `)) as Array<{ name: string }>;
    return rows[0]?.name ?? 'Unknown tenant';
  });
}

/** One org id in the tenant, for the x-org-id audit header on the send call. */
export async function resolveAnyOrgIdForTenant(tenantId: string): Promise<string | null> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS org_id FROM entity.organizations
      WHERE tenant_id = ${tenantId}::uuid AND NOT is_deleted
      ORDER BY created_at LIMIT 1
    `)) as Array<{ org_id: string }>;
    return rows[0]?.org_id ?? null;
  });
}

/** tenant_id for one org — the job's inverse of resolveTenantId. */
export async function resolveTenantIdForOrg(orgId: string): Promise<string> {
  return resolveTenantId(orgId);
}
