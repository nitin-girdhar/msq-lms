import type { FastifyRequest, FastifyReply } from 'fastify';
import { can, resolveScope, CAPABILITY } from '@platform/rbac';
import type { CreateLeadInput, UpdateLeadInput, CreateInteractionInput, TransferLeadInput } from '@lms/validation';
import { LMS_RANKS, getRulesForTenant, checkTransferLeadAccess, checkCreateLeadAccess, checkEditLeadAccess } from '@lms/authz';
import { ForbiddenError, BadRequestError } from '../../../lib/errors.js';
import * as service from './leads.service.js';
import type { ListLeadsQuery } from './leads.schema.js';

export class LeadsController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const q = request.query as ListLeadsQuery;
    const rules = getRulesForTenant(tenant_id);

    // Cross-branch reach is a capability, not a hardcoded platform_role check —
    // only 'tenant'/'all' on the lms.leads.view scope ladder may see the branch
    // the caller asked for; everyone else is held to their own org regardless
    // of which org_ids they requested.
    //
    // The scope is resolved unconditionally (not only when org_ids is present)
    // because it now also decides WHOSE leads are visible inside those branches
    // — see visibilityClause in the repository.
    const view_scope = resolveScope(request.auth, CAPABILITY.LMS_LEADS_VIEW);
    let org_ids: string[] | undefined;
    if (q.org_ids) {
      org_ids = view_scope === 'tenant' || view_scope === 'all'
        ? q.org_ids.split(',').filter(Boolean)
        : [org_id];
    }

    const result = await service.listLeads(
      { org_id, user_id, role, tenant_id },
      {
        page: q.page,
        page_size: q.page_size,
        actor_rank: rank,
        minRankToViewUnassigned: rules.minRankToViewUnassignedLeads,
        view_scope,
        ...(q.active_only ? { active_only: true } : {}),
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
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (!checkCreateLeadAccess(request.auth)) {
      throw new ForbiddenError('Insufficient permissions to create leads');
    }
    const data = request.body as CreateLeadInput;
    const result = await service.createLead({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, data);
    return reply.status(201).send({ success: true, data: { id: result.id } });
  };

  getById = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const lead = await service.getLeadById({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: lead });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (!checkEditLeadAccess(request.auth)) {
      throw new ForbiddenError('Insufficient permissions to edit leads');
    }
    const { id } = request.params as { id: string };
    const data = request.body as UpdateLeadInput;
    // Clearing the assignee is an assignment write, so it takes an assignment
    // capability — not just lms.leads.edit. iam.can_assign_to guards the
    // non-null case inside updateLead, but it is only consulted when there IS a
    // target, which left "set back to Unassigned" the one assignment change
    // anyone able to edit the lead could make. Releasing a lead is not a
    // weaker act than handing it to a named colleague.
    if (data.assigned_user_id === null && !can(request.auth, CAPABILITY.LMS_LEADS_ASSIGN)) {
      throw new ForbiddenError('You do not have permission to change lead assignment');
    }
    // Scheduling a follow-up through this route creates a real lms.lead_follow_ups
    // row, so it takes the same capability POST /leads/:id/follow-ups demands.
    // Otherwise lms.leads.edit alone would be a way around lms.followups.create.
    if (data.follow_up_scheduled_at !== undefined && !can(request.auth, CAPABILITY.LMS_FOLLOWUPS_CREATE)) {
      throw new ForbiddenError('You do not have permission to create follow-ups');
    }
    await service.updateLead({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, id, data);
    return reply.status(204).send();
  };

  delete = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < LMS_RANKS.ADMIN) throw new ForbiddenError('Only admins can delete leads');
    const { id } = request.params as { id: string };
    const comment = ((request.body as { comment?: string } | null)?.comment ?? '').trim();
    if (!comment) throw new BadRequestError('A deletion reason comment is required');
    await service.deleteLead({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, id, comment);
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
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (!checkEditLeadAccess(request.auth)) {
      throw new ForbiddenError('Insufficient permissions to add interactions');
    }
    const { id } = request.params as { id: string };
    const data = request.body as CreateInteractionInput;
    const result = await service.createInteraction({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, id, data);
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
    if (!checkTransferLeadAccess(request.auth)) {
      throw new ForbiddenError('Insufficient permissions to transfer leads');
    }
    const { id } = request.params as { id: string };
    const { target_org_id, notes } = request.body as TransferLeadInput;
    const result = await service.transferLead({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, id, target_org_id, notes);
    return reply.status(201).send({ success: true, data: result });
  };

  getStageOptions = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const stages = await service.getStageOptions({ org_id, user_id, role, tenant_id });
    return reply.send({ success: true, data: stages });
  };

  getStageOutcomes = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const q = request.query as { stage_id?: string };
    const outcomes = await service.getStageOutcomes({ org_id, user_id, role, tenant_id }, q.stage_id);
    return reply.send({ success: true, data: outcomes });
  };
}
