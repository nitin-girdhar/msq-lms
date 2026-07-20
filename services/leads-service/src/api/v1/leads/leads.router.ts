import type { FastifyInstance } from 'fastify';
import { createLeadSchema, updateLeadSchema, createInteractionSchema, createFollowUpSchema, transferLeadSchema } from '@lms/validation';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { LeadsController } from './leads.controller.js';
import { FollowUpsController } from '../follow-ups/follow-ups.controller.js';
import { listLeadsQuerySchema } from './leads.schema.js';
import { updateFollowUpBodySchema } from '../follow-ups/follow-ups.schema.js';

const ctrl = new LeadsController();
const fuCtrl = new FollowUpsController();

// LMS routes require the 'lms' product entitlement (defense-in-depth behind the
// gateway). The /lookups/* reads stay ungated — shared lookups, ungated at the
// gateway too — so the leads UI can resolve labels regardless of gate ordering.
export async function leadsRouter(app: FastifyInstance) {
  const gate = [authenticate, requireModule('lms')] as const;

  app.get('/leads', { preHandler: [...gate, validate({ query: listLeadsQuerySchema })] }, ctrl.list);
  app.post('/leads', { preHandler: [...gate, validate({ body: createLeadSchema })] }, ctrl.create);

  app.get('/follow-ups', { preHandler: [...gate] }, ctrl.listFollowUps);

  app.get('/leads/:id', { preHandler: [...gate] }, ctrl.getById);
  app.patch('/leads/:id', { preHandler: [...gate, validate({ body: updateLeadSchema })] }, ctrl.update);
  app.delete('/leads/:id', { preHandler: [...gate] }, ctrl.delete);

  app.post('/leads/:id/transfer', { preHandler: [...gate, validate({ body: transferLeadSchema })] }, ctrl.transfer);

  app.get('/leads/:id/timeline', { preHandler: [...gate] }, ctrl.getTimeline);
  app.get('/leads/:id/form-data', { preHandler: [...gate] }, ctrl.getFormData);
  app.get('/leads/:id/interactions', { preHandler: [...gate] }, ctrl.getInteractions);
  app.post('/leads/:id/interactions', { preHandler: [...gate, validate({ body: createInteractionSchema })] }, ctrl.createInteraction);
  app.get('/leads/:id/assignment-history', { preHandler: [...gate] }, ctrl.getAssignmentHistory);

  app.get('/leads/:id/follow-ups', { preHandler: [...gate] }, ctrl.getFollowUps);
  app.post('/leads/:id/follow-ups', { preHandler: [...gate, validate({ body: createFollowUpSchema })] }, fuCtrl.create);
  app.patch('/leads/:id/follow-ups/:follow_up_id', { preHandler: [...gate, validate({ body: updateFollowUpBodySchema })] }, fuCtrl.update);
  app.delete('/leads/:id/follow-ups/:follow_up_id', { preHandler: [...gate] }, fuCtrl.delete);

  app.get('/lookups/lead-stages', { preHandler: [authenticate] }, ctrl.getStageOptions);
  app.get('/lookups/lead-stage-outcomes', { preHandler: [authenticate] }, ctrl.getStageOutcomes);
}
