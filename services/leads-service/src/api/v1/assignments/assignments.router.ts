import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { CAPABILITY } from '@platform/rbac';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createAssignmentSchema, updateAssignmentSchema } from '@lms/validation';
import { listAssignmentsQuerySchema, leadsHistoryQuerySchema } from './assignments.schema.js';
import { AssignmentsController } from './assignments.controller.js';

export async function assignmentsRouter(app: FastifyInstance) {
  const ctrl = new AssignmentsController();
  const gate = [authenticate, requireModule('lms')] as const;

  app.get('/assignments',       { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ASSIGNMENTS_VIEW), validate({ query: listAssignmentsQuerySchema })] }, ctrl.listAll);
  app.get('/assignments/mine',  { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ASSIGNMENTS_VIEW), validate({ query: leadsHistoryQuerySchema })] }, ctrl.listMine);
  app.get('/assignments/:id',   { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ASSIGNMENTS_VIEW)] }, ctrl.getById);
  app.post('/assignments',      { preHandler: [...gate, requireCapability(CAPABILITY.LMS_LEADS_ASSIGN, 'You do not have permission to assign leads'), validate({ body: createAssignmentSchema })] }, ctrl.create);
  app.patch('/assignments/:id', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ASSIGNMENTS_EDIT, 'You do not have permission to edit assignments'), validate({ body: updateAssignmentSchema })] }, ctrl.reassign);
  app.delete('/assignments/:id',{ preHandler: [...gate, requireCapability(CAPABILITY.LMS_ASSIGNMENTS_DELETE, 'You do not have permission to delete assignments')] }, ctrl.unassign);
}
