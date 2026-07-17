import type { FastifyRequest, FastifyReply } from 'fastify';
import * as repo from './lookups.repository.js';

export class LookupsController {
  getLookups = async (_request: FastifyRequest, reply: FastifyReply) => {
    const data = await repo.getLookups();
    return reply.send({ success: true, data });
  };

  getCities = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { state_id?: string };
    const stateId = q.state_id ? parseInt(q.state_id, 10) : undefined;
    const cities = await repo.getCities(stateId);
    return reply.send({ success: true, data: cities });
  };

  getLocations = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>;
    const level = q['level'];
    const countryIds = q['countryIds']
      ? q['countryIds'].split(',').map(Number).filter(Boolean)
      : q['country_id'] ? [parseInt(q['country_id'], 10)] : [];
    const stateIds = q['stateIds']
      ? q['stateIds'].split(',').map(Number).filter(Boolean)
      : q['state_id'] ? [parseInt(q['state_id'], 10)] : [];
    const data = await repo.getLocations(level, countryIds, stateIds);
    return reply.send({ success: true, data });
  };
}
