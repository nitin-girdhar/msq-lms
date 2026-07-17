import type { FastifyRequest } from 'fastify';
import type { ZodSchema } from 'zod';

export function validate(schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return async (request: FastifyRequest): Promise<void> => {
    if (schemas.body)   request.body   = schemas.body.parse(request.body);
    if (schemas.query)  request.query  = schemas.query.parse(request.query) as typeof request.query;
    if (schemas.params) request.params = schemas.params.parse(request.params) as typeof request.params;
  };
}
