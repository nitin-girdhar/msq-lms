import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createLeadStageSchema, updateLeadStageSchema , tenantScopedQuerySchema} from './lead-stage.schema.js';
import { LeadStageController } from './lead-stage.controller.js';

export async function leadStageRouter(app: FastifyInstance) {
  const ctrl = new LeadStageController();

  app.get('/lookups/lead-stage',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/lead-stage',      { preHandler: [authenticateSuperAdmin, validate({ body: createLeadStageSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/lead-stage/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateLeadStageSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
