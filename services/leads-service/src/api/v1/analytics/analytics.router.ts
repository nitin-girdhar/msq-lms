import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { AnalyticsController } from './analytics.controller.js';

export async function analyticsRouter(app: FastifyInstance) {
  const ctrl = new AnalyticsController();

  app.get('/analytics/dashboard',           { preHandler: [authenticate] }, ctrl.getDashboard);
  app.get('/analytics/dashboard/campaigns', { preHandler: [authenticate] }, ctrl.getCampaignSummary);
  app.get('/analytics/performance',         { preHandler: [authenticate] }, ctrl.getPerformance);
  app.get('/analytics/pipeline',            { preHandler: [authenticate] }, ctrl.getPipeline);
}
