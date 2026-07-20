import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CreateFollowUpInput } from '@lms/validation';
import * as service from './follow-ups.service.js';
import type { UpdateFollowUpBody } from './follow-ups.schema.js';

export class FollowUpsController {
  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const data = request.body as CreateFollowUpInput;
    const result = await service.createFollowUp({ org_id, user_id, role, tenant_id }, id, data);
    return reply.status(201).send({ success: true, data: result });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id, follow_up_id } = request.params as { id: string; follow_up_id: string };
    const body = request.body as UpdateFollowUpBody;
    await service.updateFollowUp({ org_id, user_id, role, tenant_id }, follow_up_id, id, body);
    return reply.status(204).send();
  };

  delete = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id, follow_up_id } = request.params as { id: string; follow_up_id: string };
    await service.deleteFollowUp({ org_id, user_id, role, tenant_id }, follow_up_id, id);
    return reply.status(204).send();
  };
}
