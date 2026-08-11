import { CAPABILITY } from '@platform/rbac';
import type { SessionUser } from '@platform/types';
import { filterNav, type NavItem } from '@platform/ui-kit/shell';

export type { NavItem };

// CRM top-rail nav. Each entry names the PAGE node it leads to, so the sidebar
// and the guard on the page behind it read the same capability — a link can no
// longer appear for someone the page will bounce.
//
// Tier C3: these were hard-coded ROLE_TIERS arrays. Besides needing a deploy to
// change, such a list can only name the roles the platform ships with — so any
// tenant-defined role (which iam.user_roles now allows) matched nothing and got
// an empty sidebar.
export const DASHBOARD_NAV: readonly NavItem[] = [
  { id: 'leads',         label: 'Leads',         href: '/dashboard/leads',         capability: CAPABILITY.LMS_LEADS },
  { id: 'follow-ups',    label: 'Follow-ups',    href: '/dashboard/follow-ups',    capability: CAPABILITY.LMS_FOLLOWUPS },
  { id: 'assignments',   label: 'Assignments',   href: '/dashboard/assignments',   capability: CAPABILITY.LMS_ASSIGNMENTS },
  // lms.leads.assign.bulk is an OPERATION with nothing beneath it (like
  // admin.roles.manage), so it needs `exact` — holdsUsableNode() would demand
  // a granted descendant and hide this for everyone, admins included.
  { id: 'bulk-assign',   label: 'Bulk Assign',   href: '/dashboard/bulk-assign',   capability: CAPABILITY.LMS_LEADS_ASSIGN_BULK, exact: true },
  { id: 'analytics',     label: 'Analytics',     href: '/dashboard/analytics',     capability: CAPABILITY.LMS_ANALYTICS },
  { id: 'leads-history', label: 'Leads History', href: '/dashboard/leads-history', capability: CAPABILITY.LMS_HISTORY },
  { id: 'users',         label: 'Users',         href: '/dashboard/users',         capability: CAPABILITY.LMS_USERS },
] as const;

/** The CRM nav entries this user may actually open. */
export function navItemsForActor(actor: SessionUser): NavItem[] {
  return filterNav(DASHBOARD_NAV, actor);
}

/**
 * Where to send someone who reached a CRM page they may not open.
 *
 * The first nav entry they CAN open, not a fixed path. Every guard used to
 * redirect to /dashboard/leads, which was safe only while leads itself was
 * ungated — now that it guards too, a role denied leads would bounce from one
 * denial into the same denial forever. /dashboard/no-access is the terminal
 * case: session-only, no capability gate, so it can never bounce again.
 */
export function fallbackPathForActor(actor: SessionUser): string {
  return navItemsForActor(actor)[0]?.href ?? '/dashboard/no-access';
}
