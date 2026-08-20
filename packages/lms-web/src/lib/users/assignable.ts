import type { SessionUser } from '@platform/types';

/**
 * Normalise a `GET /users/assignable` row into a `SessionUser`.
 *
 * The endpoint returns the DB column names — `full_name`, `role_name` — while
 * `SessionUser` declares `name` and `role`. The two are close enough that a bare
 * `as SessionUser[]` cast compiles, so the mismatch was invisible to TypeScript
 * and surfaced only in the UI: every assignee picker fell through its
 * `name ? name : email` fallback and listed raw email addresses.
 *
 * `assignable()` is typed `data: unknown[]` precisely so callers map rather than
 * cast. This is that mapping, in one place — the three pickers that show
 * assignees must agree on how a person is labelled.
 */
export function toAssignableUsers(raw: unknown): SessionUser[] {
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return rows.map((u) => ({
    ...u,
    id: (u['id'] ?? '') as string,
    email: (u['email'] ?? '') as string,
    name: (u['full_name'] ?? u['name'] ?? '') as string,
    role: (u['role_name'] ?? u['role'] ?? '') as SessionUser['role'],
    role_label: (u['role_label'] ?? '') as string,
    rank: Number(u['rank'] ?? 0),
    org_id: (u['org_id'] ?? '') as string,
    org_name: '',
    tenant_id: '',
    tenant_name: '',
    manager_id: null,
    manager_name: null,
    last_login_at: null,
  })) as SessionUser[];
}

/**
 * How a person is labelled in an assignee list: their name, falling back to the
 * email only when there is genuinely no name to show.
 */
export function displayName(u: Pick<SessionUser, 'name' | 'email'>): string {
  const name = (u.name ?? '').trim();
  return name || u.email;
}
