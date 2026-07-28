import type { FastifyRequest, FastifyReply } from 'fastify';
import { can, CAPABILITY } from '@platform/rbac';
import type { SendLeadWhatsAppInput } from '@lms/validation';
import { checkEditLeadAccess } from '@lms/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './whatsapp.service.js';

export class WhatsAppController {
  listTemplates = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const { id } = request.params as { id: string };
    const data = await service.listTemplates({ org_id, user_id, role, tenant_id }, id);
    return reply.send({ success: true, data });
  };

  send = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    // Same lead-scope check the interaction/follow-up writes use: holding the
    // whatsapp.send capability is not enough, the actor must also be allowed to
    // act on THIS lead (own / team / branch, per their scope).
    if (!checkEditLeadAccess(request.auth)) {
      throw new ForbiddenError('Insufficient permissions to message this lead');
    }
    const { id } = request.params as { id: string };
    const { template_id } = request.body as SendLeadWhatsAppInput;
    const data = await service.sendToLead(
      { org_id, user_id, role, tenant_id, readOnly: !can(request.auth, CAPABILITY.PLATFORM_WRITE) },
      tenant_id,
      id,
      template_id,
    );
    return reply.send({ success: true, data });
  };
}
