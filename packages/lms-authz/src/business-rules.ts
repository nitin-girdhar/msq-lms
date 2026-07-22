import { LMS_RANKS } from './ranks.js';
import { isTenantWideRole } from '@platform/authz';

// Cross-org / tenant-wide leads-history scope is a PLATFORM capability, not an
// LMS-rank one: the LMS scale tops out at lms_admin (80) and cannot express
// "sees every org in the tenant". Those tiers are keyed on platform_role
// (tenant_admin → tenant scope, super_admin → all) — passed in as `role`,
// which is platform_role in services and the session role in the web app (the
// 'tenant_admin'/'super_admin' literals are identical in both).
function isSuperAdmin(role: string): boolean {
  return role === 'super_admin';
}

// ─── Tenant-level rule overrides ───────────────────────────────────────────
// Keys are tenant_id values. Any tenant not listed here gets DEFAULT_RULES.
// Add new per-tenant overrides by spreading DEFAULT_RULES and changing fields.

export interface TenantBusinessRules {
  // ── Lead visibility ─────────────────────────────────────────────────────
  // Minimum rank to see leads that have no assigned user.
  // Roles below this rank see only their own assigned leads.
  minRankToViewUnassignedLeads: number;

  // ── Navigation & dashboard ──────────────────────────────────────────────
  // Minimum rank to see the "Unassigned" stat card on the leads dashboard.
  minRankForUnassignedCard: number;

  // Minimum rank to access the Analytics page.
  minRankForAnalytics: number;

  // Minimum rank to manage (create/edit) users.
  minRankToManageUsers: number;

  // Minimum rank to view the Users page.
  minRankToViewUsers: number;

  // ── Assignments ─────────────────────────────────────────────────────────
  // Minimum rank to assign / reassign leads.
  minRankToAssignLeads: number;

  // Minimum rank to delete a lead.
  minRankToDeleteLead: number;

  // Minimum rank to transfer a lead to another org within the tenant.
  minRankToTransferLead: number;

  // Minimum rank to create a lead (POST /leads).
  minRankToCreateLead: number;

  // Minimum rank to edit a lead — status change, note, reassign, interaction,
  // follow-up (PATCH/POST write routes). read_only (0) is below this floor, so
  // it can read every leads screen but cannot mutate anything.
  minRankToEditLead: number;

  // ── Leads History — "Assigned To" filter scope thresholds ───────────
  // These LMS-rank thresholds control the WITHIN-ORG tiers (team/org). The
  // cross-org tiers (tenant/all) are platform_role-driven, not rank-driven —
  // see getLeadsHistoryAssignedToScope. Below the team threshold the filter is
  // hidden and the backend forces self.
  minRankForLeadsHistoryTeamScope: number;
  minRankForLeadsHistoryOrgScope: number;
}

export type LeadsHistoryScope = 'none' | 'team' | 'org' | 'tenant' | 'all';

export const DEFAULT_RULES: TenantBusinessRules = {
  minRankToViewUnassignedLeads: LMS_RANKS.SSE,
  minRankForUnassignedCard:     LMS_RANKS.SSE,
  minRankForAnalytics:          LMS_RANKS.ADMIN,
  minRankToManageUsers:         LMS_RANKS.MANAGER,
  minRankToViewUsers:           LMS_RANKS.SSE,
  minRankToAssignLeads:         LMS_RANKS.SSE,
  minRankToDeleteLead:          LMS_RANKS.ADMIN,
  minRankToTransferLead:        LMS_RANKS.MANAGER,
  minRankToCreateLead:          LMS_RANKS.SE,
  minRankToEditLead:            LMS_RANKS.SE,
  minRankForLeadsHistoryTeamScope:   LMS_RANKS.SSE,
  minRankForLeadsHistoryOrgScope:    LMS_RANKS.ADMIN,
};

// ── FitClass tenant: same as defaults (baseline)
const FITCLASS_TENANT_ID = 'a1000000-0000-0000-0000-000000000001';

const TENANT_OVERRIDES: Record<string, Partial<TenantBusinessRules>> = {
  [FITCLASS_TENANT_ID]: {
    // Below SSE cannot see unassigned leads at all
    minRankToViewUnassignedLeads: LMS_RANKS.SSE,
    minRankForUnassignedCard:     LMS_RANKS.SSE,
  },
};

export function getRulesForTenant(tenantId: string): TenantBusinessRules {
  const overrides = TENANT_OVERRIDES[tenantId];
  if (!overrides) return DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...overrides };
}

// ── Convenience helpers (take tenant-resolved rules + actor rank) ────────

export function canViewUnassignedLeads(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToViewUnassignedLeads;
}

export function canSeeUnassignedCard(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankForUnassignedCard;
}

export function checkAnalyticsAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankForAnalytics;
}

export function checkManageUsersAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToManageUsers;
}

export function checkViewUsersAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToViewUsers;
}

export function checkAssignLeadsAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToAssignLeads;
}

export function checkDeleteLeadAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToDeleteLead;
}

export function checkTransferLeadAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToTransferLead;
}

export function checkCreateLeadAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToCreateLead;
}

export function checkEditLeadAccess(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankToEditLead;
}

// `role` is platform_role (services) / session role (web). The cross-org tiers
// (all/tenant) are platform-driven; the within-org tiers (org/team) are LMS-rank.
export function getLeadsHistoryAssignedToScope(
  rules: TenantBusinessRules,
  rank: number,
  role: string,
): LeadsHistoryScope {
  if (isSuperAdmin(role)) return 'all';
  if (isTenantWideRole(role)) return 'tenant';
  if (rank >= rules.minRankForLeadsHistoryOrgScope) return 'org';
  if (rank >= rules.minRankForLeadsHistoryTeamScope) return 'team';
  return 'none';
}

export function canSeeAssignedToFilter(rules: TenantBusinessRules, rank: number): boolean {
  return rank >= rules.minRankForLeadsHistoryTeamScope;
}
