import type { FastifyRequest, FastifyReply } from 'fastify';
import { listActivities } from '@platform/audit-log';

export class ActivitiesController {
  // Authorization is the router's requireCapability(LMS_HISTORY_VIEW_ORG).
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const activities = await listActivities({ org_id, user_id, role, tenant_id });
    return reply.send({ success: true, data: activities });
  };
}
