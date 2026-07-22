export { hasRole, hasMinimumRole, hasAnyRole } from '@platform/authz';
// The web session carries the global sales-ladder rank; its user/lead gates use
// the sales tiers (SSE/MANAGER/ADMIN), which now live in @lms/authz's LMS_RANKS.
// Re-exported as RANKS so existing web consumers (e.g. StatsCards) keep working.
export { LMS_RANKS as RANKS } from '@lms/authz';
export type { SessionUser, UserRole } from '@platform/types';

import { ROLE_RANK } from '@platform/auth-constants';
import type { SessionUser, UserRole } from '@platform/types';
import { LMS_RANKS as RANKS } from '@lms/authz';

export function canManageUsers(user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return user.rank >= RANKS.MANAGER;
}

export function canManageUsersView(user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return user.rank >= RANKS.SSE;
}

export function canCreateUser(actorRank: number, targetRank: number): boolean {
  if (actorRank < RANKS.MANAGER) return false;
  return actorRank > targetRank;
}

export function canViewUser(
  actor: SessionUser | null | undefined,
  target: { id: string; rank: number },
): boolean {
  if (!actor) return false;
  if (actor.rank >= RANKS.ADMIN) return true;
  if (target.id === actor.id) return true;
  if (target.rank >= RANKS.ADMIN) return false;
  if (actor.rank >= RANKS.MANAGER) return true;
  if (actor.rank === RANKS.SSE) return target.rank <= RANKS.SE;
  return false;
}

export function canAssignLeads(user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return user.rank >= RANKS.MANAGER;
}

export function canViewAnalytics(user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return user.rank >= RANKS.ADMIN;
}

export function canManageApiClients(user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return user.rank >= RANKS.ADMIN;
}

// Re-export ROLE_RANK for callers that need the full map
export { ROLE_RANK };

// Alias for monolith-compat
export function hasMinimumRoleByName(
  user: SessionUser | null | undefined,
  min: UserRole,
): boolean {
  if (!user) return false;
  return user.rank >= ROLE_RANK[min];
}
