import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { ActivitiesController } from './activities.controller.js';

export async function activitiesRouter(app: FastifyInstance) {
  const ctrl = new ActivitiesController();

  app.get('/activities', { preHandler: [authenticate, requireModule('lms')] }, ctrl.list);
}
