import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import { parseAuthContext, type AuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import type { AdminTenantScope } from '../../../services/page-org-map.admin.service.js';
import * as leadPull from '../../../services/lead-pull.admin.service.js';
import { queueApply } from '../../../services/lead-apply.service.js';
import {
  listPullCampaignsQuerySchema,
  createRunBodySchema,
  runParamsSchema,
  listRunLeadsQuerySchema,
  tenantScopedQuerySchema,
  latestRunQuerySchema,
} from './lead-pull.schema.js';

// The Meta lead PULL: a super admin backfilling leads the live webhook missed.
// It reaches into a selected tenant's Meta credentials, stages what it finds,
// and — on Apply — writes real leads into that tenant's branches. All five
// routes therefore gate on RANKS.SUPER_ADMIN and take the administered tenant
// from ?tenant_id=.
//
// The rank check is the coarse gate, NOT the boundary. Every operation runs
// under withTenantConfigTx with app.current_tenant_id pinned to the REQUESTED
// tenant, where scratch.meta_pull_*'s admin_tenant_config_policy
// (db_scripts/08_rls.sql) enforces the scoping in the database — and the tenant
// id itself is validated against entity.tenants inside that same transaction,
// under that same policy.
//
// ctx.tenant_id is read NOWHERE below, and that is the point.
function adminScope(tenantId: string, ctx: AuthContext): AdminTenantScope {
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can run a Meta lead pull');
  }
  return { actorUserId: ctx.user_id, tenantId };
}

export async function listCampaigns(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const query = listPullCampaignsQuerySchema.parse(request.query);
  const scope = adminScope(query.tenant_id, ctx);

  const campaigns = await leadPull.listPullCampaigns(scope, query.page_ids);
  return reply.send({
    success: true,
    data: campaigns,
    // Stated in the RESPONSE, not just in a doc, because the UI has to render
    // it: Meta has no campaign-scoped lead edge, so selecting campaigns filters
    // the result and not the work. Without this an admin picks one campaign,
    // waits exactly as long as for all of them, and files a bug.
    campaign_filter_is_post_fetch: true,
  });
}

export async function createRun(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  const scope = adminScope(tenant_id, ctx);
  const body = createRunBodySchema.parse(request.body);

  const result = await leadPull.createPullRun(scope, {
    org_ids: body.org_ids,
    page_ids: body.page_ids,
    campaign_ids: body.campaign_ids,
    since: body.since,
    until: body.until ?? null,
    mode: body.mode,
  });

  request.log.info(
    {
      evt: 'lead_pull.enqueued',
      runId: result.run_id,
      tenantId: tenant_id,
      orgs: body.org_ids.length,
      pages: body.page_ids.length,
      campaigns: body.campaign_ids.length,
      since: body.since,
    },
    'Meta lead pull enqueued',
  );

  // 202, not 201: the run row exists, but the work has not been done. The
  // client polls GET /runs/:id. A 201 would imply the pull was complete.
  return reply.status(202).send({ success: true, data: result });
}

export async function getRun(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  const scope = adminScope(tenant_id, ctx);
  const { runId } = runParamsSchema.parse(request.params);

  const run = await leadPull.getPullRun(scope, runId);
  return reply.send({ success: true, data: run });
}

export async function getLatestRun(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const { tenant_id, trigger_kind } = latestRunQuerySchema.parse(request.query);
  const scope = adminScope(tenant_id, ctx);

  // 200 with data: null when the tenant has no run — "nothing to reopen" is an
  // answer, not a missing resource. ?trigger_kind=scheduled reopens the latest
  // scheduled catch-up run instead of the admin's own (1.51.0).
  const latest = await leadPull.getLatestPullRun(scope, trigger_kind);
  return reply.send({ success: true, data: latest });
}

export async function listRunLeads(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const query = listRunLeadsQuerySchema.parse(request.query);
  const scope = adminScope(query.tenant_id, ctx);
  const { runId } = runParamsSchema.parse(request.params);

  const result = await leadPull.listRunLeads(scope, runId, {
    ...(query.verdict ? { verdict: query.verdict } : {}),
    page: query.page,
    page_size: query.page_size,
  });

  return reply.send({
    success: true,
    data: result.rows,
    total: result.total,
    page: query.page,
    page_size: query.page_size,
  });
}

export async function applyPullRun(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  const scope = adminScope(tenant_id, ctx);
  const { runId } = runParamsSchema.parse(request.params);

  // QUEUES the Apply and returns 202, exactly like POST /runs. The Apply itself
  // makes one leads-service intake call per staged row, and the gateway gives up
  // on a proxied request after 30 seconds, so doing it inline answered 504 for
  // any real run while the server kept writing. The lead-pull poller runs it;
  // the client polls GET /runs/:id and reads the tallies from `counts.apply`
  // and `apply_summary` once the run reaches `applied`.
  const result = await queueApply(scope, runId);

  request.log.info(
    { evt: 'lead_pull.apply_queued', runId, tenantId: tenant_id },
    'Meta lead pull Apply queued',
  );

  return reply.status(202).send({ success: true, data: result });
}

/**
 * Re-resolves the branch of a run's UNMAPPED rows after the admin mapped their
 * page/form inline, and re-classifies the run (1.51.0). The rows become
 * importable without a second Graph walk; Apply then takes them even on a run
 * that was already applied.
 */
export async function remapPullRun(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  const scope = adminScope(tenant_id, ctx);
  const { runId } = runParamsSchema.parse(request.params);

  const result = await leadPull.remapRun(scope, runId);
  request.log.info(
    { evt: 'lead_pull.remapped', runId, tenantId: tenant_id, remapped: result.remapped, stillUnmapped: result.still_unmapped },
    'Meta lead pull remapped',
  );
  return reply.send({ success: true, data: result });
}
