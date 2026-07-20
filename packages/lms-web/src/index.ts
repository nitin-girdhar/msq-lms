// @lms/web — LMS (lead management) product package. Public surface: the
// page-level Shells that apps/web's `(lms)` route group renders, plus the
// few types/helpers a Server Component page needs before it can render one.
// Everything else (leaf components, hooks, the LMS api client) is internal —
// consumed via relative imports inside this package, not re-exported here.

export { default as LeadDashboardShell } from './components/dashboard/LeadDashboardShell';
export { default as FollowUpsShell } from './components/leads/FollowUpsShell';
export { default as LeadsHistoryShell } from './components/leads-history/LeadsHistoryShell';
export { default as AssignmentsClient } from './components/assignments/AssignmentsClient';
export { default as AnalyticsClient } from './components/analytics/AnalyticsClient';
export { LeadHistoryModal } from './components/LeadHistoryModal';

export type { AssignmentView, StageOption, StageOutcome, UpdatePayload } from './types/leads';
