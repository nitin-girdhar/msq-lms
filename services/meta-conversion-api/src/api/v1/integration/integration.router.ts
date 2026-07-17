import type { FastifyInstance } from 'fastify';
import { getIntegration, createIntegration, updateIntegration } from './integration.controller.js';

export async function integrationRouter(app: FastifyInstance) {
  app.get('/integration', getIntegration);
  app.post('/integration', createIntegration);
  app.patch('/integration', updateIntegration);
}
