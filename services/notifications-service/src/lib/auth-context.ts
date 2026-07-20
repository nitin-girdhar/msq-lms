import type { FastifyRequest, FastifyReply } from 'fastify';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

// P1.3: the gateway injects only platform_role (no rank). `role` carries it;
// the per-connection product rank is resolved from the DB by the caller (see
// routes/stream.ts) — never from a header.
export interface AuthContext {
  org_id: string;
  user_id: string;
  role: string;
  tenant_id: string;
}

export function parseAuthContext(
  request: FastifyRequest,
  reply: FastifyReply,
): AuthContext | null {
  const secret = request.headers['x-internal-secret'] as string | undefined;
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    void reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }

  const org_id = request.headers['x-org-id'] as string;
  const user_id = request.headers['x-user-id'] as string;
  const role = request.headers['x-platform-role'] as string | undefined;

  if (!org_id || !user_id || !role) {
    void reply.status(401).send({ error: 'Missing auth headers' });
    return null;
  }

  return {
    org_id,
    user_id,
    role,
    tenant_id: (request.headers['x-tenant-id'] as string) || '',
  };
}
