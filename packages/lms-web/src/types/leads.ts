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
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  is_deleted: boolean;
  assigned_user_id: string | null;
  campaign_id: string | null;
}

// Raw form submission captured at intake (e.g. Meta lead-gen ads), normalized
// into displayable question/answer pairs by GET /leads/:id/form-data.
export interface LeadFormDataField {
  key: string;
  label: string;
  value: string;
}

export interface LeadFormData {
  submitted_at: string | Date | null;
  fields: LeadFormDataField[];
}

export interface AssignmentView {
  id: string;
  lead_id: string;
  lead_full_name: string | null;
  lead_phone: string | null;
  lead_email: string | null;
  lead_stage: string | null;
  lead_stage_label: string | null;
  lead_stage_outcome: string | null;
  lead_stage_outcome_label: string | null;
  lead_created_at: string;
  is_terminated: boolean;
  branch: string;
  org_id: string;
  assigned_to: string;
  assigned_rep_name: string | null;
  assigned_rep_email: string | null;
  assigned_rep_role: string | null;
  assigned_at: string;
  is_active: boolean;
  superseded_by: string | null;
}

export interface StatsData {
  total: number;
  lastUpdated: Date | null;
}

export interface UpdatePayload {
  leadId: string;
  field: 'stage' | 'comments';
  value: string;
  followUp?: {
    assignedUserId: string;
    scheduledAt: string;
    notes?: string | null;
  };
  outcomeId?: string;
  outcomeComment?: string;
  transitionNote?: string;
  // The updated_at the editor opened with. Sent as expected_updated_at so a
  // concurrent edit is rejected with 409 instead of silently overwritten.
  expectedUpdatedAt?: string;
}

export interface StageOption {
  id: string;
  name: string;
  label: string;
  followup_required: boolean;
  is_rejected: boolean;
  is_terminated: boolean;
  sort_order: number;
}

export interface StageOutcome {
  id: string;
  name: string;
  label: string;
  stage_id: string;
  requires_comment: boolean;
  sort_order: number;
}
