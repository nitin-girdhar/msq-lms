import type { FastifyInstance } from 'fastify';
import { authenticateInternal } from '../internal/internal.auth.js';
import { PublicReadController } from './public-read.controller.js';

// Public read endpoints for the partner API. The gateway has already
// authenticated the API key and enforced the scope; here we only require the
// internal secret and read the tenant/branch from the injected headers.
export async function publicReadRouter(app: FastifyInstance) {
  const ctrl = new PublicReadController();

  app.get('/public/leads/:id', { preHandler: [authenticateInternal] }, ctrl.getLead);
}
