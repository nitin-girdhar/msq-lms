import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../../lib/errors.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

// Used by internal service-to-service intake calls (meta webhook, service calls).
// Requires only the shared internal secret; org_id comes from the request body.
export async function authenticateInternal(request: FastifyRequest): Promise<void> {
  const secret = request.headers['x-internal-secret'] as string | undefined;
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    throw new UnauthorizedError('Unauthorized');
  }
}
