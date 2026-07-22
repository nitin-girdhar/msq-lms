import type { FastifyInstance } from 'fastify';
import { createLeadSchema, updateLeadSchema, createInteractionSchema, createFollowUpSchema, transferLeadSchema } from '@lms/validation';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { CAPABILITY } from '@platform/rbac';
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

  app.get('/leads', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_VIEW), validate({ query: listLeadsQuerySchema })] }, ctrl.list);
  app.post('/leads', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_CREATE, 'You do not have permission to create leads'), validate({ body: createLeadSchema })] }, ctrl.create);

  app.get('/follow-ups', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_FOLLOWUPS_VIEW)] }, ctrl.listFollowUps);

  app.get('/leads/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_VIEW)] }, ctrl.getById);
  app.patch('/leads/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_EDIT, 'Insufficient permissions to edit leads'), validate({ body: updateLeadSchema })] }, ctrl.update);
  app.delete('/leads/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_DELETE, 'You do not have permission to delete leads')] }, ctrl.delete);

  app.post('/leads/:id/transfer', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_TRANSFER, 'You do not have permission to transfer leads'), validate({ body: transferLeadSchema })] }, ctrl.transfer);

  app.get('/leads/:id/timeline', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_TIMELINE_VIEW)] }, ctrl.getTimeline);
  app.get('/leads/:id/form-data', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_VIEW)] }, ctrl.getFormData);
  app.get('/leads/:id/interactions', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_VIEW)] }, ctrl.getInteractions);
  app.post('/leads/:id/interactions', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_INTERACTION_LOG, 'You do not have permission to log interactions'), validate({ body: createInteractionSchema })] }, ctrl.createInteraction);
  app.get('/leads/:id/assignment-history', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_TIMELINE_VIEW)] }, ctrl.getAssignmentHistory);

  app.get('/leads/:id/follow-ups', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_FOLLOWUPS_VIEW)] }, ctrl.getFollowUps);
  app.post('/leads/:id/follow-ups', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_FOLLOWUPS_CREATE, 'You do not have permission to create follow-ups'), validate({ body: createFollowUpSchema })] }, fuCtrl.create);
  app.patch('/leads/:id/follow-ups/:follow_up_id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_FOLLOWUPS_EDIT, 'You do not have permission to edit follow-ups'), validate({ body: updateFollowUpBodySchema })] }, fuCtrl.update);
  app.delete('/leads/:id/follow-ups/:follow_up_id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_FOLLOWUPS_DELETE, 'You do not have permission to delete follow-ups')] }, fuCtrl.delete);

  app.get('/lookups/lead-stages', { preHandler: [authenticate] }, ctrl.getStageOptions);
  app.get('/lookups/lead-stage-outcomes', { preHandler: [authenticate] }, ctrl.getStageOutcomes);
}
