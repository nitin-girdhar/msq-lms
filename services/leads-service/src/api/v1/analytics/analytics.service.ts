import * as repo from './analytics.repository.js';

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
