import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import { parseAuthContext, type AuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import * as adAccounts from '../../../services/ad-accounts.service.js';
import { adAccountParamsSchema, updateAdAccountBodySchema } from './ad-accounts.schema.js';

// Ad accounts under the shared Meta integration. PLATFORM-level, not
// tenant-scoped (see ad-accounts.service.ts), so there is no ?tenant_id= here and
// no RLS tenant to pin: the RANKS.SUPER_ADMIN check below is what stands between
// a caller and ext.meta_ad_accounts (after the gateway's superAdminGuard).

function requireSuperAdmin(ctx: AuthContext): void {
  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can manage Meta ad accounts');
  }
}

export async function listAdAccounts(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  return reply.send({ success: true, data: await adAccounts.listAdAccountRows() });
}

export async function syncAdAccounts(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const result = await adAccounts.syncAdAccountsFromMeta();
  request.log.info({ evt: 'ad_accounts.synced', seen: result.seen, added: result.added }, 'Meta ad accounts synced');
  return reply.send({ success: true, data: result });
}

export async function updateAdAccount(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;
  requireSuperAdmin(ctx);
  const { adAccountId } = adAccountParamsSchema.parse(request.params);
  const body = updateAdAccountBodySchema.parse(request.body);
  const row = await adAccounts.setAdAccountEnabled(adAccountId, body.is_enabled);
  request.log.info(
    { evt: 'ad_accounts.toggled', adAccountId, isEnabled: body.is_enabled, actorUserId: ctx.user_id },
    'Meta ad account toggled',
  );
  return reply.send({ success: true, data: row });
}
