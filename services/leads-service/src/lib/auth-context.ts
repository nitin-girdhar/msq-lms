import type { FastifyRequest, FastifyReply } from 'fastify';
import { readAuthContext, type AuthContext } from '@platform/service-auth';

export type { AuthContext };

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
  return result.auth;
}
