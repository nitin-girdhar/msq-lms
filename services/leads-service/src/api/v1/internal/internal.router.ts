import type { FastifyInstance } from 'fastify';
import { validate } from '../../../middleware/validate.middleware.js';
import { authenticateInternal } from './internal.auth.js';
import { reassignOrgLeadsSchema, knownContactsSchema } from './internal.schema.js';
import { InternalController } from './internal.controller.js';

const ctrl = new InternalController();

export async function internalRouter(app: FastifyInstance) {
  // Called by identity-service's user branch-move/deactivation flow (N-5) — leads
  // are LMS-owned data, so identity invokes leads-service rather than writing
  // lms.marketing_leads directly.
  app.post(
    '/internal/leads/reassign-org',
    { preHandler: [authenticateInternal, validate({ body: reassignOrgLeadsSchema })] },
    ctrl.reassignOrgLeads,
  );

  // Called by api-gateway's public-comms recipient guard (P-1) — the gateway is
  // shared and cannot read lms.marketing_leads itself, so it asks leads-service
  // whether a (normalized) email/phone belongs to an existing lead in the tenant.
  app.post(
    '/internal/leads/known-contacts',
    { preHandler: [authenticateInternal, validate({ body: knownContactsSchema })] },
    ctrl.knownContacts,
  );
}
