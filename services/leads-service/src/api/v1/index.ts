import type { FastifyInstance } from 'fastify';
import { leadsRouter } from './leads/leads.router.js';
import { campaignsRouter } from './campaigns/campaigns.router.js';
import { lookupsRouter } from './lookups/lookups.router.js';
import { intakeRouter } from './intake/intake.router.js';
import { activitiesRouter } from './activities/activities.router.js';
import { assignmentsRouter } from './assignments/assignments.router.js';
import { analyticsRouter } from './analytics/analytics.router.js';
import { internalRouter } from './internal/internal.router.js';
// Tenant-scoped lookup/role admin (N-6): super_admin manages LMS reference data
// within a selected tenant. Moved here from admin-service so the write executes
// in the schema-owning service under tenant RLS (never root_service). Half A =
// lms-roles; Half B = the 7 lms/marketing marketing lookups below.
import { lmsRolesRouter } from './lms-roles/lms-roles.router.js';
import { leadStageRouter } from './lead-stage/lead-stage.router.js';
import { leadStageOutcomeRouter } from './lead-stage-outcome/lead-stage-outcome.router.js';
import { interactionTypesRouter } from './interaction-types/interaction-types.router.js';
import { followUpStatusesRouter } from './follow-up-statuses/follow-up-statuses.router.js';
import { leadSourcesRouter } from './lead-sources/lead-sources.router.js';
import { marketingPlatformsRouter } from './marketing-platforms/marketing-platforms.router.js';
import { campaignStatusesRouter } from './campaign-statuses/campaign-statuses.router.js';

export async function v1Router(app: FastifyInstance) {
  await app.register(leadsRouter);
  await app.register(campaignsRouter);
  await app.register(lookupsRouter);
  await app.register(intakeRouter);
  await app.register(activitiesRouter);
  await app.register(assignmentsRouter);
  await app.register(analyticsRouter);
  await app.register(internalRouter);
  await app.register(lmsRolesRouter);
  await app.register(leadStageRouter);
  await app.register(leadStageOutcomeRouter);
  await app.register(interactionTypesRouter);
  await app.register(followUpStatusesRouter);
  await app.register(leadSourcesRouter);
  await app.register(marketingPlatformsRouter);
  await app.register(campaignStatusesRouter);
}
