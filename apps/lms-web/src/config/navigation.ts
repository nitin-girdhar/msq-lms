import type { UserRole } from '@crm/auth-constants';
import { ROLE_TIERS } from '@crm/auth-constants';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  roles: readonly UserRole[];
}

const ADMIN_ROLES = ROLE_TIERS.ADMIN;
const MANAGER_ROLES = ROLE_TIERS.MANAGER;
const SSE_ROLES = ROLE_TIERS.SSE;
const SE_ROLES = ROLE_TIERS.SE;
const READ_ONLY_ROLES = ROLE_TIERS.READ_ONLY;

export const DASHBOARD_NAV: readonly NavItem[] = [
  {
    id: 'leads',
    label: 'Leads',
    href: '/dashboard/leads',
    roles: [...ADMIN_ROLES, ...MANAGER_ROLES, ...SSE_ROLES, ...SE_ROLES, ...READ_ONLY_ROLES],
  },
  {
    id: 'follow-ups',
    label: 'Follow-ups',
    href: '/dashboard/follow-ups',
    roles: [...ADMIN_ROLES, ...MANAGER_ROLES, ...SSE_ROLES, ...SE_ROLES],
  },
  {
    id: 'leads-history',
    label: 'Leads History',
    href: '/dashboard/leads-history',
    roles: [...ADMIN_ROLES, ...MANAGER_ROLES, ...SSE_ROLES, ...SE_ROLES],
  },
  {
    id: 'assignments',
    label: 'Assignments',
    href: '/dashboard/assignments',
    roles: [...ADMIN_ROLES, ...MANAGER_ROLES, ...SSE_ROLES],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    href: '/dashboard/analytics',
    roles: [...ADMIN_ROLES],
  },
  {
    id: 'users',
    label: 'Users',
    href: '/dashboard/users',
    roles: [...ADMIN_ROLES, ...MANAGER_ROLES, ...SSE_ROLES],
  },
  {
    id: 'api-clients',
    label: 'API Tokens',
    href: '/dashboard/api-clients',
    roles: [...ADMIN_ROLES],
  },
] as const;

export function navItemsForRole(role: UserRole): NavItem[] {
  return DASHBOARD_NAV.filter((item) => item.roles.includes(role));
}
