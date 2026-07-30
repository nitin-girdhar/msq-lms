import type { FastifyInstance } from 'fastify';
import { CAPABILITY } from '@platform/rbac';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { ReportsController } from './reports.controller.js';

// ── Report builder routes ─────────────────────────────────────────────────────
// Mounted under /analytics/reports so the gateway's productForRoute() already maps
// them to 'lms' — no change to msq-core/services/api-gateway/src/lib/product-map.ts.
//
// requireCapability guards the ENDPOINT. It does NOT guard the dataset: one route
// serves every dataset in the registry, so @platform/reporting checks each
// dataset's own capability and each field's on top of this (see
// assertDatasetPermitted). Both gates are needed.
//
// Row scoping is separate again, and rides on the existing leads ladder
// (lms.leads.view.own/.team/.org) via the dataset's scopeOperation — so a rep sees
// exactly the leads in a report that they see in the list.

export async function reportsRouter(app: FastifyInstance) {
  const ctrl = new ReportsController();
  const gate = [authenticate, requireModule('lms')] as const;
  const view = requireCapability(CAPABILITY.LMS_REPORTS_VIEW, 'You do not have access to reports');

  app.get('/analytics/reports/datasets',      { preHandler: [...gate, view] }, ctrl.listDatasets);
  app.get('/analytics/reports/datasets/:key', { preHandler: [...gate, view] }, ctrl.getDataset);
  app.post('/analytics/reports/query',        { preHandler: [...gate, view] }, ctrl.runQuery);
}
