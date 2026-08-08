// ─────────────────────────────────────────────────────────────────────────────
// Lead-source segmented shapes for the public report page (not the email —
// see public-report.render.ts). Same seven metrics as lead-report.types.ts,
// additionally split by lms.lead_sources. Always carries source_label (the
// tenant-facing display name) rather than the internal `name` slug or a bare
// source_id — the report must always show the label, per product requirement.
// ─────────────────────────────────────────────────────────────────────────────

import { toMetrics, str, type LeadReportMetrics } from './lead-report.types.js';

export interface SourceBranchRow extends LeadReportMetrics {
  tenant_id: string;
  /** NULL on the source's own "ALL BRANCHES" rollup row. */
  org_id: string | null;
  org_name: string;
  /** NULL = leads with no source_id recorded ("Unknown" bucket). */
  source_id: string | null;
  source_label: string;
  report_date: string;
  is_total: boolean;
}

export interface SourceUserRow extends LeadReportMetrics {
  tenant_id: string;
  org_id: string;
  org_name: string;
  assigned_user_id: string | null;
  assignee: string;
  /** NULL for the Unassigned bucket, which has no role. */
  role_label: string | null;
  is_unassigned: boolean;
  source_id: string | null;
  source_label: string;
  report_date: string;
}

function nullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function toSourceBranchRow(row: Record<string, unknown>): SourceBranchRow {
  return {
    ...toMetrics(row),
    tenant_id: str(row['tenant_id']),
    org_id: nullableId(row['org_id']),
    org_name: str(row['org_name'], '(unnamed branch)'),
    source_id: nullableId(row['source_id']),
    source_label: str(row['source_label'], 'Unknown'),
    report_date: str(row['report_date']).slice(0, 10),
    is_total: row['is_total'] === true,
  };
}

export function toSourceUserRow(row: Record<string, unknown>): SourceUserRow {
  const assignedUserId = nullableId(row['assigned_user_id']);
  return {
    ...toMetrics(row),
    tenant_id: str(row['tenant_id']),
    org_id: str(row['org_id']),
    org_name: str(row['org_name'], '(unnamed branch)'),
    assigned_user_id: assignedUserId,
    assignee: str(row['assignee'], 'Unassigned'),
    role_label: row['role_label'] == null ? null : String(row['role_label']),
    is_unassigned: row['is_unassigned'] === true || assignedUserId === null,
    source_id: nullableId(row['source_id']),
    source_label: str(row['source_label'], 'Unknown'),
    report_date: str(row['report_date']).slice(0, 10),
  };
}
