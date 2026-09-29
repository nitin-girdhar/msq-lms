import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError } from '../../../lib/errors.js';
import * as repo from './intake.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validates a caller-supplied branch against the gateway-injected scope
// headers for a multi-branch/tenant-wide key. X-Allowed-Org-Ids ids were
// already validated against the tenant when the key was created/edited, so a
// plain membership check suffices; scope_all_orgs still needs a DB check
// since the branch set isn't enumerable.
async function isBranchAllowed(request: FastifyRequest, branchId: string, tenantId: string): Promise<boolean> {
  const scopeAllOrgs = String(request.headers['x-scope-all-orgs'] ?? '') === 'true';
  if (scopeAllOrgs) return repo.orgBelongsToTenant(branchId, tenantId);
  const allowed = String(request.headers['x-allowed-org-ids'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(branchId);
}

export class IntakeController {
  // Called by internal services (meta webhook, other service-to-service calls).
  // org_id is trusted from the request body since the caller is an internal service.
  webhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    const org_id = String(body['org_id'] ?? '');
    if (!org_id) throw new BadRequestError('org_id is required');
    const result = await repo.createWebhookLead({ org_id, ...body });
    return reply.status(201).send({ success: true, data: result });
  };

  // Called via the scoped public API (/public/v1/leads). The gateway has already
  // authenticated the API key and injected the tenant (X-Tenant-Id) and, for a
  // key bound to exactly one branch, the branch (X-Org-Id). For a key bound to
  // a subset of branches or the whole tenant, the caller supplies branch_id,
  // validated against X-Allowed-Org-Ids / X-Scope-All-Orgs (set by the gateway
  // from the key's binding — never the request body).
  publicApiLead = async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = String(request.headers['x-tenant-id'] ?? '').trim();
    const headerOrg = String(request.headers['x-org-id'] ?? '').trim();
    const body = request.body as Record<string, unknown>;

    let orgId = headerOrg;
    if (!orgId) {
      const branchId = String(body['branch_id'] ?? '').trim();
      if (!branchId) throw new BadRequestError('branch_id is required for this API key');
      if (!UUID_RE.test(branchId)) throw new BadRequestError('branch_id must be a valid UUID');
      if (!tenantId || !UUID_RE.test(tenantId)) throw new BadRequestError('Tenant context missing');
      if (!(await isBranchAllowed(request, branchId, tenantId))) {
        throw new BadRequestError('branch_id is not permitted for this API key');
      }
      orgId = branchId;
    }

    // The Meta campaign fields are the INTERNAL Meta path's to supply (the
    // webhook resolves them from Meta itself). createWebhookLead spreads the
    // whole body in, so an API-key caller sending meta_campaign_id could make
    // resolveCampaignForLead create a marketing.ad_campaigns row in the branch
    // for any id it liked. campaign_type_id stays accepted: it is validated
    // against the branch's tenant and refused (400) otherwise.
    const {
      org_id: _ignored,
      branch_id: _ignored2,
      meta_campaign_id: _ignoredMetaCampaign,
      meta_campaign_name: _ignoredMetaName,
      meta_platform: _ignoredMetaPlatform,
      meta_campaign_status: _ignoredMetaStatus,
      ...rest
    } = body;
    const result = await repo.createWebhookLead({ ...rest, org_id: orgId });
    // The public contract stays exactly what it was. assigned_user_id /
    // campaign_type_id / auto_assign_reason (1.51.0) are for the INTERNAL Meta
    // path's realtime event; an API-key caller has no business receiving an
    // internal user id.
    return reply.status(201).send({
      success: true,
      data: { id: result.id, is_duplicate: result.is_duplicate, existing_lead_id: result.existing_lead_id },
    });
  };
}
