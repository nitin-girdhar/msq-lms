import type { SessionUser } from '@platform/types';

/**
 * The branch filter branch-scoped LMS screens (Leads, Follow-ups) send, derived
 * from the navbar branch switcher's choice for this session.
 *
 * - "All branches" (session.all_branches) → undefined: no narrowing, so the
 *   server returns every branch the actor's lms.leads.view scope reaches.
 * - A specific branch → [session org]: the grids follow the switcher.
 *
 * Advisory only. The server decides reach: an actor without a tenant/all scope
 * is pinned to their session org whatever this returns.
 */
export function sessionBranchFilter(actor: SessionUser): string[] | undefined {
  return actor.all_branches ? undefined : [actor.org_id];
}

/** Label for the branch context the screen is showing. */
export function sessionBranchLabel(actor: SessionUser): string {
  return actor.all_branches ? 'All Branches' : actor.org_name;
}
