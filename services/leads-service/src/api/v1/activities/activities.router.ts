import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { CAPABILITY } from '@platform/rbac';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { ActivitiesController } from './activities.controller.js';

export async function activitiesRouter(app: FastifyInstance) {
  const ctrl = new ActivitiesController();

  // The feed is branch-wide (every user's actions), so it takes the org-wide
  // history rung — the capability that replaced the old `rank < ADMIN` check in
  // the controller (capabilities, not ranks, are the authorization boundary).
  app.get('/activities', {
    preHandler: [
      authenticate,
      requireCapability(CAPABILITY.LMS_HISTORY_VIEW),
      requireCapability(CAPABILITY.LMS_HISTORY_VIEW_ORG, 'You do not have access to the activity feed'),
      requireModule('lms'),
    ],
  }, ctrl.list);
}
