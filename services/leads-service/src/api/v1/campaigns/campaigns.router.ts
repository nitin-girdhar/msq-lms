import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { CAPABILITY } from '@platform/rbac';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { CampaignsController } from './campaigns.controller.js';
import { createCampaignBodySchema, updateCampaignBodySchema } from './campaigns.schema.js';

const ctrl = new CampaignsController();

export async function campaignsRouter(app: FastifyInstance) {
  const gate = [authenticate, requireModule('lms')] as const;

  app.get('/campaigns', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_VIEW)] }, ctrl.list);
  app.get('/campaigns/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_VIEW)] }, ctrl.getById);
  app.post('/campaigns', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_MANAGE, 'Only admins can create campaigns'), validate({ body: createCampaignBodySchema })] }, ctrl.create);
  app.patch('/campaigns/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_MANAGE, 'Only admins can update campaigns'), validate({ body: updateCampaignBodySchema })] }, ctrl.update);
  app.delete('/campaigns/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_MANAGE, 'Only admins can delete campaigns')] }, ctrl.delete);

  app.get('/campaigns/platforms', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_VIEW)] }, ctrl.listPlatforms);
  app.get('/campaigns/statuses', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_CAMPAIGNS_VIEW)] }, ctrl.listStatuses);
}
