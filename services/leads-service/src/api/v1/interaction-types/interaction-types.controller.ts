import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RoleTxContext } from '@platform/db';
import { RANKS } from '@platform/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './interaction-types.service.js';
import type { CreateInteractionTypeInput, UpdateInteractionTypeInput , TenantScopedQuery} from './interaction-types.schema.js';

function tenantCtx(request: FastifyRequest): RoleTxContext {
  const { tenant_id } = request.query as TenantScopedQuery;
  return { role: 'super_admin', org_id: '', user_id: request.auth.user_id, tenant_id };
}

export class InteractionTypesController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    const data = await service.list(tenantCtx(request));
    return reply.send({ success: true, data });
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    const body = request.body as CreateInteractionTypeInput;
    const data = await service.create(tenantCtx(request), body);
    return reply.status(201).send({ success: true, data });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    const { id } = request.params as { id: string };
    const body = request.body as UpdateInteractionTypeInput;
    const data = await service.update(tenantCtx(request), id, body);
    return reply.send({ success: true, data });
  };
}
