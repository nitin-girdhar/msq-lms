import type { FastifyRequest, FastifyReply } from 'fastify';
import { can, CAPABILITY } from '@platform/rbac';
import type { CreateFollowUpInput } from '@lms/validation';
import { LMS_RANKS, checkEditLeadAccess } from '@lms/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './follow-ups.service.js';
import type { UpdateFollowUpBody } from './follow-ups.schema.js';

// Follow-ups are lead mutations; gate them on the same lms.leads.edit capability
// as the leads write routes, so read_only cannot create/edit/delete them.
function assertCanEdit(auth: FastifyRequest['auth']): void {
  if (!checkEditLeadAccess(auth)) {
    throw new ForbiddenError('Insufficient permissions to modify follow-ups');
  }
}

const isReadOnly = (rank: number): boolean => rank <= LMS_RANKS.READ_ONLY;

export class FollowUpsController {
  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    assertCanEdit(request.auth);
    const { id } = request.params as { id: string };
    const data = request.body as CreateFollowUpInput;
    const result = await service.createFollowUp({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, id, data);
    return reply.status(201).send({ success: true, data: result });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    assertCanEdit(request.auth);
    const { id, follow_up_id } = request.params as { id: string; follow_up_id: string };
    const body = request.body as UpdateFollowUpBody;
    await service.updateFollowUp({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, follow_up_id, id, body);
    return reply.status(204).send();
  };

  delete = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id, rank } = request.auth;
    assertCanEdit(request.auth);
    const { id, follow_up_id } = request.params as { id: string; follow_up_id: string };
    await service.deleteFollowUp({ org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) }, follow_up_id, id);
    return reply.status(204).send();
  };
}
