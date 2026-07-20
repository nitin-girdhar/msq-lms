import type { FastifyRequest, FastifyReply } from 'fastify';
import { readAuthContext } from '@platform/service-auth';
import { platformRank } from '@platform/authz';

// P1.3: the JWT no longer carries a rank. Meta integration management gates
// purely on a platform tier (tenant_admin+), so `rank` here is the coarse
// platform rank derived from platform_role — no DB lookup. `role` carries
// platform_role (drives withRoleTx PG-role selection).
export interface AuthContext {
  org_id: string;
  user_id: string;
  tenant_id: string;
  role: string;
  rank: number;
}

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

export function parseAuthContext(
  request: FastifyRequest,
  reply: FastifyReply,
): AuthContext | null {
  const result = readAuthContext(request.headers, INTERNAL_SECRET);
  if (!result.ok) {
    void reply.status(result.status).send({ error: result.error });
    return null;
  }
  const { org_id, user_id, tenant_id, platform_role } = result.auth;
  return {
    org_id,
    user_id,
    tenant_id,
    role: platform_role,
    rank: platformRank(platform_role as Parameters<typeof platformRank>[0]),
  };
}
