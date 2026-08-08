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
    request<{ success: true; data: { user: import('@platform/types').SessionUser } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, org_id }),
    }),

  logout: () => request<{ success: true; data: null }>('/auth/logout', { method: 'POST' }),

  myOrgs: () =>
    request<{ success: true; data: { orgs: import('@platform/types').UserOrgOption[] } }>('/auth/my-orgs'),

  switchOrg: (org_id: string) =>
    request<{ success: true; data: { user: import('@platform/types').SessionUser } }>('/auth/switch-org', {
      method: 'POST',
      body: JSON.stringify({ org_id }),
    }),

  me: () => request<{ success: true; data: { user: import('@platform/types').SessionUser } }>('/auth/me'),

  changePassword: (current_password: string, new_password: string) =>
    request<{ success: true; data: null }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
};

