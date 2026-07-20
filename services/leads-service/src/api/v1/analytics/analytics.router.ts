import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { AnalyticsController } from './analytics.controller.js';

export async function analyticsRouter(app: FastifyInstance) {
  const ctrl = new AnalyticsController();
  const gate = [authenticate, requireModule('lms')] as const;

  app.get('/analytics/dashboard',           { preHandler: [...gate] }, ctrl.getDashboard);
  app.get('/analytics/dashboard/campaigns', { preHandler: [...gate] }, ctrl.getCampaignSummary);
  app.get('/analytics/performance',         { preHandler: [...gate] }, ctrl.getPerformance);
  app.get('/analytics/pipeline',            { preHandler: [...gate] }, ctrl.getPipeline);
}
