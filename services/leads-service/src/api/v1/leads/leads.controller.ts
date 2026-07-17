import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CreateLeadInput, UpdateLeadInput, CreateInteractionInput, TransferLeadInput } from '@crm/validation';
import { RANKS, getRulesForTenant, checkTransferLeadAccess } from '@crm/permissions';
import { ForbiddenError, BadRequestError } from '../../../lib/errors.js';
import * as service from './leads.service.js';
import type { ListLeadsQuery } from './leads.schema.js';

export class LeadsController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const q = request.query as ListLeadsQuery;
    const rules = getRulesForTenant(tenant_id);

    let org_ids: string[] | undefined;
    if (q.org_ids) {
      if (role === 'super_admin' || role === 'tenant_admin') {
        org_ids = q.org_ids.split(',').filter(Boolean);
      } else {
        org_ids = [org_id];
      }
    }

    const result = await service.listLeads(
      { org_id, user_id, role, tenant_id },
      {
        page: q.page,
        page_size: q.page_size,
        actor_rank: rank,
        minRankToViewUnassigned: rules.minRankToViewUnassignedLeads,
        ...(q.status ? { status: q.status } : {}),
        ...(q.assigned_to ? { assigned_to: q.assigned_to } : {}),
        ...(q.assigned_user_id ? { assigned_user_id: q.assigned_user_id } : {}),
        ...(q.campaign_id ? { campaign_id: q.campaign_id } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(q.platforms ? { platforms: q.platforms.split(',') } : {}),
        ...(org_ids ? { org_ids } : {}),
      },
    );

    return reply.send({
      success: true,
      data: result.leads,
      total: result.total,
      page: result.page,
      page_size: result.page_size,
      stage_options: result.stage_options,
      stage_outcomes: result.stage_outcomes,
    });
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const data = request.body as CreateLeadInput;
    const result = await service.createLead({ org_id, user_id, role, tenant_id }, data);
    return reply.status(201).send({ success: true, data: { id: result.id } });
  };

  getById = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const lead = await service.getLeadById({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: lead });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const data = request.body as UpdateLeadInput;
    await service.updateLead({ org_id, user_id, role, tenant_id }, id, data);
    return reply.status(204).send();
  };

  delete = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < RANKS.ADMIN) throw new ForbiddenError('Only admins can delete leads');
    const { id } = request.params as { id: string };
    const comment = ((request.body as { comment?: string } | null)?.comment ?? '').trim();
    if (!comment) throw new BadRequestError('A deletion reason comment is required');
    await service.deleteLead({ org_id, user_id, role, tenant_id }, id, comment);
    return reply.status(204).send();
  };

  getTimeline = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const events = await service.getLeadTimeline({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: events });
  };

  getFormData = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const form_data = await service.getLeadFormData({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: form_data });
  };

  getInteractions = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const interactions = await service.getLeadInteractions({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: interactions });
  };

  createInteraction = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const data = request.body as CreateInteractionInput;
    const result = await service.createInteraction({ org_id, user_id, role, tenant_id }, id, data);
    return reply.status(201).send({ success: true, data: result });
  };

  getAssignmentHistory = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const history = await service.getLeadAssignmentHistory({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: history });
  };

  getFollowUps = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const follow_ups = await service.getLeadFollowUps({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: follow_ups });
  };

  listFollowUps = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const q = request.query as { assignedRepId?: string; overdueOnly?: string };
    const rules = getRulesForTenant(tenant_id);
    const pipeline = await service.listFollowUps(
      { org_id, user_id, role, tenant_id },
      {
        ...(q.assignedRepId !== undefined ? { assigned_rep_id: q.assignedRepId } : {}),
        overdue_only: q.overdueOnly === 'true',
        actor_rank: rank,
        minRankToViewUnassigned: rules.minRankToViewUnassignedLeads,
      },
    );
    return reply.send({ success: true, data: pipeline });
  };

  transfer = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (!checkTransferLeadAccess(getRulesForTenant(tenant_id), rank)) {
      throw new ForbiddenError('Insufficient permissions to transfer leads');
    }
    const { id } = request.params as { id: string };
    const { target_org_id, notes } = request.body as TransferLeadInput;
    const result = await service.transferLead({ org_id, user_id, role, tenant_id }, id, target_org_id, notes);
    return reply.status(201).send({ success: true, data: result });
  };

  getStageOptions = async (_request: FastifyRequest, reply: FastifyReply) => {
    const stages = await service.getStageOptions();
    return reply.send({ success: true, data: stages });
  };

  getStageOutcomes = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { stage_id?: string };
    const outcomes = await service.getStageOutcomes(q.stage_id);
    return reply.send({ success: true, data: outcomes });
  };
}
