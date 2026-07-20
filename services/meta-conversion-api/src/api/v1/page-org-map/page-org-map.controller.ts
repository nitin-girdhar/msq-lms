import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RANKS } from '@platform/authz';
import { parseAuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import * as pageOrgMapService from '../../../services/page-org-map.service.js';

const CreateMappingSchema = z.object({
  org_id: z.string().uuid(),
  page_id: z.string().regex(/^\d+$/, 'page_id must be a numeric Meta Page ID'),
  form_id: z.string().regex(/^\d+$/, 'form_id must be a numeric Meta Form ID'),
  platform: z.enum(['fb', 'ig']),
});

const UpdateMappingSchema = z.object({
  org_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

// Registering a Page/Form -> org mapping determines where real leads land;
// only tenant admins may create/modify/delete entries. Org-level users may
// still list mappings for their own org (enforced by RLS on the read path).
export async function listMappings(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const mappings = await pageOrgMapService.listPageFormOrgMappings(ctx.tenant_id);
  return reply.send({ success: true, data: mappings });
}

export async function createMapping(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  if (ctx.rank < RANKS.TENANT_ADMIN) throw new ForbiddenError('Only tenant admins can create Meta page/form mappings');

  const body = CreateMappingSchema.parse(request.body);
  const result = await pageOrgMapService.createPageFormOrgMapping(ctx, body);
  return reply.status(201).send({ success: true, data: result });
}

export async function updateMapping(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  if (ctx.rank < RANKS.TENANT_ADMIN) throw new ForbiddenError('Only tenant admins can modify Meta page/form mappings');

  const { mappingId } = request.params as { mappingId: string };
  const body = UpdateMappingSchema.parse(request.body);
  await pageOrgMapService.updatePageFormOrgMapping(ctx, mappingId, body);
  return reply.status(204).send();
}

export async function deleteMapping(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  if (ctx.rank < RANKS.TENANT_ADMIN) throw new ForbiddenError('Only tenant admins can delete Meta page/form mappings');

  const { mappingId } = request.params as { mappingId: string };
  await pageOrgMapService.deletePageFormOrgMapping(ctx, mappingId);
  return reply.status(204).send();
}
