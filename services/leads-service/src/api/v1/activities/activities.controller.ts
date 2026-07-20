import type { FastifyRequest, FastifyReply } from 'fastify';
import { LMS_RANKS } from '@lms/authz';
import { listActivities } from '@platform/audit-log';
import { ForbiddenError } from '../../../lib/errors.js';

export class ActivitiesController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    if (rank < LMS_RANKS.ADMIN) throw new ForbiddenError();

    const activities = await listActivities({ org_id, user_id, role, tenant_id });
    return reply.send({ success: true, data: activities });
  };
}
