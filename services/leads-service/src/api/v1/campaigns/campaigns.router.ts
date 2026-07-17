import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { CampaignsController } from './campaigns.controller.js';
import { createCampaignBodySchema, updateCampaignBodySchema } from './campaigns.schema.js';

const ctrl = new CampaignsController();

export async function campaignsRouter(app: FastifyInstance) {
  app.get('/campaigns', { preHandler: [authenticate] }, ctrl.list);
  app.get('/campaigns/:id', { preHandler: [authenticate] }, ctrl.getById);
  app.post('/campaigns', { preHandler: [authenticate, validate({ body: createCampaignBodySchema })] }, ctrl.create);
  app.patch('/campaigns/:id', { preHandler: [authenticate, validate({ body: updateCampaignBodySchema })] }, ctrl.update);
  app.delete('/campaigns/:id', { preHandler: [authenticate] }, ctrl.delete);

  app.get('/campaigns/platforms', { preHandler: [authenticate] }, ctrl.listPlatforms);
  app.get('/campaigns/statuses', { preHandler: [authenticate] }, ctrl.listStatuses);
}
