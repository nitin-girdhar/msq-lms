import type { FastifyRequest } from 'fastify';
import { readAuthContext } from '@platform/service-auth';
import { resolveGlobalRole, capabilitiesFor } from '@platform/db';
import { hasOrgAccess, can, CAPABILITY } from '@platform/rbac';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];

export async function authenticate(request: FastifyRequest): Promise<void> {
  const result = readAuthContext(request.headers, INTERNAL_SECRET);
  if (!result.ok) throw new UnauthorizedError(result.error);
  const { org_id, user_id, tenant_id, platform_role } = result.auth;

  // Tier C: rank + department come from the ONE iam ladder (iam.fn_user_org_role),
  // not the per-product member_roles scale — page guards and services now read the
  // same number, so they can no longer disagree. `role` still carries
  // platform_role: it drives withRoleTx's PG-role selection (RLS) and the
  // cross-org (super_admin/tenant_admin) gates.
  const { role: role_name, rank, department } = await resolveGlobalRole(user_id, org_id);
  if (!hasOrgAccess(rank)) {
    throw new ForbiddenError('You do not have an active role in this organization');
  }

  // Tier C3: capabilities come from iam.role_capabilities, resolved per tenant and
  // served from the in-process cache. This is the SAME list the browser receives
  // on /auth/me, which is why the UI can no longer offer an action this refuses.
  const capabilities = await capabilitiesFor(tenant_id, role_name);

  // member_roles used to double as the "is this user provisioned in LMS" gate.
  // The TOOL node is now that gate — denying `lms` prunes every page, operation
  // and scope beneath it in one row, which is what the tree is for.
  if (!can({ capabilities }, CAPABILITY.LMS)) {
    throw new ForbiddenError('You do not have access to the LMS product in this organization');
  }

  request.auth = {
    org_id, user_id, tenant_id,
    role: platform_role, role_name, rank, department, capabilities,
  };
}
