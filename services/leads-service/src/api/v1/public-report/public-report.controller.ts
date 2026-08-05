import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError, UnauthorizedError } from '../../../lib/errors.js';
import { buildTenantReport } from '../../../lib/reports/lead-report.mailer.js';
import { renderPublicReportHtml } from '../../../lib/reports/public-report.render.js';
import type { BranchReportRow, TenantReport, UserReportRow } from '../../../lib/reports/lead-report.types.js';
import * as analyticsRepo from '../analytics/analytics.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Scope {
  tenantId: string;
  /** Set for a single-branch key, or when a tenant-wide/multi-branch key narrows via ?branch_id=. */
  orgId?: string;
}

/**
 * Resolves the tenant/branch scope from the gateway-injected headers (always
 * present for a verified public key — see publicUserContext/publicScopeHeaders
 * in api-gateway) and the optional ?branch_id= narrowing, mirroring
 * identity-service's public-read.controller.ts resolveScope().
 *
 * Unlike that one, a caller-supplied branch_id here needs no DB validation
 * against scope_all_orgs: the report/snapshot queries below are already
 * tenant-scoped, so an org_id from outside the key's own tenant just yields an
 * empty filtered result, never a cross-tenant read.
 */
function resolveScope(request: FastifyRequest): Scope {
  const tenantId = String(request.headers['x-tenant-id'] ?? '').trim();
  if (!tenantId || !UUID_RE.test(tenantId)) throw new UnauthorizedError('Tenant context missing');

  const headerOrg = String(request.headers['x-org-id'] ?? '').trim();
  if (headerOrg) {
    if (!UUID_RE.test(headerOrg)) throw new BadRequestError('Invalid branch context');
    return { tenantId, orgId: headerOrg };
  }

  const q = request.query as { branch_id?: string };
  if (q.branch_id) {
    if (!UUID_RE.test(q.branch_id)) throw new BadRequestError('branch_id must be a valid UUID');
    const scopeAllOrgs = String(request.headers['x-scope-all-orgs'] ?? '') === 'true';
    const allowed = String(request.headers['x-allowed-org-ids'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!scopeAllOrgs && !allowed.includes(q.branch_id)) {
      throw new BadRequestError('branch_id is not permitted for this API key');
    }
    return { tenantId, orgId: q.branch_id };
  }

  return { tenantId };
}

/** Narrows a report to one branch and drops the ALL BRANCHES rollup row, which is meaningless for a single branch. */
function scopeReport<T extends { branches: BranchReportRow[]; users: UserReportRow[] }>(report: T, orgId?: string): T {
  if (!orgId) return report;
  return {
    ...report,
    branches: report.branches.filter((b) => !b.is_total && b.org_id === orgId),
    users: report.users.filter((u) => u.org_id === orgId),
  };
}

export class PublicReportController {
  getReport = async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId, orgId } = resolveScope(request);

    const reportFull: TenantReport = await buildTenantReport(tenantId);
    const report = scopeReport(reportFull, orgId);

    const { compare: compareRaw, key } = request.query as { compare?: string; key?: string };
    const compareDate = compareRaw && DATE_RE.test(compareRaw) ? compareRaw : null;
    const compareSnapshotFull = compareDate ? await analyticsRepo.getSnapshotForDate(tenantId, compareDate) : null;
    const compareSnapshot = compareSnapshotFull ? scopeReport(compareSnapshotFull, orgId) : null;

    // Carried forward as a hidden field in the compare-date form — a GET form
    // can't set headers, so the key has to stay in the URL/form either way.
    const html = renderPublicReportHtml(report, { compareDate, compareSnapshot, key: key ?? '' });
    reply.type('text/html; charset=utf-8').send(html);
  };
}
