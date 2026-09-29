import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './lead-assignment-rerun.service.js';
import type { RerunBody, RerunQuery } from './lead-assignment-rerun.schema.js';

export class LeadAssignmentRerunController {
  // Re-checked here, not left to the router's authenticateSuperAdmin alone: this
  // is the line that turns a client-supplied tenant_id into a tenant-wide write.
  rerun = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    const { tenant_id, dry_run } = request.query as RerunQuery;
    const body = request.body as RerunBody;
    const data = await service.rerunAutoAssignment(
      { tenantId: tenant_id, actorUserId: request.auth.user_id },
      body,
      dry_run,
    );
    return reply.send({ success: true, data });
  };
}
