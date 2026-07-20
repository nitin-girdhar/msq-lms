import type { FastifyRequest, FastifyReply } from 'fastify';
import * as service from './internal.service.js';
import type { ReassignOrgLeadsInput, KnownContactsInput } from './internal.schema.js';

export class InternalController {
  reassignOrgLeads = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ReassignOrgLeadsInput;
    const result = await service.reassignOrgLeads({
      orgId: body.org_id,
      fromUserId: body.from_user_id,
      toUserId: body.to_user_id,
      actorId: body.actor_id,
    });
    return reply.send({ success: true, data: result });
  };

  knownContacts = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as KnownContactsInput;
    const result = await service.findKnownContacts(body.tenant_id, body.emails, body.phone_keys);
    return reply.send({ success: true, data: result });
  };
}
