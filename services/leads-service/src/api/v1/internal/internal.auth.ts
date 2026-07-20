import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../../lib/errors.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

// Used by internal service-to-service calls (identity-service's user
// branch-move/deactivation reassignment saga). Requires only the shared
// internal secret — same pattern as intake.auth.ts's authenticateInternal.
export async function authenticateInternal(request: FastifyRequest): Promise<void> {
  const secret = request.headers['x-internal-secret'] as string | undefined;
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    throw new UnauthorizedError('Unauthorized');
  }
}
