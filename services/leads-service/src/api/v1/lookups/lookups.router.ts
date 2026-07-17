import type { FastifyInstance } from 'fastify';
import { LookupsController } from './lookups.controller.js';
import { authenticate } from '../../../middleware/auth.middleware.js';

const ctrl = new LookupsController();

export async function lookupsRouter(app: FastifyInstance) {
  app.get('/lookups', { preHandler: [authenticate] }, ctrl.getLookups);
  app.get('/lookups/cities', { preHandler: [authenticate] }, ctrl.getCities);
  app.get('/locations', { preHandler: [authenticate] }, ctrl.getLocations);
}
