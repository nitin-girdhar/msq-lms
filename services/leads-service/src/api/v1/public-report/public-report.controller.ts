import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError, UnauthorizedError } from '../../../lib/errors.js';
import { buildTenantReport } from '../../../lib/reports/lead-report.mailer.js';
import { renderPublicReportHtml } from '../../../lib/reports/public-report.render.js';
import type { BranchReportRow, TenantReport, UserReportRow } from '../../../lib/reports/lead-report.types.js';
import type { SourceBranchRow, SourceUserRow } from '../../../lib/reports/source-report.types.js';
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

/** Same idea as scopeReport, for the source-segmented shape (structurally different: no org_timezone, extra source_id/label). */
function scopeSourceReport(
  report: { branches: SourceBranchRow[]; users: SourceUserRow[] },
  orgId?: string,
): { branches: SourceBranchRow[]; users: SourceUserRow[] } {
  if (!orgId) return report;
  return {
    branches: report.branches.filter((b) => !b.is_total && b.org_id === orgId),
    users: report.users.filter((u) => u.org_id === orgId),
  };
}

/** First day of the calendar month `date` (YYYY-MM-DD) falls in. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export class PublicReportController {
  getReport = async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId, orgId } = resolveScope(request);

    const {
      compare: compareRaw,
      start: startRaw,
      end: endRaw,
      key,
    } = request.query as { compare?: string; start?: string; end?: string; key?: string };

    // The two filters are mutually exclusive; a valid ?compare= wins and
    // suppresses the range entirely. The form enforces this client-side with a
    // disabled fieldset, but a hand-built URL can still carry both.
    const compareDate = compareRaw && DATE_RE.test(compareRaw) ? compareRaw : null;

    // Malformed dates fall back to the default window rather than erroring — a
    // shared link with a truncated query string should still render.
    const startParam = !compareDate && startRaw && DATE_RE.test(startRaw) ? startRaw : null;
    const endParam = !compareDate && endRaw && DATE_RE.test(endRaw) ? endRaw : null;
    if (startParam && endParam && startParam > endParam) {
      throw new BadRequestError('start must be on or before end');
    }

    // Sequential, not Promise.all: the default window is derived from the
    // report's own tenant-local date (a MAX over the branches' local dates), so
    // the range has to be known before the source query runs.
    const reportFull = await buildTenantReport(tenantId);
    const range = compareDate
      ? undefined
      : {
          start: startParam ?? monthStart(reportFull.report_date),
          end: endParam ?? reportFull.report_date,
        };

    const sourceReportFull = await analyticsRepo.getTenantSourceReport(tenantId, range);

    // In range mode the view-derived branch rows are all-time and would
    // contradict the filtered tree below them, so they are replaced by rows
    // summed out of the filtered source rows.
    const rangedFull: TenantReport = range
      ? { ...reportFull, branches: analyticsRepo.rollupBranchesFromSources(sourceReportFull.branches) }
      : reportFull;

    const report: TenantReport = scopeReport(rangedFull, orgId);
    const sourceReport = scopeSourceReport(sourceReportFull, orgId);

    const [compareSnapshotFull, sourceCompareSnapshotFull] = compareDate
      ? await Promise.all([
          analyticsRepo.getSnapshotForDate(tenantId, compareDate),
          analyticsRepo.getSourceSnapshotForDate(tenantId, compareDate),
        ])
      : [null, null];
    const compareSnapshot = compareSnapshotFull ? scopeReport(compareSnapshotFull, orgId) : null;
    const sourceCompareSnapshot = sourceCompareSnapshotFull ? scopeSourceReport(sourceCompareSnapshotFull, orgId) : null;

    // Carried forward as hidden fields in the filter form — a GET form can't set
    // headers, so the key has to stay in the URL/form either way.
    const html = renderPublicReportHtml(report, {
      compareDate,
      compareSnapshot,
      key: key ?? '',
      branchId: (request.query as { branch_id?: string }).branch_id ?? '',
      range: range ?? null,
      sourceBranches: sourceReport.branches,
      sourceUsers: sourceReport.users,
      sourceCompareSnapshot,
    });
    reply.type('text/html; charset=utf-8').send(html);
  };
}
