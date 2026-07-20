import type { SessionUser } from '@platform/types';

export const STATUS_CONFIG: Record<string, { bg: string; color: string; dot: string }> = {
  new:             { bg: '#EFF6FF', color: '#1D4ED8', dot: '#3B82F6' },
  contacting:      { bg: '#FFF7ED', color: '#C2410C', dot: '#F97316' },
  qualified:       { bg: '#FAF5FF', color: '#7E22CE', dot: '#A855F7' },
  converted:       { bg: '#F0FDF4', color: '#15803D', dot: '#22C55E' },
  unqualified:     { bg: '#FEF2F2', color: '#B91C1C', dot: '#EF4444' },
  transferred_out: { bg: '#FFFBEB', color: '#92400E', dot: '#F59E0B' },
};

export const CAN_ASSIGN_ROLES: ReadonlyArray<SessionUser['role']> = [
  'super_admin', 'tenant_admin', 'org_admin', 'org_sr_manager',
  'org_manager', 'senior_sales_executive',
];
