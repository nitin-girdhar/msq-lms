import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import { parseAuthContext, type AuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import * as pageOrgMapService from '../../../services/page-org-map.admin.service.js';
import type { AdminTenantScope } from '../../../services/page-org-map.admin.service.js';
import {
  tenantScopedQuerySchema,
  createMappingSchema,
  updateMappingSchema,
  mappingParamsSchema,
} from './page-org-map.schema.js';

// ext.meta_page_form_org_map decides which BRANCH every inbound Meta lead lands
// in, and it is administered from the lookup-admin console by platform staff
// acting on a tenant OTHER than their own. All four operations therefore gate on
// RANKS.SUPER_ADMIN — including the read, which previously had no gate at all —
// and take the administered tenant from ?tenant_id= rather than from the
// caller's session.
//
// The rank check here is the coarse gate, not the boundary. Every operation runs
// under withTenantConfigTx with app.current_tenant_id pinned to the requested
// tenant, where ext.meta_page_form_org_map's admin_tenant_config_policy
// (db_scripts/08_rls.sql) enforces the scoping in the database — reads fenced to
// that tenant, and writes additionally required to name an org inside it. The
// tenant id itself is validated against entity.tenants in the service, under the
// same transaction and so under the same RLS.
function adminScope(request: FastifyRequest, ctx: AuthContext): AdminTenantScope {
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can manage Meta page/form mappings');
  }
  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  return { actorUserId: ctx.user_id, tenantId: tenant_id };
}

export async function listMappings(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const mappings = await pageOrgMapService.listPageFormOrgMappings(adminScope(request, ctx));
  return reply.send({ success: true, data: mappings });
}

export async function createMapping(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const scope = adminScope(request, ctx);
  const body = createMappingSchema.parse(request.body);
  const result = await pageOrgMapService.createPageFormOrgMapping(scope, body);
  return reply.status(201).send({ success: true, data: result });
}

export async function updateMapping(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const scope = adminScope(request, ctx);
  const { mappingId } = mappingParamsSchema.parse(request.params);
  const body = updateMappingSchema.parse(request.body);
  await pageOrgMapService.updatePageFormOrgMapping(scope, mappingId, body);
  return reply.status(204).send();
}

export async function deleteMapping(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const scope = adminScope(request, ctx);
  const { mappingId } = mappingParamsSchema.parse(request.params);
  await pageOrgMapService.deletePageFormOrgMapping(scope, mappingId);
  return reply.status(204).send();
}
