import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@crm/permissions';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './campaigns.service.js';
import type { CreateCampaignBody, UpdateCampaignBody } from './campaigns.schema.js';

export class CampaignsController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const campaigns = await service.listCampaigns({ org_id, user_id, role, tenant_id });
    return reply.send({ success: true, data: campaigns });
  };

  getById = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const campaign = await service.getCampaignById({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: campaign });
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < RANKS.ADMIN) throw new ForbiddenError('Only admins can create campaigns');
    const data = request.body as CreateCampaignBody;
    const result = await service.createCampaign({ org_id, user_id, role, tenant_id }, data);
    return reply.status(201).send({ success: true, data: { id: result.id } });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < RANKS.ADMIN) throw new ForbiddenError('Only admins can update campaigns');
    const { id } = request.params as { id: string };
    const data = request.body as UpdateCampaignBody;
    await service.updateCampaign({ org_id, user_id, role, tenant_id }, id, data);
    return reply.status(204).send();
  };

  delete = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < RANKS.ADMIN) throw new ForbiddenError('Only admins can delete campaigns');
    const { id } = request.params as { id: string };
    await service.deleteCampaign({ org_id, user_id, role, tenant_id }, id);
    return reply.status(204).send();
  };

  listPlatforms = async (_request: FastifyRequest, reply: FastifyReply) => {
    const platforms = await service.listMarketingPlatforms();
    return reply.send({ success: true, data: platforms });
  };

  listStatuses = async (_request: FastifyRequest, reply: FastifyReply) => {
    const statuses = await service.listCampaignStatuses();
    return reply.send({ success: true, data: statuses });
  };
}
