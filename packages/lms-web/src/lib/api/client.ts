import { createApiClient } from '@platform/ui-kit';

// The generic fetch wrapper lives in @platform/ui-kit; the cross-product
// `orgs`/`users` namespaces also live there (see @platform/ui-kit's
// src/api/resources.ts). Everything below is LMS (lead management) domain
// knowledge and stays in this package.
const { request } = createApiClient('/api');

// ── Leads ────────────────────────────────────────────────────────────────────

export interface LeadsListParams {
  status?: string;
  assigned_to?: string;
  assigned_user_id?: string;
  campaign_id?: string;
  search?: string;
  platforms?: string;
  org_ids?: string;
  page?: number;
  page_size?: number;
}

export const leads = {
  list: (params: LeadsListParams = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ),
    ).toString();
    return request<{
      success: true;
      data: import('../../types/leads').LeadView[];
      total: number;
      page: number;
      page_size: number;
      stage_options: unknown[];
      stage_outcomes: unknown[];
    }>(`/leads${qs ? `?${qs}` : ''}`);
  },

  get: (id: string) =>
    request<{ success: true; data: import('../../types/leads').LeadView }>(`/leads/${id}`),

  create: (data: Record<string, unknown>) =>
    request<{ success: true; data: { id: string } }>('/leads', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<void>(`/leads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/leads/${id}`, { method: 'DELETE' }),

  getTimeline: (id: string) =>
    request<{ success: true; data: unknown[] }>(`/leads/${id}/timeline`),

  getFormData: (id: string) =>
    request<{ success: true; data: import('../../types/leads').LeadFormData }>(`/leads/${id}/form-data`),

  getInteractions: (id: string) =>
    request<{ success: true; data: unknown[] }>(`/leads/${id}/interactions`),

  addInteraction: (id: string, data: Record<string, unknown>) =>
    request<{ success: true; data: unknown }>(`/leads/${id}/interactions`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getFollowUps: (id: string) =>
    request<{ success: true; data: unknown[] }>(`/leads/${id}/follow-ups`),

  addFollowUp: (id: string, data: Record<string, unknown>) =>
    request<{ success: true; data: unknown }>(`/leads/${id}/follow-ups`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateFollowUp: (lead_id: string, follow_up_id: string, data: Record<string, unknown>) =>
    request<void>(`/leads/${lead_id}/follow-ups/${follow_up_id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getAssignmentHistory: (id: string) =>
    request<{ success: true; data: unknown[] }>(`/leads/${id}/assignment-history`),

  transfer: (id: string, data: { target_org_id: string; notes?: string }) =>
    request<{ success: true; data: { sourceLeadId: string; newLeadId: string } }>(`/leads/${id}/transfer`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// ── Assignments ───────────────────────────────────────────────────────────────

export const assignments = {
  list: () => request<{ success: true; data: unknown[]; total: number; page: number; page_size: number }>('/assignments'),

  get: (id: string) => request<{ success: true; data: unknown }>(`/assignments/${id}`),

  create: (data: { lead_id: string; assigned_to: string; branch?: string; notes?: string }) =>
    request<{ success: true; data: unknown }>('/assignments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { assigned_to: string; notes?: string }) =>
    request<void>(`/assignments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  remove: (id: string) =>
    request<void>(`/assignments/${id}`, { method: 'DELETE' }),

  leadsHistory: (params: Record<string, string | number | boolean | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ),
    ).toString();
    return request<{
      success: true;
      data: import('../../types/leads').LeadView[];
      total: number;
      page: number;
      page_size: number;
      stage_options: unknown[];
      stage_outcomes: unknown[];
    }>(`/assignments/mine${qs ? `?${qs}` : ''}`);
  },
};

// ── Campaigns ─────────────────────────────────────────────────────────────────

export const campaigns = {
  list: () => request<{ success: true; data: unknown[] }>('/campaigns'),

  get: (id: string) => request<{ success: true; data: unknown }>(`/campaigns/${id}`),

  create: (data: { name: string; platform_name: string; status_name?: string; budget?: number; started_at?: string; ended_at?: string }) =>
    request<{ success: true; data: { id: string } }>('/campaigns', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<void>(`/campaigns/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/campaigns/${id}`, { method: 'DELETE' }),
};

// ── Lead Sources ─────────────────────────────────────────────────────────────

export const lead_sources = {
  list: () => request<{ success: true; data: Array<{ id: string; name: string }> }>('/lead-sources'),
};

// ── Lookups (lead-form data: stages, stage outcomes, cities) ─────────────────

export const lookups = {
  leadStages: () => request<{ success: true; data: unknown[] }>('/lookups/lead-stages'),
  leadStageOutcomes: (stage_id?: string) =>
    request<{ success: true; data: unknown[] }>(`/lookups/lead-stage-outcomes${stage_id !== undefined ? `?stage_id=${stage_id}` : ''}`),
  all: () => request<{ success: true; data: { platforms: unknown[]; interaction_types: unknown[]; sources: unknown[]; stages: unknown[]; campaign_statuses: unknown[] } }>('/lookups'),
  cities: (state_id?: number) =>
    request<{ success: true; data: unknown[] }>(`/lookups/cities${state_id !== undefined ? `?state_id=${state_id}` : ''}`),
};

// ── Locations (country/state/city filter options) ────────────────────────────

export const locations = {
  list: (params: { level?: string; countryIds?: string; stateIds?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ),
    ).toString();
    return request<{ success: true; data: unknown[] }>(`/locations${qs ? `?${qs}` : ''}`);
  },
};

// ── Analytics ─────────────────────────────────────────────────────────────────

export const analytics = {
  dashboard: () => request<{ success: true; data: unknown }>('/analytics/dashboard'),
  campaigns: () => request<{ success: true; data: unknown[] }>('/analytics/dashboard/campaigns'),
  performance: () => request<{ success: true; data: unknown }>('/analytics/performance'),
  pipeline: () => request<{ success: true; data: unknown[] }>('/analytics/pipeline'),
};

// ── Activities ────────────────────────────────────────────────────────────────

export const activities = {
  list: () => request<{ success: true; data: unknown[] }>('/activities'),
};

// ── Follow-Ups ───────────────────────────────────────────────────────────────

export const followUps = {
  list: (params: { assignedRepId?: string; overdueOnly?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ),
    ).toString();
    return request<{ success: true; data: unknown[]; pipeline?: unknown[] }>(`/follow-ups${qs ? `?${qs}` : ''}`);
  },
};
