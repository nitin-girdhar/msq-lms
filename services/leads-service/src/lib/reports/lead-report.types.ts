// ─────────────────────────────────────────────────────────────────────────────
// Shapes for the daily lead report.
//
// The metric columns are identical across the branch and user rows on purpose —
// one renderer draws both tables. The SQL casts every count to ::INT, but these
// rows come back through `tx.execute` as untyped records, so the renderer still
// coerces with Number() before formatting.
//
// Metric definitions live with the views in db_scripts/05_views.sql
// (lms.vw_lead_report_branch / lms.vw_lead_report_user); read that header before
// adding or changing one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 29 reported metrics: 6 core, one per lms.lead_stage, one per non-'other'
 * lms.lead_stage_outcome. Order matters and is mirrored exactly by METRIC_KEYS
 * below and by the SQL — see that constant's comment.
 */
export interface LeadReportMetrics {
  // core
  total_leads: number;
  unassigned_count: number;
  followup_scheduled: number;
  followup_overdue: number;
  new_leads_today: number;
  new_leads_this_month: number;
  // per lms.lead_stage.name, in sort_order
  new_count: number;
  contacting_count: number;
  on_hold_count: number;
  qualified_count: number;
  converted_count: number;
  unqualified_count: number;
  transferred_out_count: number;
  // per lms.lead_stage_outcome.name, grouped by parent stage
  //   contacting
  oc_not_connected_count: number;
  oc_switch_off_count: number;
  oc_not_answered_count: number;
  oc_call_back_later_count: number;
  //   on_hold
  oc_on_hold_count: number;
  //   qualified
  oc_visit_scheduled_count: number;
  oc_visited_count: number;
  //   converted
  oc_membership_sold_count: number;
  //   unqualified
  oc_no_response_after_multiple_attempts_count: number;
  oc_wrong_number_count: number;
  oc_job_applicant_count: number;
  oc_budget_issue_count: number;
  oc_not_interested_count: number;
  oc_location_issue_count: number;
  oc_duplicate_lead_count: number;
  //   transferred_out
  oc_transferred_to_other_branch_count: number;
}

export interface BranchReportRow extends LeadReportMetrics {
  tenant_id: string;
  /** NULL on the rollup row produced by GROUPING SETS. */
  org_id: string | null;
  org_name: string;
  org_timezone: string | null;
  report_date: string;
  /** True on the single "ALL BRANCHES" rollup row. */
  is_total: boolean;
}

export interface UserReportRow extends LeadReportMetrics {
  tenant_id: string;
  org_id: string;
  org_name: string;
  assigned_user_id: string | null;
  /** 'Unassigned' when assigned_user_id is NULL. */
  assignee: string;
  assignee_email: string | null;
  is_unassigned: boolean;
  report_date: string;
}

export interface TenantReport {
  tenant_id: string;
  tenant_name: string;
  /** The branches' local date; taken from the rollup row. */
  report_date: string;
  branches: BranchReportRow[];
  users: UserReportRow[];
}

/**
 * The metric column order, and the single source of truth for it in this
 * service. analytics.repository.ts GENERATES its SUM lists, INSERT column
 * lists and ON CONFLICT DO UPDATE clauses from this array, so a metric added
 * here reaches all seven of those query sites at once.
 *
 * This must stay in lock-step, in the same order, with:
 *   lms.vw_lead_report_branch   (db_scripts/05_views.sql)
 *   lms.vw_lead_report_user     (db_scripts/05_views.sql)
 *   lms.lead_report_snapshot    (db_scripts/02_tables_core.sql)
 */
export const METRIC_KEYS = [
  // core
  'total_leads',
  'unassigned_count',
  'followup_scheduled',
  'followup_overdue',
  'new_leads_today',
  'new_leads_this_month',
  // per lms.lead_stage.name, in sort_order
  'new_count',
  'contacting_count',
  'on_hold_count',
  'qualified_count',
  'converted_count',
  'unqualified_count',
  'transferred_out_count',
  // per lms.lead_stage_outcome.name, grouped by parent stage
  //   contacting
  'oc_not_connected_count',
  'oc_switch_off_count',
  'oc_not_answered_count',
  'oc_call_back_later_count',
  //   on_hold
  'oc_on_hold_count',
  //   qualified
  'oc_visit_scheduled_count',
  'oc_visited_count',
  //   converted
  'oc_membership_sold_count',
  //   unqualified
  'oc_no_response_after_multiple_attempts_count',
  'oc_wrong_number_count',
  'oc_job_applicant_count',
  'oc_budget_issue_count',
  'oc_not_interested_count',
  'oc_location_issue_count',
  'oc_duplicate_lead_count',
  //   transferred_out
  'oc_transferred_to_other_branch_count',
] as const satisfies ReadonlyArray<keyof LeadReportMetrics>;

/**
 * A LeadReportMetrics with every metric at 0 — the base for any rollup summed
 * in TypeScript rather than by the database. Derived from METRIC_KEYS so a new
 * metric can never be left out of a rollup and silently report 0.
 */
export function zeroMetrics(): LeadReportMetrics {
  const out = {} as LeadReportMetrics;
  for (const key of METRIC_KEYS) out[key] = 0;
  return out;
}

/** Exported for source-report.types.ts's normalizers — same raw-row shape, one extra grouping dimension. */
export function toMetrics(row: Record<string, unknown>): LeadReportMetrics {
  const out = {} as LeadReportMetrics;
  for (const key of METRIC_KEYS) out[key] = Number(row[key] ?? 0);
  return out;
}

export function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

/** Normalises a raw `lms.vw_lead_report_branch` / rollup record. */
export function toBranchRow(row: Record<string, unknown>): BranchReportRow {
  return {
    ...toMetrics(row),
    tenant_id: str(row['tenant_id']),
    org_id: row['org_id'] === null || row['org_id'] === undefined ? null : String(row['org_id']),
    org_name: str(row['org_name'], '(unnamed branch)'),
    org_timezone: row['org_timezone'] === null || row['org_timezone'] === undefined
      ? null
      : String(row['org_timezone']),
    report_date: str(row['report_date']).slice(0, 10),
    is_total: row['is_total'] === true || row['org_id'] === null || row['org_id'] === undefined,
  };
}

/** Normalises a raw `lms.vw_lead_report_user` record. */
export function toUserRow(row: Record<string, unknown>): UserReportRow {
  const assignedUserId = row['assigned_user_id'] === null || row['assigned_user_id'] === undefined
    ? null
    : String(row['assigned_user_id']);
  return {
    ...toMetrics(row),
    tenant_id: str(row['tenant_id']),
    org_id: str(row['org_id']),
    org_name: str(row['org_name'], '(unnamed branch)'),
    assigned_user_id: assignedUserId,
    assignee: str(row['assignee'], 'Unassigned'),
    assignee_email: row['assignee_email'] === null || row['assignee_email'] === undefined
      ? null
      : String(row['assignee_email']),
    is_unassigned: row['is_unassigned'] === true || assignedUserId === null,
    report_date: str(row['report_date']).slice(0, 10),
  };
}
