import type { FastifyRequest, FastifyReply } from 'fastify';
import { LMS_RANKS } from '@lms/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './analytics.service.js';

export class AnalyticsController {
  getDashboard = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, rank } = request.auth;
    if (rank < LMS_RANKS.ADMIN) throw new ForbiddenError('Access restricted to administrators');
    const isTenantWide = role === 'super_admin' || role === 'tenant_admin';
    const data = await service.getDashboard(org_id, user_id, isTenantWide);
    return reply.send({ success: true, data });
  };

  getCampaignSummary = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, rank } = request.auth;
    if (rank < LMS_RANKS.ADMIN) throw new ForbiddenError('Access restricted to administrators');
    const data = await service.getCampaignSummary(org_id, user_id);
    return reply.send({ success: true, data });
  };

  getPerformance = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, rank } = request.auth;
    if (rank < LMS_RANKS.ADMIN) throw new ForbiddenError('Access restricted to administrators');
    const data = await service.getPerformanceSnapshot(org_id, user_id);
    return reply.send({ success: true, data });
  };

  getPipeline = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, rank } = request.auth;
    if (rank < LMS_RANKS.ADMIN) throw new ForbiddenError('Access restricted to administrators');
    const data = await service.getPipelineByStage(org_id, user_id);
    return reply.send({ success: true, data });
  };
}
