import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../../lib/errors.js';
import * as repo from './public-read.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validates the lead's own branch against the gateway-injected scope headers
// for a multi-branch/tenant-wide key. X-Allowed-Org-Ids ids were already
// validated against the tenant when the key was created/edited, so a plain
// membership check suffices; scope_all_orgs still needs a DB check since the
// branch set isn't enumerable.
async function isBranchAllowed(request: FastifyRequest, branchId: string, tenantId: string): Promise<boolean> {
  const scopeAllOrgs = String(request.headers['x-scope-all-orgs'] ?? '') === 'true';
  if (scopeAllOrgs) return repo.orgBelongsToTenant(branchId, tenantId);
  const allowed = String(request.headers['x-allowed-org-ids'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(branchId);
}

export class PublicReadController {
  getLead = async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = String(request.headers['x-tenant-id'] ?? '').trim();
    if (!tenantId || !UUID_RE.test(tenantId)) throw new UnauthorizedError('Tenant context missing');

    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) throw new BadRequestError('id must be a valid UUID');

    const lead = await repo.getLeadById(tenantId, id);
    if (!lead) throw new NotFoundError('Lead not found');

    const leadOrgId = String(lead['org_id']);
    const headerOrg = String(request.headers['x-org-id'] ?? '').trim();
    const allowed = headerOrg ? headerOrg === leadOrgId : await isBranchAllowed(request, leadOrgId, tenantId);
    // Same shape as a lead in another tenant: a caller with no visibility into
    // this branch must not be able to distinguish "wrong branch" from "no such lead".
    if (!allowed) throw new NotFoundError('Lead not found');

    const { org_id: _orgId, ...data } = lead;
    return reply.send({ success: true, data });
  };
}
