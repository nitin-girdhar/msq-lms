import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CAPABILITY, type CapabilityKey } from '@platform/rbac';
import { authenticate } from '../../../middleware/auth.middleware.js';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { requireCapability } from '../../../middleware/require-capability.middleware.js';
import { requireModule } from '../../../middleware/require-module.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { CampaignTypesController } from './campaign-types.controller.js';
import {
  campaignTypesScopeQuerySchema,
  createCampaignTypeBodySchema,
  updateCampaignTypeBodySchema,
} from './campaign-types.schema.js';
import {
  createRuleBodySchema,
  updateRuleBodySchema,
  reorderRulesBodySchema,
  testRulesBodySchema,
} from './campaign-type-rules.schema.js';

const ctrl = new CampaignTypesController();

const MANAGE_DENIED = 'You do not have permission to manage campaign types';

// TWO AUDIENCES, ONE CATALOG.
//
// A tenant's own staff (lms-web, team-web) read and edit THEIR tenant's types.
// Authorization is by CAPABILITY, never by role name — a role name is not an
// authorization boundary on this platform — gated exactly like /campaigns
// alongside it: VIEW to read the catalog, MANAGE for every write (keyword
// editing included, which is what actually decides how inbound leads route).
//
// A platform super_admin in the lookup-admin console administers a tenant OTHER
// than their own and says which one with ?tenant_id=. The ordinary gate is wrong
// for them twice over: `authenticate` resolves capabilities, and requireModule
// the licensed modules, against the caller's OWN org, so they would be judged on
// their home tenant rather than the one they are editing. That caller gets
// authenticateSuperAdmin instead — the N-6 gate every tenant-scoped lookup
// already uses (see /lookups/lead-sources) — and the transaction is then pinned
// to the administered tenant, where admin_tenant_config_policy fences the rows.
//
// Until this split, ?tenant_id= was parsed by nothing and a super admin was
// silently handed their OWN tenant's types: the confirm dialog on
// /dashboard/meta-campaigns offered ids the administered tenant's RLS then
// refused, and lookup-admin's OrgAccessPanel wrote weight rows against them.
function campaignTypesGate(key: CapabilityKey, message?: string) {
  const tenantStaffGate = [authenticate, requireModule('lms'), requireCapability(key, message)];
  return async function gate(request: FastifyRequest): Promise<void> {
    const { tenant_id } = campaignTypesScopeQuerySchema.parse(request.query);
    if (tenant_id) {
      await authenticateSuperAdmin(request);
      return;
    }
    for (const handler of tenantStaffGate) await handler(request);
  };
}

export async function campaignTypesRouter(app: FastifyInstance) {
  const scope = validate({ query: campaignTypesScopeQuerySchema });
  const view = campaignTypesGate(CAPABILITY.LMS_CAMPAIGN_TYPES_VIEW);
  const manage = campaignTypesGate(CAPABILITY.LMS_CAMPAIGN_TYPES_MANAGE, MANAGE_DENIED);

  // Ordered rules (1.51.0). Registered BEFORE /campaign-types/:id so the static
  // `rules` segment is never captured as a type id (Fastify prefers static
  // segments anyway; the order states the intent). Same gates as the types:
  // VIEW to read and test, MANAGE for every write — a rule decides which pool
  // inbound leads route to, exactly like editing a type did.
  const ruleParams = validate({ params: z.object({ ruleId: z.string().uuid() }) });
  app.get('/campaign-types/rules', { preHandler: [view, scope] }, ctrl.listRules);
  app.post('/campaign-types/rules/test', { preHandler: [view, scope, validate({ body: testRulesBodySchema })] }, ctrl.testRules);
  app.post('/campaign-types/rules', { preHandler: [manage, scope, validate({ body: createRuleBodySchema })] }, ctrl.createRule);
  app.put('/campaign-types/rules/order', { preHandler: [manage, scope, validate({ body: reorderRulesBodySchema })] }, ctrl.reorderRules);
  app.patch('/campaign-types/rules/:ruleId', { preHandler: [manage, scope, ruleParams, validate({ body: updateRuleBodySchema })] }, ctrl.updateRule);
  app.delete('/campaign-types/rules/:ruleId', { preHandler: [manage, scope, ruleParams] }, ctrl.deleteRule);

  app.get('/campaign-types', { preHandler: [view, scope] }, ctrl.list);
  app.get('/campaign-types/:id', { preHandler: [view, scope] }, ctrl.getById);
  app.post('/campaign-types', { preHandler: [manage, scope, validate({ body: createCampaignTypeBodySchema })] }, ctrl.create);
  app.patch('/campaign-types/:id', { preHandler: [manage, scope, validate({ body: updateCampaignTypeBodySchema })] }, ctrl.update);
  app.delete('/campaign-types/:id', { preHandler: [manage, scope] }, ctrl.delete);
}
