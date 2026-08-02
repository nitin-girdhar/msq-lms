import type { FastifyRequest, FastifyReply } from 'fastify';
import * as repo from './lookups.repository.js';

// geo ids are UUID v7 now, not identity ints. These parse defensively rather
// than throwing: a malformed id is dropped, which degrades to "no filter"
// exactly as an absent parameter did before. The repository interpolates the
// survivors into a ::uuid[] cast, so anything non-UUID must not get through.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined;
}

function parseUuidList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s));
}

export class LookupsController {
  getLookups = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const data = await repo.getLookups({ org_id, user_id, role, tenant_id });
    return reply.send({ success: true, data });
  };

  getCities = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const q = request.query as { state_id?: string };
    const stateId = parseUuid(q.state_id);
    const cities = await repo.getCities({ org_id, user_id, role, tenant_id }, stateId);
    return reply.send({ success: true, data: cities });
  };

  getLocations = async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, user_id, role, tenant_id } = request.auth;
    const q = request.query as Record<string, string>;
    const level = q['level'];
    const countryIds = parseUuidList(q['countryIds'] ?? q['country_id']);
    const stateIds = parseUuidList(q['stateIds'] ?? q['state_id']);
    const data = await repo.getLocations({ org_id, user_id, role, tenant_id }, level, countryIds, stateIds);
    return reply.send({ success: true, data });
  };
}
