import { createApiClient } from '@platform/ui-kit';

// The generic fetch wrapper (error normalization, credentials, JSON handling)
// lives in @platform/ui-kit, as do the cross-product `orgs`/`users` namespaces
// (see `@platform/ui-kit`'s `src/api/resources.ts`). Everything below this line
// is platform-chrome-only (auth session, API token admin) — product domain
// namespaces (leads, leave, tasks, ...) live in their own `@<product>/web`
// package's api client.
const { request } = createApiClient('/api');

// ── Auth ─────────────────────────────────────────────────────────────────────

export const auth = {
  login: (email: string, password: string, org_id?: string) =>
    request<{ success: true; data: { user: import('@crm/types').SessionUser } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, org_id }),
    }),

  logout: () => request<{ success: true; data: null }>('/auth/logout', { method: 'POST' }),

  myOrgs: () =>
    request<{ success: true; data: { orgs: import('@crm/types').UserOrgOption[] } }>('/auth/my-orgs'),

  switchOrg: (org_id: string) =>
    request<{ success: true; data: { user: import('@crm/types').SessionUser } }>('/auth/switch-org', {
      method: 'POST',
      body: JSON.stringify({ org_id }),
    }),

  me: () => request<{ success: true; data: { user: import('@crm/types').SessionUser } }>('/auth/me'),

  changePassword: (current_password: string, new_password: string) =>
    request<{ success: true; data: null }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
};

// ── API Clients (public API token management) ──────────────────────────────

export interface ApiClientView {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  org_ids: string[];
  scope_all_orgs: boolean;
  rate_limit_per_min: number;
  is_active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export const apiClients = {
  list: () => request<{ success: true; data: ApiClientView[] }>('/api-clients'),

  create: (data: Record<string, unknown>) =>
    request<{ success: true; data: ApiClientView & { api_key: string } }>('/api-clients', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ success: true; data: ApiClientView }>(`/api-clients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  rotate: (id: string) =>
    request<{ success: true; data: ApiClientView & { api_key: string } }>(`/api-clients/${id}/rotate`, {
      method: 'POST',
    }),

  revoke: (id: string) =>
    request<void>(`/api-clients/${id}`, { method: 'DELETE' }),
};
