export { hasRole, hasMinimumRole, hasAnyRole } from '@platform/authz';
// The web session carries the global sales-ladder rank; its user/lead gates use
// the sales tiers (SSE/MANAGER/ADMIN), which now live in @lms/authz's LMS_RANKS.
// Re-exported as RANKS so existing web consumers (e.g. StatsCards) keep working.
export { LMS_RANKS as RANKS } from '@lms/authz';
export type { SessionUser, UserRole } from '@platform/types';

import { ROLE_RANK } from '@platform/auth-constants';
import { LMS_RANKS as RANKS } from '@lms/authz';

// ── What used to live here ──────────────────────────────────────────────────
// Tier C3 removed a family of rank predicates from this file — canViewAnalytics,
// canManageApiClients, canManageUsersView, canViewUser, canAssignLeads,
// canManageUsers, hasMinimumRoleByName. Every one of them asked "is this rank
// high enough", which can only describe the ladder the platform ships with; a
// tenant-defined role matched none of them. Page access now resolves through
// @lms/authz's canOpenX() against the capability matrix, and the "New user"
// affordance through checkManageUsersAccess(). Most had no call sites at all by
// the time they were removed — the inline `session.rank < RANKS.ADMIN` checks in
// the page files were doing the work, and those are gone too.

/**
 * May an actor of `actorRank` create a user holding `targetRank`?
 *
 * Deliberately still RANK-based, and not a candidate for a capability. This is
 * a SENIORITY question — "is A far enough up the ladder to mint someone at B" —
 * and the answer depends on the ordering of two ranks, which a boolean grant
 * cannot express. Same reasoning as @lms/authz's canAssignToUser.
 *
 * Authority to be on the Users screen at all is a capability (lms.users.manage,
 * checked upstream). This only decides how far down that authority reaches.
 */
export function canCreateUser(actorRank: number, targetRank: number): boolean {
  if (actorRank < RANKS.MANAGER) return false;
  return actorRank > targetRank;
}

// Re-export ROLE_RANK for callers that need the full map
export { ROLE_RANK };
