import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createAssignmentSchema, updateAssignmentSchema } from '@crm/validation';
import { listAssignmentsQuerySchema, leadsHistoryQuerySchema } from './assignments.schema.js';
import { AssignmentsController } from './assignments.controller.js';

export async function assignmentsRouter(app: FastifyInstance) {
  const ctrl = new AssignmentsController();

  app.get('/assignments',       { preHandler: [authenticate, validate({ query: listAssignmentsQuerySchema })] }, ctrl.listAll);
  app.get('/assignments/mine',  { preHandler: [authenticate, validate({ query: leadsHistoryQuerySchema })] }, ctrl.listMine);
  app.get('/assignments/:id',   { preHandler: [authenticate] }, ctrl.getById);
  app.post('/assignments',      { preHandler: [authenticate, validate({ body: createAssignmentSchema })] }, ctrl.create);
  app.patch('/assignments/:id', { preHandler: [authenticate, validate({ body: updateAssignmentSchema })] }, ctrl.reassign);
  app.delete('/assignments/:id',{ preHandler: [authenticate] }, ctrl.unassign);
}
