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
}
