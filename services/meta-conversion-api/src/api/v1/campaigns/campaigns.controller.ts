import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import { parseAuthContext, type AuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import type { AdminTenantScope } from '../../../services/page-org-map.admin.service.js';
import * as campaignAdmin from '../../../services/campaign-admin.service.js';
import { syncCampaigns as runCampaignSync } from '../../../services/campaign-sync.service.js';
import {
  listCampaignsQuerySchema,
  syncCampaignsQuerySchema,
  confirmCampaignQuerySchema,
  confirmCampaignBodySchema,
  campaignParamsSchema,
} from './campaigns.schema.js';

// ext.meta_campaigns decides what KIND every inbound Meta lead is — and therefore
// whether it lands in a branch's sales rotation or its HR pool. It is
// administered from the lookup-admin console by platform staff acting on a
// tenant OTHER than their own, so all three routes gate on RANKS.SUPER_ADMIN and
// take the administered tenant from ?tenant_id=.
//
// The rank check is the coarse gate, not the boundary. Every operation runs
// under withTenantConfigTx with app.current_tenant_id pinned to the REQUESTED
// tenant, where ext.meta_campaigns' admin_tenant_config_policy
// (db_scripts/08_rls.sql) enforces the scoping in the database — and the tenant
// id itself is validated against entity.tenants inside that same transaction,
// under that same policy.
//
// ctx.tenant_id is read NOWHERE below, and that is the point.
function adminScope(tenantId: string, ctx: AuthContext): AdminTenantScope {
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can manage Meta campaign mappings');
  }
  return { actorUserId: ctx.user_id, tenantId };
}

export async function listCampaigns(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const query = listCampaignsQuerySchema.parse(request.query);
  const scope = adminScope(query.tenant_id, ctx);

  const campaigns = await campaignAdmin.listCampaigns(scope, {
    ...(query.mapping_status ? { mapping_status: query.mapping_status } : {}),
    ...(query.page_id ? { page_id: query.page_id } : {}),
  });
  return reply.send({ success: true, data: campaigns });
}

export async function syncCampaigns(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can fetch Meta campaigns');
  }

  // 1.51.0: tenant_id is OPTIONAL here. The fetch walks the shared integration's
  // enabled ad accounts and lands each campaign in the tenant its PAGES belong
  // to; ?tenant_id= narrows the WRITES to that one tenant (the Meta Campaigns
  // screen administers one tenant at a time), it never decides attribution.
  const query = syncCampaignsQuerySchema.parse(request.query);
  const result = await runCampaignSync(
    { actorUserId: ctx.user_id, tenantId: query.tenant_id },
    { log: request.log },
  );
  request.log.info(
    {
      evt: 'campaign_sync.completed',
      tenantId: query.tenant_id ?? null,
      adAccounts: result.ad_accounts,
      fetched: result.fetched,
      inserted: result.inserted,
      confirmedUntouched: result.confirmed_untouched,
      unattributed: result.unattributed.length,
      conflicts: result.conflicts.length,
      errors: result.errors.length,
    },
    'Meta campaign fetch completed',
  );
  return reply.send({ success: true, data: result });
}

export async function confirmCampaign(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const query = confirmCampaignQuerySchema.parse(request.query);
  const scope = adminScope(query.tenant_id, ctx);
  const { metaCampaignId } = campaignParamsSchema.parse(request.params);
  const body = confirmCampaignBodySchema.parse(request.body);

  // 200, not 204: the whole value of this call is what comes back — how many
  // leads were relabelled, how many changed hands, and on a dry run, how many
  // WOULD. A 204 here would make the preview useless.
  const result = await campaignAdmin.confirmCampaignMapping(scope, metaCampaignId, {
    campaign_type_id: body.campaign_type_id,
    add_rule: body.add_rule,
    dry_run: query.dry_run,
  });
  return reply.send({ success: true, data: result });
}
