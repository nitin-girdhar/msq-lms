import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkAnalyticsAccess } from '@lms/authz';
import { BadRequestError, ForbiddenError } from '../../../lib/errors.js';
import * as service from './analytics.service.js';
import type { DateRange } from './analytics.repository.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The optional ?start=&end= lead-creation window shared by the report and
 * pipeline routes. Both ends are required for a range to apply — one alone is
 * an open-ended window the queries have no shape for. A malformed value is
 * ignored rather than rejected, so a stale bookmark still renders the all-time
 * view instead of erroring; an inverted range is a real mistake and does 400.
 */
function parseRange(request: FastifyRequest): DateRange | undefined {
  const { start, end } = request.query as { start?: string; end?: string };
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) return undefined;
  if (start > end) throw new BadRequestError('start must be on or before end');
  return { start, end };
}

export class AnalyticsController {
  getDashboard = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const isTenantWide = role === 'super_admin' || role === 'tenant_admin';
    const data = await service.getDashboard(org_id, user_id, isTenantWide);
    return reply.send({ success: true, data });
  };

  getCampaignSummary = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const data = await service.getCampaignSummary(org_id, user_id);
    return reply.send({ success: true, data });
  };

  getPerformance = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const data = await service.getPerformanceSnapshot(org_id, user_id);
    return reply.send({ success: true, data });
  };

  getPipeline = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const data = await service.getPipelineByStage(org_id, user_id, parseRange(request));
    return reply.send({ success: true, data });
  };

  // ── Daily lead report ─────────────────────────────────────────────────────

  getBranchReport = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const isTenantWide = role === 'super_admin' || role === 'tenant_admin';
    const data = await service.getBranchReport(org_id, user_id, isTenantWide, parseRange(request));
    return reply.send({ success: true, data });
  };

  getUserReport = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const isTenantWide = role === 'super_admin' || role === 'tenant_admin';
    const data = await service.getUserReport(org_id, user_id, isTenantWide);
    return reply.send({ success: true, data });
  };

  getSourceReport = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const isTenantWide = role === 'super_admin' || role === 'tenant_admin';
    const data = await service.getSourceReport(org_id, user_id, isTenantWide, parseRange(request));
    return reply.send({ success: true, data });
  };

  /**
   * Sends the tenant-wide report on demand, to the tenant's own admins.
   *
   * Tenant-wide access is required, not merely analytics access: the email
   * contains every branch under the tenant, so a branch admin must not be able
   * to trigger it.
   */
  sendReportNow = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    if (role !== 'super_admin' && role !== 'tenant_admin') {
      throw new ForbiddenError('Only tenant administrators can send the tenant lead report');
    }
    const data = await service.sendReportNow(org_id, user_id);
    return reply.send({ success: true, data });
  };
}
