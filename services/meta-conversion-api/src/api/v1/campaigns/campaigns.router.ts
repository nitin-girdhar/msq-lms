import type { FastifyInstance } from 'fastify';
import { listCampaigns, syncCampaigns, confirmCampaign } from './campaigns.controller.js';

export async function campaignsRouter(app: FastifyInstance) {
  app.get('/campaigns', listCampaigns);
  app.post('/campaigns/sync', syncCampaigns);
  app.patch('/campaigns/:metaCampaignId', confirmCampaign);
}
