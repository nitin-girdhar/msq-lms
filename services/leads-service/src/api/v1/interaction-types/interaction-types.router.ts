import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createInteractionTypeSchema, updateInteractionTypeSchema , tenantScopedQuerySchema} from './interaction-types.schema.js';
import { InteractionTypesController } from './interaction-types.controller.js';

export async function interactionTypesRouter(app: FastifyInstance) {
  const ctrl = new InteractionTypesController();

  app.get('/lookups/interaction-types',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/interaction-types',      { preHandler: [authenticateSuperAdmin, validate({ body: createInteractionTypeSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/interaction-types/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateInteractionTypeSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
