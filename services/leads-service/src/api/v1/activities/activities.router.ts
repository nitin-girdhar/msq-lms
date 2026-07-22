import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { CAPABILITY } from '@platform/rbac';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { ActivitiesController } from './activities.controller.js';

export async function activitiesRouter(app: FastifyInstance) {
  const ctrl = new ActivitiesController();

  app.get('/activities', { preHandler: [authenticate, requireCapability(CAPABILITY.LMS_HISTORY_VIEW), requireModule('lms')] }, ctrl.list);
}
