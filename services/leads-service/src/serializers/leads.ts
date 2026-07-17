export interface LeadView {
  lead_id: string;
  org_id: string;
  org_name: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address_line1: string | null;
  city: string | null;
  city_name: string | null;
  state_name: string | null;
  country_name: string | null;
  stage: string;
  stage_label: string;
  source: string | null;
  followup_required: boolean;
  is_rejected: boolean;
  is_terminated: boolean;
  outcome: string | null;
  outcome_label: string | null;
  outcome_comment: string | null;
  stage_id: string;
  outcome_id: string | null;
  scheduled_at: string | null;
  is_followup_overdue: boolean;
  campaign_name: string | null;
  platform: string | null;
  assigned_rep_name: string | null;
  assigned_rep_email: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  assigned_user_id: string | null;
  campaign_id: string | null;
  is_deleted: boolean;
}

export function toLeadView(row: Record<string, unknown>): LeadView {
  return {
    lead_id: String(row['lead_id'] ?? ''),
    org_id: String(row['org_id'] ?? ''),
    org_name: String(row['org_name'] ?? ''),
    first_name: String(row['first_name'] ?? ''),
    middle_name: row['middle_name'] ? String(row['middle_name']) : null,
    last_name: String(row['last_name'] ?? ''),
    full_name: String(row['full_name'] ?? ''),
    phone: row['phone'] ? String(row['phone']) : null,
    email: row['email'] ? String(row['email']) : null,
    address_line1: row['address_line1'] ? String(row['address_line1']) : null,
    city: row['city'] ? String(row['city']) : null,
    city_name: row['city_name'] ? String(row['city_name']) : null,
    state_name: row['state_name'] ? String(row['state_name']) : null,
    country_name: row['country_name'] ? String(row['country_name']) : null,
    stage: String(row['stage'] ?? ''),
    stage_label: String(row['stage_label'] ?? ''),
    source: row['source'] ? String(row['source']) : null,
    followup_required: Boolean(row['followup_required']),
    is_rejected: Boolean(row['is_rejected']),
    is_terminated: Boolean(row['is_terminated']),
    outcome: row['outcome'] ? String(row['outcome']) : null,
    outcome_label: row['outcome_label'] ? String(row['outcome_label']) : null,
    outcome_comment: row['outcome_comment'] ? String(row['outcome_comment']) : null,
    stage_id: String(row['stage_id'] ?? ''),
    outcome_id: row['outcome_id'] != null ? String(row['outcome_id']) : null,
    scheduled_at: row['scheduled_at'] ? String(row['scheduled_at']) : null,
    is_followup_overdue: Boolean(row['is_followup_overdue']),
    campaign_name: row['campaign_name'] ? String(row['campaign_name']) : null,
    platform: row['platform'] ? String(row['platform']) : null,
    assigned_rep_name: row['assigned_rep_name'] ? String(row['assigned_rep_name']) : null,
    assigned_rep_email: row['assigned_rep_email'] ? String(row['assigned_rep_email']) : null,
    tags: Array.isArray(row['tags']) ? (row['tags'] as string[]) : [],
    created_at: String(row['created_at'] ?? ''),
    updated_at: String(row['updated_at'] ?? ''),
    assigned_user_id: row['assigned_user_id'] ? String(row['assigned_user_id']) : null,
    campaign_id: row['campaign_id'] ? String(row['campaign_id']) : null,
    is_deleted: Boolean(row['is_deleted']),
  };
}
