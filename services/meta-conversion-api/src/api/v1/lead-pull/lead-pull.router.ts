import type { FastifyInstance } from 'fastify';
import {
  listCampaigns,
  createRun,
  getRun,
  getLatestRun,
  listRunLeads,
  applyPullRun,
} from './lead-pull.controller.js';

// GET /meta/pages already exists (pages.router.ts) and serves the page picker
// for this screen too — it is not rebuilt here.
export async function leadPullRouter(app: FastifyInstance) {
  app.get('/lead-pull/campaigns', listCampaigns);
  app.post('/lead-pull/runs', createRun);
  // Static segment, so Fastify matches it ahead of /runs/:runId regardless of
  // order; registered first anyway so the intent reads top-down.
  app.get('/lead-pull/runs/latest', getLatestRun);
  app.get('/lead-pull/runs/:runId', getRun);
  app.get('/lead-pull/runs/:runId/leads', listRunLeads);
  app.post('/lead-pull/runs/:runId/apply', applyPullRun);
}
