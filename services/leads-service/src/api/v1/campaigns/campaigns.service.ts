import type { RoleTxContext } from '@platform/db';
import { NotFoundError } from '../../../lib/errors.js';
import * as repo from './campaigns.repository.js';
import type { CreateCampaignBody, UpdateCampaignBody } from './campaigns.schema.js';

export async function listCampaigns(ctx: RoleTxContext) {
  return repo.listCampaigns(ctx);
}

export async function getCampaignById(ctx: RoleTxContext, campaignId: string) {
  const campaign = await repo.getCampaignById(ctx, campaignId);
  if (!campaign) throw new NotFoundError('Campaign not found');
  return campaign;
}

export async function createCampaign(ctx: RoleTxContext, data: CreateCampaignBody) {
  return repo.createCampaign(ctx, data);
}

export async function updateCampaign(ctx: RoleTxContext, campaignId: string, data: UpdateCampaignBody) {
  const result = await repo.updateCampaign(ctx, campaignId, data);
  if (!result) throw new NotFoundError('Campaign not found');
  return result;
}

export async function deleteCampaign(ctx: RoleTxContext, campaignId: string) {
  return repo.deleteCampaign(ctx, campaignId);
}

export async function listMarketingPlatforms() {
  return repo.listMarketingPlatforms();
}

export async function listCampaignStatuses() {
  return repo.listCampaignStatuses();
}
