import { createApiClient } from '@platform/ui-kit';

// MyDayWidget is cross-product chrome: it surfaces task + leave counts on the LMS
// dashboard. Per docs/Phase5_Extraction_Plan.md N-3 it must NOT import @task/web or
// @hr/web — that product→sibling coupling is a cross-boundary edge the repo split
// would break. Instead it reads the same gateway endpoints those clients hit: the
// shared gateway entitlement-gates /tasks and /hr/* by route prefix (D6), and the
// widget only calls them when the module is enabled, treating a 403 as "omit the
// tile". Data access stays on the api.* pattern (no raw fetch in components).
const { request } = createApiClient('/api');

function endOfTodayISO(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

interface CountEnvelope {
  total: number;
}

export const myDayApi = {
  tasksDueToday: (assigneeId: string) => {
    const qs = new URLSearchParams({
      scope: 'own',
      assignee_id: assigneeId,
      include_completed: 'false',
      due_before: endOfTodayISO(),
      limit: '1',
    }).toString();
    return request<CountEnvelope>(`/tasks?${qs}`);
  },

  leaveTeamRequests: (params: { status: string; from?: string; to?: string }) => {
    const qs = new URLSearchParams({
      status: params.status,
      page: '1',
      limit: '1',
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
    }).toString();
    return request<CountEnvelope>(`/hr/leave/requests/team?${qs}`);
  },
};
