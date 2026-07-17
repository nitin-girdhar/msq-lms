import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CreateAssignmentInput, UpdateAssignmentInput } from '@crm/validation';
import * as service from './assignments.service.js';
import type { ListAssignmentsQuery, LeadsHistoryQuery } from './assignments.schema.js';

export class AssignmentsController {
  listAll = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const q = request.query as ListAssignmentsQuery;
    const result = await service.listAllAssignments({ org_id, user_id, role, tenant_id }, q.page, q.page_size);
    return reply.send({ success: true, data: result.assignments, total: result.total, page: result.page, page_size: result.page_size });
  };

  listMine = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const q = request.query as LeadsHistoryQuery;

    const result = await service.listLeadsHistory(
      { org_id, user_id, role, tenant_id },
      rank,
      {
        page: q.page,
        pageSize: q.page_size,
        activeOnly: q.active_only,
        ...(q.date_from ? { dateFrom: q.date_from } : {}),
        ...(q.date_to ? { dateTo: q.date_to } : {}),
        ...(q.stage_ids ? { stageIds: q.stage_ids.split(',').filter(Boolean) } : {}),
        ...(q.outcome_ids ? { outcomeIds: q.outcome_ids.split(',').filter(Boolean) } : {}),
        ...(q.org_ids ? { orgIds: q.org_ids.split(',').filter(Boolean) } : {}),
        ...(q.assigned_to ? { assignedTo: q.assigned_to.split(',').filter(Boolean) } : {}),
      },
    );

    return reply.send({
      success: true,
      data: result.assignments,
      total: result.total,
      page: result.page,
      page_size: result.page_size,
      stage_options: result.stage_options,
      stage_outcomes: result.stage_outcomes,
    });
  };

  getById = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const assignment = await service.getAssignmentById({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data: assignment });
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const data = request.body as CreateAssignmentInput;
    const result = await service.createAssignment({ org_id, user_id, role, tenant_id }, rank, data);
    return reply.status(201).send({ success: true, data: result });
  };

  reassign = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const { id } = request.params as { id: string };
    const data = request.body as UpdateAssignmentInput;
    await service.reassignLead({ org_id, user_id, role, tenant_id }, rank, id, data);
    return reply.status(204).send();
  };

  unassign = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    const { id } = request.params as { id: string };
    await service.unassignLead({ org_id, user_id, role, tenant_id }, rank, id);
    return reply.status(204).send();
  };
}
