import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createCampaignStatusSchema, updateCampaignStatusSchema , tenantScopedQuerySchema} from './campaign-statuses.schema.js';
import { CampaignStatusesController } from './campaign-statuses.controller.js';

export async function campaignStatusesRouter(app: FastifyInstance) {
  const ctrl = new CampaignStatusesController();

  app.get('/lookups/campaign-statuses',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/campaign-statuses',      { preHandler: [authenticateSuperAdmin, validate({ body: createCampaignStatusSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/campaign-statuses/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateCampaignStatusSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
