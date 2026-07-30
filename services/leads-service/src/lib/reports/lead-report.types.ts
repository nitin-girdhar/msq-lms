// ─────────────────────────────────────────────────────────────────────────────
// Shapes for the daily lead report.
//
// The seven metric columns are identical across the branch and user rows on
// purpose — one renderer draws both tables. The SQL casts every count to ::INT,
// but these rows come back through `tx.execute` as untyped records, so the
// renderer still coerces with Number() before formatting.
//
// Metric definitions live with the views in db_scripts/02_schema.sql
// (lms.vw_lead_report_branch / lms.vw_lead_report_user).
// ─────────────────────────────────────────────────────────────────────────────

/** The seven reported metrics, plus the total they are drawn from. */
export interface LeadReportMetrics {
  total_leads: number;
  new_count: number;
  new_leads_today: number;
  unassigned_count: number;
  followup_scheduled: number;
  followup_overdue: number;
  converted_count: number;
  unqualified_count: number;
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

const METRIC_KEYS = [
  'total_leads',
  'new_count',
  'new_leads_today',
  'unassigned_count',
  'followup_scheduled',
  'followup_overdue',
  'converted_count',
  'unqualified_count',
] as const satisfies ReadonlyArray<keyof LeadReportMetrics>;

function toMetrics(row: Record<string, unknown>): LeadReportMetrics {
  const out = {} as LeadReportMetrics;
  for (const key of METRIC_KEYS) out[key] = Number(row[key] ?? 0);
  return out;
}

function str(value: unknown, fallback = ''): string {
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
