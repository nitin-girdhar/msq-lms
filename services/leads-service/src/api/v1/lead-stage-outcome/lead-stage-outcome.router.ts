import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createLeadStageOutcomeSchema, updateLeadStageOutcomeSchema , tenantScopedQuerySchema} from './lead-stage-outcome.schema.js';
import { LeadStageOutcomeController } from './lead-stage-outcome.controller.js';

export async function leadStageOutcomeRouter(app: FastifyInstance) {
  const ctrl = new LeadStageOutcomeController();

  app.get('/lookups/lead-stage-outcome',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/lead-stage-outcome',      { preHandler: [authenticateSuperAdmin, validate({ body: createLeadStageOutcomeSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/lead-stage-outcome/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateLeadStageOutcomeSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
