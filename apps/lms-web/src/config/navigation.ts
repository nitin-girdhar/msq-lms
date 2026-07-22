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
  { id: 'leads-history', label: 'Leads History', href: '/dashboard/leads-history', capability: CAPABILITY.LMS_HISTORY },
  { id: 'assignments',   label: 'Assignments',   href: '/dashboard/assignments',   capability: CAPABILITY.LMS_ASSIGNMENTS },
  { id: 'analytics',     label: 'Analytics',     href: '/dashboard/analytics',     capability: CAPABILITY.LMS_ANALYTICS },
  { id: 'users',         label: 'Users',         href: '/dashboard/users',         capability: CAPABILITY.LMS_USERS },
  { id: 'api-clients',   label: 'API Tokens',    href: '/dashboard/api-clients',   capability: CAPABILITY.LMS_APICLIENTS },
] as const;

/** The CRM nav entries this user may actually open. */
export function navItemsForActor(actor: SessionUser): NavItem[] {
  return filterNav(DASHBOARD_NAV, actor);
}
