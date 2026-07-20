import type { FastifyRequest } from 'fastify';
import { readAuthContext } from '@platform/service-auth';
import { platformRank } from '@platform/authz';
import type { PlatformRole } from '@platform/types';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

// Platform super_admin gate for the tenant-scoped lookup/role admin routes (N-6).
// Unlike `authenticate`, this does NOT require the caller to be a product member
// (a platform super_admin manages any tenant's config but holds no product role);
// it gates purely on platform_role. `rank` is the coarse PLATFORM rank, not a
// product rank. The target tenant is carried per-route as `?tenant_id=`, and the
// write itself is RLS-pinned to that tenant (see @platform/db withTenantConfigTx +
// db_scripts/25), so this can only ever touch the selected tenant's rows.
export async function authenticateSuperAdmin(request: FastifyRequest): Promise<void> {
  const result = readAuthContext(request.headers, INTERNAL_SECRET);
  if (!result.ok) throw new UnauthorizedError(result.error);
  const { org_id, user_id, tenant_id, platform_role } = result.auth;
  if (platform_role !== 'super_admin') {
    throw new ForbiddenError('Super admin only');
  }
  request.auth = { org_id, user_id, tenant_id, role: platform_role, rank: platformRank(platform_role as PlatformRole) };
}
