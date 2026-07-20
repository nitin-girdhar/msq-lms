import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createAssignmentSchema, updateAssignmentSchema } from '@lms/validation';
import { listAssignmentsQuerySchema, leadsHistoryQuerySchema } from './assignments.schema.js';
import { AssignmentsController } from './assignments.controller.js';

export async function assignmentsRouter(app: FastifyInstance) {
  const ctrl = new AssignmentsController();
  const gate = [authenticate, requireModule('lms')] as const;

  app.get('/assignments',       { preHandler: [...gate, validate({ query: listAssignmentsQuerySchema })] }, ctrl.listAll);
  app.get('/assignments/mine',  { preHandler: [...gate, validate({ query: leadsHistoryQuerySchema })] }, ctrl.listMine);
  app.get('/assignments/:id',   { preHandler: [...gate] }, ctrl.getById);
  app.post('/assignments',      { preHandler: [...gate, validate({ body: createAssignmentSchema })] }, ctrl.create);
  app.patch('/assignments/:id', { preHandler: [...gate, validate({ body: updateAssignmentSchema })] }, ctrl.reassign);
  app.delete('/assignments/:id',{ preHandler: [...gate] }, ctrl.unassign);
}
