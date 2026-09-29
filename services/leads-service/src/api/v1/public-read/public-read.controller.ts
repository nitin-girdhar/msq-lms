import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../../lib/errors.js';
import * as repo from './public-read.repository.js';
import type { FindLeadsBody, ListLeadsQuery } from './public-read.schema.js';

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

// The set of branches a list/find call may read: the key's own binding,
// optionally narrowed by caller-supplied branch ids. orgIds null = tenant-wide
// key, no narrowing; [] = the key reaches no branch (caller gets no rows). A
// requested branch outside the key's reach is a 400, never silently dropped.
async function resolveOrgScope(
  request: FastifyRequest,
  requested: string[],
): Promise<{ tenantId: string; orgIds: string[] | null }> {
  const tenantId = String(request.headers['x-tenant-id'] ?? '').trim();
  if (!tenantId || !UUID_RE.test(tenantId)) throw new UnauthorizedError('Tenant context missing');
  const wanted = [...new Set(requested)];

  const headerOrg = String(request.headers['x-org-id'] ?? '').trim();
  if (headerOrg) {
    if (!UUID_RE.test(headerOrg)) throw new BadRequestError('Invalid branch context');
    if (wanted.some((id) => id !== headerOrg)) throw new BadRequestError('branch_id is not permitted for this API key');
    return { tenantId, orgIds: [headerOrg] };
  }

  if (String(request.headers['x-scope-all-orgs'] ?? '') === 'true') {
    if (wanted.length === 0) return { tenantId, orgIds: null };
    const owned = await repo.orgsBelongingToTenant(wanted, tenantId);
    if (owned.length !== wanted.length) throw new BadRequestError('branch_id is not permitted for this API key');
    return { tenantId, orgIds: owned };
  }

  const allowed = String(request.headers['x-allowed-org-ids'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return { tenantId, orgIds: allowed };
  if (wanted.some((id) => !allowed.includes(id))) throw new BadRequestError('branch_id is not permitted for this API key');
  return { tenantId, orgIds: wanted };
}

export class PublicReadController {
  listLeads = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as ListLeadsQuery;
    const { tenantId, orgIds } = await resolveOrgScope(request, q.branch_id ?? []);
    const { rows, total } = await repo.listLeads(tenantId, orgIds, {
      ...(q.assigned_to ? { assignedTo: q.assigned_to } : {}),
      ...(q.start_date ? { startDate: q.start_date } : {}),
      ...(q.end_date ? { endDate: q.end_date } : {}),
      ...(q.source ? { sources: q.source } : {}),
      ...(q.stage ? { stages: q.stage } : {}),
      ...(q.outcome ? { outcomes: q.outcome } : {}),
      includeInactive: q.include_inactive,
      limit: q.limit,
      offset: q.offset,
    });
    return reply.send({ success: true, data: rows, total, limit: q.limit, offset: q.offset });
  };

  findLeads = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as FindLeadsBody;
    const { tenantId, orgIds } = await resolveOrgScope(request, body.branch_id ?? []);

    // input -> normalised key, so each input can be reported found / not found.
    const phoneKeyOf = new Map(body.phones.map((p) => [p, p.replace(/\D/g, '').slice(-10)]));
    const emailKeyOf = new Map(body.emails.map((e) => [e, e.trim().toLowerCase()]));
    const rows = await repo.findLeads(
      tenantId, orgIds,
      [...new Set(phoneKeyOf.values())], [...new Set(emailKeyOf.values())],
      body.include_inactive,
    );

    const phoneKeys = new Set(phoneKeyOf.values());
    const emailKeys = new Set(emailKeyOf.values());
    const hitPhones = new Set<string>();
    const hitEmails = new Set<string>();
    const data = rows.map(({ phone_key, email_key, ...lead }) => {
      const matched_on: string[] = [];
      if (typeof phone_key === 'string' && phoneKeys.has(phone_key)) { matched_on.push('phone'); hitPhones.add(phone_key); }
      if (typeof email_key === 'string' && emailKeys.has(email_key)) { matched_on.push('email'); hitEmails.add(email_key); }
      return { ...lead, matched_on };
    });

    return reply.send({
      success: true,
      data,
      not_found: {
        phones: body.phones.filter((p) => !hitPhones.has(phoneKeyOf.get(p)!)),
        emails: body.emails.filter((e) => !hitEmails.has(emailKeyOf.get(e)!)),
      },
    });
  };

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
