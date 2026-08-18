/**
 * Mirror of the leads-service LeadReportMetrics — 6 core metrics, one per
 * lms.lead_stage, one per non-'other' lms.lead_stage_outcome. Field order
 * matches the two report views and lms.lead_report_snapshot; keep it that way so
 * the two files diff cleanly against each other.
 *
 * Every metric is carried even though the Analytics screen renders a handful,
 * which is the point: adding a card or a table column is a UI-only change.
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

export interface UserReportRow extends LeadReportMetrics {
  tenant_id: string;
  org_id: string;
  org_name: string;
  assigned_user_id: string | null;
  assignee: string;
  assignee_email: string | null;
  is_unassigned: boolean;
  report_date: string;
}
