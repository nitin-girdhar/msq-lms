import { sql } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@platform/db';
import { organizationsTable } from '@platform/db/schema';
import { eq } from 'drizzle-orm';
import { toBranchRow, toUserRow } from '../../../lib/reports/lead-report.types.js';
import type { BranchReportRow, TenantReport, UserReportRow } from '../../../lib/reports/lead-report.types.js';

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

export async function getPipelineByStage(orgId: string, userId: string) {
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT ls.name AS stage, ls.label AS stage_label, COUNT(ml.id)::INT AS count
      FROM lms.lead_stage ls
      LEFT JOIN lms.marketing_leads ml
        ON ml.stage_id = ls.id AND ml.org_id = ${orgId}::uuid AND NOT ml.is_deleted
      GROUP BY ls.id, ls.name, ls.label
      ORDER BY ls.sort_order
    `)) as Array<Record<string, unknown>>;
  });
}

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
      SUM(total_leads)::INT        AS total_leads,
      SUM(new_count)::INT          AS new_count,
      SUM(new_leads_today)::INT    AS new_leads_today,
      SUM(unassigned_count)::INT   AS unassigned_count,
      SUM(followup_scheduled)::INT AS followup_scheduled,
      SUM(followup_overdue)::INT   AS followup_overdue,
      SUM(converted_count)::INT    AS converted_count,
      SUM(unqualified_count)::INT  AS unqualified_count,
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
 * Writes one row per (org_id, assigned_user_id) bucket from `report.users`,
 * plus a synthetic all-zero row for any branch in `report.branches` that has
 * no user rows at all. A branch with zero leads produces no row in
 * lms.vw_lead_report_user (see its header comment in db_scripts/05_views.sql)
 * — without the synthetic row that branch would silently vanish from history
 * on a quiet day instead of showing a genuine zero, same distinction the live
 * branch view already makes.
 *
 * Idempotent (ON CONFLICT ... DO UPDATE): re-running for the same tenant/day
 * overwrites those rows rather than duplicating them.
 */
export async function upsertReportSnapshot(report: TenantReport): Promise<void> {
  return withServiceTx(async (tx) => {
    const coveredOrgIds = new Set(report.users.map((u) => u.org_id));

    for (const u of report.users) {
      await tx.execute(sql`
        INSERT INTO lms.lead_report_snapshot
          (tenant_id, org_id, org_name, assigned_user_id, assignee, is_unassigned, report_date,
           total_leads, new_count, new_leads_today, unassigned_count, followup_scheduled,
           followup_overdue, converted_count, unqualified_count)
        VALUES (
          ${report.tenant_id}::uuid, ${u.org_id}::uuid, ${u.org_name}, ${u.assigned_user_id}::uuid,
          ${u.assignee}, ${u.is_unassigned}, ${u.report_date}::date,
          ${u.total_leads}, ${u.new_count}, ${u.new_leads_today}, ${u.unassigned_count},
          ${u.followup_scheduled}, ${u.followup_overdue}, ${u.converted_count}, ${u.unqualified_count}
        )
        ON CONFLICT (tenant_id, org_id, assigned_user_id, report_date) DO UPDATE SET
          org_name = EXCLUDED.org_name, assignee = EXCLUDED.assignee, is_unassigned = EXCLUDED.is_unassigned,
          total_leads = EXCLUDED.total_leads, new_count = EXCLUDED.new_count,
          new_leads_today = EXCLUDED.new_leads_today, unassigned_count = EXCLUDED.unassigned_count,
          followup_scheduled = EXCLUDED.followup_scheduled, followup_overdue = EXCLUDED.followup_overdue,
          converted_count = EXCLUDED.converted_count, unqualified_count = EXCLUDED.unqualified_count,
          captured_at = CLOCK_TIMESTAMP()
      `);
    }

    for (const b of report.branches) {
      if (b.is_total || !b.org_id || coveredOrgIds.has(b.org_id)) continue;
      await tx.execute(sql`
        INSERT INTO lms.lead_report_snapshot
          (tenant_id, org_id, org_name, assigned_user_id, assignee, is_unassigned, report_date,
           total_leads, new_count, new_leads_today, unassigned_count, followup_scheduled,
           followup_overdue, converted_count, unqualified_count)
        VALUES (
          ${report.tenant_id}::uuid, ${b.org_id}::uuid, ${b.org_name}, NULL, 'Unassigned', TRUE, ${b.report_date}::date,
          0, 0, 0, 0, 0, 0, 0, 0
        )
        ON CONFLICT (tenant_id, org_id, assigned_user_id, report_date) DO UPDATE SET
          org_name = EXCLUDED.org_name, captured_at = CLOCK_TIMESTAMP()
      `);
    }
  });
}

/**
 * The prior day's (or any historical day's) report, reconstructed from
 * lms.lead_report_snapshot for the public report page's compare view.
 * `null` when nothing was recorded for that tenant/date — expected for any
 * day before the snapshot job first ran, not an error condition.
 *
 * Branch/rollup totals are derived with the same GROUPING SETS technique
 * tenantBranchReportQuery uses over live data (see its header comment) — the
 * snapshot table stores per-assignee rows only, never a separate branch total.
 */
export async function getSnapshotForDate(
  tenantId: string,
  date: string,
): Promise<{ branches: BranchReportRow[]; users: UserReportRow[] } | null> {
  return withServiceTx(async (tx) => {
    const users = (await tx.execute(sql`
      SELECT * FROM lms.lead_report_snapshot
      WHERE tenant_id = ${tenantId}::uuid AND report_date = ${date}::date
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
        SUM(total_leads)::INT        AS total_leads,
        SUM(new_count)::INT          AS new_count,
        SUM(new_leads_today)::INT    AS new_leads_today,
        SUM(unassigned_count)::INT   AS unassigned_count,
        SUM(followup_scheduled)::INT AS followup_scheduled,
        SUM(followup_overdue)::INT   AS followup_overdue,
        SUM(converted_count)::INT    AS converted_count,
        SUM(unqualified_count)::INT  AS unqualified_count
      FROM lms.lead_report_snapshot
      WHERE tenant_id = ${tenantId}::uuid AND report_date = ${date}::date
      GROUP BY GROUPING SETS ((org_id), ())
      ORDER BY GROUPING(org_id), MAX(org_name)
    `)) as Array<Record<string, unknown>>;

    return { branches: branches.map(toBranchRow), users: users.map(toUserRow) };
  });
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
