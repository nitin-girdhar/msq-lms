import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RoleTxContext } from '@platform/db';
import { RANKS } from '@platform/authz';
import { ForbiddenError } from '../../../lib/errors.js';
import * as service from './campaign-types.service.js';
import type {
  CampaignTypesScopeQuery,
  CreateCampaignTypeBody,
  UpdateCampaignTypeBody,
} from './campaign-types.schema.js';

/**
 * Which tenant's catalog this request acts on.
 *
 * `?tenant_id=` is honoured ONLY for a platform super_admin, and the rank is
 * re-checked here rather than trusted to the router gate alone: this is the line
 * that turns a client-supplied id into the transaction's tenant, so it must hold
 * on its own. Everyone else acts on their own session tenant — the gateway-signed
 * request.auth, never the body or the query.
 *
 * org_id is '' on the admin path, as in lead-sources.controller.ts: a super admin
 * holds no membership in the administered tenant, the tenant-config transaction
 * never reads it, and logActivity records an empty org as NULL.
 */
function scopeCtx(request: FastifyRequest): RoleTxContext {
  const { tenant_id: administered } = request.query as CampaignTypesScopeQuery;
  const { org_id, user_id, role, tenant_id, rank } = request.auth;
  if (administered) {
    if (rank < RANKS.SUPER_ADMIN) throw new ForbiddenError('Super admin only');
    return { role: 'super_admin', org_id: '', user_id, tenant_id: administered };
  }
  return { org_id, user_id, role, tenant_id };
}

export class CampaignTypesController {
  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await service.listCampaignTypes(scopeCtx(request));
    return reply.send({ success: true, data });
  };

  getById = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = await service.getCampaignTypeById(scopeCtx(request), id);
    return reply.send({ success: true, data });
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateCampaignTypeBody;
    const result = await service.createCampaignType(scopeCtx(request), body);
    return reply.status(201).send({ success: true, data: { id: result.id } });
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateCampaignTypeBody;
    await service.updateCampaignType(scopeCtx(request), id, body);
    return reply.status(204).send();
  };

  delete = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await service.deleteCampaignType(scopeCtx(request), id);
    return reply.status(204).send();
  };
}
