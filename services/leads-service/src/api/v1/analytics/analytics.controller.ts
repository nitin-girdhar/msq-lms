import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkAnalyticsAccess } from '@lms/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './analytics.service.js';

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
    const data = await service.getPipelineByStage(org_id, user_id);
    return reply.send({ success: true, data });
  };

  // ── Daily lead report ─────────────────────────────────────────────────────

  getBranchReport = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role } = request.auth;
    if (!checkAnalyticsAccess(request.auth)) throw new ForbiddenError('Access restricted to administrators');
    const isTenantWide = role === 'super_admin' || role === 'tenant_admin';
    const data = await service.getBranchReport(org_id, user_id, isTenantWide);
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
    const data = await service.getSourceReport(org_id, user_id, isTenantWide);
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
