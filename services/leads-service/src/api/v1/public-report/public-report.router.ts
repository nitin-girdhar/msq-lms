import type { FastifyInstance } from 'fastify';
import { authenticateInternal } from '../intake/intake.auth.js';
import { PublicReportController } from './public-report.controller.js';

export async function publicReportRouter(app: FastifyInstance) {
  const ctrl = new PublicReportController();

  // Scoped public/partner API (/public/v1/lead-report via the gateway). The
  // gateway authenticates the API key (scope 'lead-report:read') and injects
  // the tenant/branch headers; here we only require the internal secret and
  // trust them, same pattern as /intake/public.
  app.get('/public/lead-report', { preHandler: [authenticateInternal] }, ctrl.getReport);
}
