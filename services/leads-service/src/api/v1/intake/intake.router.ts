import type { FastifyInstance } from 'fastify';
import { IntakeController } from './intake.controller.js';
import { authenticateInternal } from './intake.auth.js';

const ctrl = new IntakeController();

export async function intakeRouter(app: FastifyInstance) {
  // Internal service-to-service: called by meta-conversion-api, cron jobs, etc.
  app.post('/intake/webhook', { preHandler: [authenticateInternal] }, ctrl.webhook);

  // Scoped public/partner API (/public/v1/leads via gateway). The gateway
  // authenticates the API key; here we only require the internal secret and
  // trust the injected tenant/branch headers.
  app.post('/intake/public', { preHandler: [authenticateInternal] }, ctrl.publicApiLead);
}
