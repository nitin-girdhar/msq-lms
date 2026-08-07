import * as repo from './analytics.repository.js';
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

export async function getPipelineByStage(orgId: string, userId: string) {
  return repo.getPipelineByStage(orgId, userId);
}

// ── Daily lead report ───────────────────────────────────────────────────────

/** Tenant-wide callers get every branch + an ALL BRANCHES rollup; others one row. */
export async function getBranchReport(orgId: string, userId: string, isTenantWide: boolean) {
  if (isTenantWide) return repo.getTenantBranchReport(orgId, userId);
  return repo.getBranchReport(orgId, userId);
}

export async function getUserReport(orgId: string, userId: string, isTenantWide: boolean) {
  return repo.getUserReport(orgId, userId, isTenantWide);
}

export async function getSourceReport(orgId: string, userId: string, isTenantWide: boolean) {
  return repo.getSourceReport(orgId, userId, isTenantWide);
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
