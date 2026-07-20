import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createLeadSourceSchema, updateLeadSourceSchema , tenantScopedQuerySchema} from './lead-sources.schema.js';
import { LeadSourcesController } from './lead-sources.controller.js';

export async function leadSourcesRouter(app: FastifyInstance) {
  const ctrl = new LeadSourcesController();

  app.get('/lookups/lead-sources',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/lead-sources',      { preHandler: [authenticateSuperAdmin, validate({ body: createLeadSourceSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/lead-sources/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateLeadSourceSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
