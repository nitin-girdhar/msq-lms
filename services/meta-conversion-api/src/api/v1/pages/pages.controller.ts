import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RANKS } from '@platform/authz';
import { parseAuthContext, type AuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import * as pagesAdmin from '../../../services/pages.admin.service.js';
import { tenantScopedQuerySchema } from '../page-org-map/page-org-map.schema.js';

// Page and form discovery for the mapping and lead-pull screens: without them an
// admin pastes raw numeric Meta ids, which are neither memorable nor verifiable.
//
// Gated on RANKS.SUPER_ADMIN and scoped by an explicit ?tenant_id=, exactly like
// the page-org-map routes, because they spend the Meta credentials on the
// SELECTED tenant's behalf. The responses carry ids, names and ownership only —
// no page access token ever leaves pages.admin.service.ts.

function requireSuperAdmin(ctx: AuthContext): void {
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can list Meta pages');
  }
}

export async function listPages(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  const pages = await pagesAdmin.listPagesWithOwner({ actorUserId: ctx.user_id, tenantId: tenant_id });
  return reply.send({ success: true, data: pages });
}

const pageParamsSchema = z.object({ pageId: z.string().regex(/^\d+$/) });

export async function listPageForms(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);
  const { pageId } = pageParamsSchema.parse(request.params);
  const forms = await pagesAdmin.listPageForms({ actorUserId: ctx.user_id, tenantId: tenant_id }, pageId);
  return reply.send({ success: true, data: forms });
}
