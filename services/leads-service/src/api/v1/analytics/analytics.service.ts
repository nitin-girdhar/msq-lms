import * as repo from './analytics.repository.js';
import type { DateRange } from './analytics.repository.js';
import { buildTenantReport, sendTenantReport } from '../../../lib/reports/lead-report.mailer.js';

export async function getDashboard(orgId: string, userId: string, isTenantWide: boolean) {
  if (isTenantWide) return repo.getTenantDashboard(orgId, userId);
  return repo.getOrgPerformanceSnapshot(orgId, userId);
}

export async function getCampaignSummary(orgId: string, userId: string) {
  return repo.getTenantCampaignSummary(orgId, userId);
}

export async function getPerformanceSnapshot(orgId: string, userId: string) {
  return repo.getOrgPerformanceSnapshot(orgId, userId);
}

export async function getPipelineByStage(orgId: string, userId: string, range?: DateRange) {
  return repo.getPipelineByStage(orgId, userId, range);
}

// ── Daily lead report ───────────────────────────────────────────────────────

/**
 * A non-tenant-wide caller's actual branch scope: their single home org, or —
 * if iam.user_org_mapping maps them to more than one org (e.g. a Fitclass
 * "Wingman", role org_manager) — that full org_id list. Tenant-wide callers
 * never need this; they already get every org via the tenant_admin RLS path.
 */
async function resolveScopeOrgIds(orgId: string, userId: string): Promise<string[]> {
  const orgIds = await repo.getUserOrgIds(userId);
  return orgIds.length > 1 ? orgIds : [orgId];
}

/** Tenant-wide callers get every branch + an ALL BRANCHES rollup; multi-branch
 * callers (Wingmen) get their assigned branches + a rollup; others one row.
 *
 * With a `range`, the view-backed queries can't be used at all —
 * lms.vw_lead_report_branch has no date bound — so the branch rows are summed
 * out of the date-filtered source rows instead. Each scope keeps its own RLS
 * path: a Wingman still goes per-org via getMultiOrgSourceReport rather than
 * borrowing the tenant_admin transaction. One visible consequence: the source
 * queries don't zero-fill, so a branch with no leads in the window disappears
 * rather than showing a row of zeroes. */
export async function getBranchReport(orgId: string, userId: string, isTenantWide: boolean, range?: DateRange) {
  if (range) {
    const source = isTenantWide
      ? await repo.getSourceReport(orgId, userId, true, range)
      : await (async () => {
        const orgIds = await resolveScopeOrgIds(orgId, userId);
        return orgIds.length > 1
          ? repo.getMultiOrgSourceReport(orgIds, userId, range)
          : repo.getSourceReport(orgId, userId, false, range);
      })();
    return repo.rollupBranchesFromSources(source.branches);
  }

  if (isTenantWide) return repo.getTenantBranchReport(orgId, userId);
  const orgIds = await resolveScopeOrgIds(orgId, userId);
  return orgIds.length > 1 ? repo.getMultiOrgBranchReport(orgIds, userId) : repo.getBranchReport(orgId, userId);
}

export async function getUserReport(orgId: string, userId: string, isTenantWide: boolean) {
  if (isTenantWide) return repo.getUserReport(orgId, userId, true);
  const orgIds = await resolveScopeOrgIds(orgId, userId);
  return orgIds.length > 1 ? repo.getMultiOrgUserReport(orgIds, userId) : repo.getUserReport(orgId, userId, false);
}

export async function getSourceReport(orgId: string, userId: string, isTenantWide: boolean, range?: DateRange) {
  if (isTenantWide) return repo.getSourceReport(orgId, userId, true, range);
  const orgIds = await resolveScopeOrgIds(orgId, userId);
  return orgIds.length > 1
    ? repo.getMultiOrgSourceReport(orgIds, userId, range)
    : repo.getSourceReport(orgId, userId, false, range);
}

/**
 * On-demand send of the same email the cron job sends, to the caller's tenant
 * admins. Tenant-wide access is enforced in the controller.
 */
export async function sendReportNow(orgId: string, userId: string, to?: string[]) {
  const tenantId = await repo.resolveTenantIdForOrg(orgId);
  const report = await buildTenantReport(tenantId);
  const recipients = to?.length ? to : await repo.listTenantAdminEmails(tenantId);
  return sendTenantReport(report, recipients, [], { tenantId, orgId, userId, throwOnError: true });
}
