import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import type { RoleTxContext } from '@platform/db';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './lead-stage-capi-events.service.js';
import type { PutMappingsInput, TenantScopedQuery } from './lead-stage-capi-events.schema.js';

function tenantCtx(request: FastifyRequest): RoleTxContext {
  const { tenant_id } = request.query as TenantScopedQuery;
  return { role: 'super_admin', org_id: '', user_id: request.auth.user_id, tenant_id };
}

export class LeadStageCapiEventsController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    const data = await service.list(tenantCtx(request));
    return reply.send({ success: true, data });
  };

  put = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    const data = await service.putMappings(tenantCtx(request), request.body as PutMappingsInput);
    return reply.send({ success: true, data });
  };
}
