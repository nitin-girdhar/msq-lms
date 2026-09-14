import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { LeadAssignmentRerunController } from './lead-assignment-rerun.controller.js';
import { rerunBodySchema, rerunQuerySchema } from './lead-assignment-rerun.schema.js';

const ctrl = new LeadAssignmentRerunController();

// Super-admin console only (lookup-admin "Re-run auto-assignment"). The
// administered tenant arrives as ?tenant_id=, the N-6 contract every
// tenant-scoped lookup route in this service uses.
export async function leadAssignmentRerunRouter(app: FastifyInstance) {
  app.post(
    '/lead-assignment/rerun',
    { preHandler: [authenticateSuperAdmin, validate({ query: rerunQuerySchema, body: rerunBodySchema })] },
    ctrl.rerun,
  );
}
