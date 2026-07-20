import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createFollowUpStatusSchema, updateFollowUpStatusSchema , tenantScopedQuerySchema} from './follow-up-statuses.schema.js';
import { FollowUpStatusesController } from './follow-up-statuses.controller.js';

export async function followUpStatusesRouter(app: FastifyInstance) {
  const ctrl = new FollowUpStatusesController();

  app.get('/lookups/follow-up-statuses',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/follow-up-statuses',      { preHandler: [authenticateSuperAdmin, validate({ body: createFollowUpStatusSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/follow-up-statuses/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateFollowUpStatusSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
