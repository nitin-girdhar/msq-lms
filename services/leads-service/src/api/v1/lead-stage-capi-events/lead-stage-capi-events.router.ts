import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { tenantScopedQuerySchema, putMappingsSchema } from './lead-stage-capi-events.schema.js';
import { LeadStageCapiEventsController } from './lead-stage-capi-events.controller.js';

export async function leadStageCapiEventsRouter(app: FastifyInstance) {
  const ctrl = new LeadStageCapiEventsController();

  app.get('/lookups/lead-stage-capi-events', {
    preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })],
  }, ctrl.list);
  app.put('/lookups/lead-stage-capi-events', {
    preHandler: [authenticateSuperAdmin, validate({ body: putMappingsSchema, query: tenantScopedQuerySchema })],
  }, ctrl.put);
}
