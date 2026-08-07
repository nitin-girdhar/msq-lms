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
  org_id: string | null;
  org_name: string;
  report_date: string;
  is_total: boolean;
}

export interface SourceBranchRow extends LeadReportMetrics {
  tenant_id: string;
  org_id: string | null;
  org_name: string;
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
  is_unassigned: boolean;
  source_id: string | null;
  source_label: string;
  report_date: string;
}
