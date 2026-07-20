import type { FastifyRequest } from 'fastify';
import { readAuthContext } from '@platform/service-auth';
import { resolveMemberRole } from '@platform/db';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

export async function authenticate(request: FastifyRequest): Promise<void> {
  const result = readAuthContext(request.headers, INTERNAL_SECRET);
  if (!result.ok) throw new UnauthorizedError(result.error);
  const { org_id, user_id, tenant_id, platform_role } = result.auth;

  // P1.3: resolve the acting user's LMS role/rank from lms.member_roles server-side
  // (never a header). No active grant (rank < 0) → not an LMS member in this org.
  // `role` carries platform_role: it drives withRoleTx's PG-role selection and the
  // cross-org (super_admin/tenant_admin) gates; product gates use `rank`.
  const { rank } = await resolveMemberRole('lms', user_id, org_id);
  if (rank < 0) {
    throw new ForbiddenError('You do not have access to the LMS product in this organization');
  }
  request.auth = { org_id, user_id, tenant_id, role: platform_role, rank };
}
