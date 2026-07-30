import type { FastifyReply, FastifyRequest } from 'fastify';
import { ReportError } from '@platform/reporting/sql';
import { AppError, BadRequestError } from '../../../lib/errors.js';
import * as service from './reports.service.js';
import type { ReportActor } from './reports.repository.js';
import { datasetKeyParamsSchema, runQueryBodySchema } from './reports.schema.js';

function actorFrom(request: FastifyRequest): ReportActor {
  const { org_id, tenant_id, user_id, role, capabilities } = request.auth;
  return { orgId: org_id, tenantId: tenant_id, userId: user_id, role, capabilities };
}

/**
 * Translate a ReportError into this service's AppError.
 *
 * ReportError already carries the right status (403 for a scope it cannot express,
 * 404 for an unknown dataset, 400 for a bad spec or a timeout), so the mapping is
 * mechanical. It exists so the engine stays free of any dependency on this
 * service's error classes, and so a report failure gets the same response shape as
 * every other route rather than a bare 500.
 */
function rethrow(err: unknown): never {
  if (err instanceof ReportError) {
    throw new AppError(err.message, err.statusCode, err.path === undefined ? undefined : { path: err.path });
  }
  throw err;
}

export class ReportsController {
  listDatasets = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send({ success: true, data: service.listDatasets(actorFrom(request)) });
    } catch (err) {
      return rethrow(err);
    }
  };

  getDataset = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = datasetKeyParamsSchema.safeParse(request.params);
    if (!params.success) throw new BadRequestError('A dataset key is required');
    try {
      return reply.send({ success: true, data: service.getDataset(params.data.key, actorFrom(request)) });
    } catch (err) {
      return rethrow(err);
    }
  };

  /**
   * POST, not GET. A spec is too large and too nested for a query string, and it
   * must not land in access logs or browser history.
   */
  runQuery = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = runQueryBodySchema.safeParse(request.body);
    if (!body.success) {
      // The spec's own issues are the useful part — a caller cannot fix "invalid
      // body". Flattened to `path: message` lines.
      throw new BadRequestError(
        'Invalid report request',
        body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    try {
      const data = await service.runQuery(body.data.spec, actorFrom(request), {
        ...(body.data.tenantWide === true && { tenantWide: true }),
      });
      return reply.send({ success: true, data });
    } catch (err) {
      return rethrow(err);
    }
  };
}
