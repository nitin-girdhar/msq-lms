import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import {
  createLmsRoleSchema,
  updateLmsRoleSchema,
  tenantScopedQuerySchema,
} from './lms-roles.schema.js';
import { LmsRolesController } from './lms-roles.controller.js';

export async function lmsRolesRouter(app: FastifyInstance) {
  const ctrl = new LmsRolesController();

  app.get('/lookups/lms-roles', { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/lms-roles', {
    preHandler: [authenticateSuperAdmin, validate({ body: createLmsRoleSchema, query: tenantScopedQuerySchema })],
  }, ctrl.create);
  app.patch('/lookups/lms-roles/:id', {
    preHandler: [authenticateSuperAdmin, validate({ body: updateLmsRoleSchema, query: tenantScopedQuerySchema })],
  }, ctrl.update);
}
