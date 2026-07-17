import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@crm/permissions';
import { listActivities } from '@crm/audit-log';
import { ForbiddenError } from '../../../lib/errors.js';

export class ActivitiesController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < RANKS.ADMIN) throw new ForbiddenError();

    const activities = await listActivities({ org_id, user_id, role, tenant_id });
    return reply.send({ success: true, data: activities });
  };
}
