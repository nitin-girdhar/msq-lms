import type { FastifyInstance } from 'fastify';
import { createLeadSchema, updateLeadSchema, createInteractionSchema, createFollowUpSchema, transferLeadSchema } from '@crm/validation';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { LeadsController } from './leads.controller.js';
import { FollowUpsController } from '../follow-ups/follow-ups.controller.js';
import { listLeadsQuerySchema } from './leads.schema.js';
import { updateFollowUpBodySchema } from '../follow-ups/follow-ups.schema.js';

const ctrl = new LeadsController();
const fuCtrl = new FollowUpsController();

export async function leadsRouter(app: FastifyInstance) {
  app.get('/leads', { preHandler: [authenticate, validate({ query: listLeadsQuerySchema })] }, ctrl.list);
  app.post('/leads', { preHandler: [authenticate, validate({ body: createLeadSchema })] }, ctrl.create);

  app.get('/follow-ups', { preHandler: [authenticate] }, ctrl.listFollowUps);

  app.get('/leads/:id', { preHandler: [authenticate] }, ctrl.getById);
  app.patch('/leads/:id', { preHandler: [authenticate, validate({ body: updateLeadSchema })] }, ctrl.update);
  app.delete('/leads/:id', { preHandler: [authenticate] }, ctrl.delete);

  app.post('/leads/:id/transfer', { preHandler: [authenticate, validate({ body: transferLeadSchema })] }, ctrl.transfer);

  app.get('/leads/:id/timeline', { preHandler: [authenticate] }, ctrl.getTimeline);
  app.get('/leads/:id/form-data', { preHandler: [authenticate] }, ctrl.getFormData);
  app.get('/leads/:id/interactions', { preHandler: [authenticate] }, ctrl.getInteractions);
  app.post('/leads/:id/interactions', { preHandler: [authenticate, validate({ body: createInteractionSchema })] }, ctrl.createInteraction);
  app.get('/leads/:id/assignment-history', { preHandler: [authenticate] }, ctrl.getAssignmentHistory);

  app.get('/leads/:id/follow-ups', { preHandler: [authenticate] }, ctrl.getFollowUps);
  app.post('/leads/:id/follow-ups', { preHandler: [authenticate, validate({ body: createFollowUpSchema })] }, fuCtrl.create);
  app.patch('/leads/:id/follow-ups/:follow_up_id', { preHandler: [authenticate, validate({ body: updateFollowUpBodySchema })] }, fuCtrl.update);
  app.delete('/leads/:id/follow-ups/:follow_up_id', { preHandler: [authenticate] }, fuCtrl.delete);

  app.get('/lookups/lead-stages', { preHandler: [authenticate] }, ctrl.getStageOptions);
  app.get('/lookups/lead-stage-outcomes', { preHandler: [authenticate] }, ctrl.getStageOutcomes);
}
