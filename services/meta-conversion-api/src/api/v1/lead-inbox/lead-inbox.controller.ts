import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RANKS } from '@platform/authz';
import { parseAuthContext, type AuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import * as inbox from '../../../services/lead-inbox.service.js';

// The Meta lead inbox (1.51.0) — webhook leads that did not land. Super admin
// only. ?tenant_id= selects the administered tenant (RLS-fenced reads and
// writes); OMITTING it selects the tenant-less rows — leads from pages mapped to
// nobody, where no tenant is known yet — which are reached on the service path
// and are exactly why this is a super-admin-only surface.

const scopeQuerySchema = z.object({
  tenant_id: z.string().uuid().optional(),
});

const listQuerySchema = scopeQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'ignored']).default('open'),
  reason: z.enum(['unmapped', 'missing_contact', 'sync_failed']).optional(),
});

const paramsSchema = z.object({ id: z.string().uuid() });

function requireSuperAdmin(ctx: AuthContext): void {
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can work the Meta lead inbox');
  }
}

export async function listInbox(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const q = listQuerySchema.parse(request.query);
  const data = await inbox.listInbox(ctx.user_id, q.tenant_id ?? null, {
    status: q.status,
    ...(q.reason ? { reason: q.reason } : {}),
  });
  return reply.send({ success: true, data });
}

export async function retryInbox(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const { tenant_id } = scopeQuerySchema.parse(request.query);
  const { id } = paramsSchema.parse(request.params);
  const data = await inbox.retryInbox(ctx.user_id, tenant_id ?? null, id);
  request.log.info({ evt: 'lead_inbox.retried', inboxId: id, marketingLeadId: data.marketing_lead_id }, 'Inbox lead retried');
  return reply.send({ success: true, data });
}

export async function ignoreInbox(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const { tenant_id } = scopeQuerySchema.parse(request.query);
  const { id } = paramsSchema.parse(request.params);
  await inbox.ignoreInbox(ctx.user_id, tenant_id ?? null, id);
  return reply.status(204).send();
}
