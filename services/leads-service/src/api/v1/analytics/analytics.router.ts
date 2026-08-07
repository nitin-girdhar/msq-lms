import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { CAPABILITY } from '@platform/rbac';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { AnalyticsController } from './analytics.controller.js';

export async function analyticsRouter(app: FastifyInstance) {
  const ctrl = new AnalyticsController();
  const gate = [authenticate, requireModule('lms')] as const;

  app.get('/analytics/dashboard',           { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getDashboard);
  app.get('/analytics/dashboard/campaigns', { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getCampaignSummary);
  app.get('/analytics/performance',         { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getPerformance);
  app.get('/analytics/pipeline',            { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getPipeline);

  // Daily lead report. Reuses LMS_ANALYTICS_VIEW rather than introducing a new
  // capability: capabilities are DB-seeded (07_seed_lookup_data.sql, plus the
  // per-role grant/deny arrays), so a new one would need a re-seed of every
  // deployment before the route worked anywhere.
  app.get('/analytics/report/branches',     { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getBranchReport);
  app.get('/analytics/report/users',        { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getUserReport);
  app.get('/analytics/report/sources',      { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.getSourceReport);
  app.post('/analytics/report/send',        { preHandler: [...gate, requireCapability(CAPABILITY.LMS_ANALYTICS_VIEW, 'Access restricted to administrators')] }, ctrl.sendReportNow);
}
