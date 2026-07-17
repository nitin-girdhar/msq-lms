import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RANKS } from '@crm/permissions';
import { parseAuthContext } from '../../../lib/auth-context.js';
import { ForbiddenError } from '../../../lib/errors.js';
import * as integrationService from '../../../services/integration.service.js';

const FieldMappingsSchema = z.object({
  contact: z.object({
    phone: z.array(z.string()).optional(),
    email: z.array(z.string()).optional(),
    first_name: z.array(z.string()).optional(),
    last_name: z.array(z.string()).optional(),
    full_name: z.array(z.string()).optional(),
    whatsapp_number: z.array(z.string()).optional(),
  }).optional(),
  address: z.object({
    street_address: z.array(z.string()).optional(),
    city: z.array(z.string()).optional(),
    state: z.array(z.string()).optional(),
    province: z.array(z.string()).optional(),
    country: z.array(z.string()).optional(),
    postal_code: z.array(z.string()).optional(),
    zip_code: z.array(z.string()).optional(),
  }).optional(),
  professional: z.object({
    job_title: z.array(z.string()).optional(),
    company_name: z.array(z.string()).optional(),
    work_email: z.array(z.string()).optional(),
    work_phone_number: z.array(z.string()).optional(),
  }).optional(),
  demographics: z.object({
    date_of_birth: z.array(z.string()).optional(),
    gender: z.array(z.string()).optional(),
    marital_status: z.array(z.string()).optional(),
    relationship_status: z.array(z.string()).optional(),
    military_status: z.array(z.string()).optional(),
  }).optional(),
});

const CreateIntegrationSchema = z.object({
  app_secret: z.string().min(1),
  verify_token: z.string().min(1),
  pixel_id: z.string().min(1),
  access_token: z.string().min(1),
  graph_api_version: z.string().optional(),
  capi_trigger_stages: z.array(z.string().uuid()).optional(),
  field_mappings: FieldMappingsSchema.optional(),
});

const UpdateIntegrationSchema = z.object({
  app_secret: z.string().min(1).optional(),
  verify_token: z.string().min(1).optional(),
  pixel_id: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  graph_api_version: z.string().optional(),
  is_active: z.boolean().optional(),
  capi_trigger_stages: z.array(z.string().uuid()).optional(),
  field_mappings: FieldMappingsSchema.optional(),
});

export async function getIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const integration = await integrationService.getIntegrationByTenantId(ctx.tenant_id);
  if (!integration) {
    return reply.status(404).send({ success: false, error: 'No Meta integration configured for this tenant' });
  }

  return reply.send({
    success: true,
    data: {
      id: integration.id,
      pixel_id: integration.pixel_id,
      graph_api_version: integration.graph_api_version,
      is_active: integration.is_active,
      capi_trigger_stages: integration.capi_trigger_stages,
      field_mappings: integration.field_mappings,
      webhook_url: `/meta/webhook/${integration.id}`,
    },
  });
}

export async function createIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  if (ctx.rank < RANKS.TENANT_ADMIN) throw new ForbiddenError('Only tenant admins can configure the Meta integration');

  const body = CreateIntegrationSchema.parse(request.body);
  const result = await integrationService.createIntegration(ctx, {
    tenant_id: ctx.tenant_id,
    app_secret: body.app_secret,
    verify_token: body.verify_token,
    pixel_id: body.pixel_id,
    access_token: body.access_token,
    graph_api_version: body.graph_api_version,
    capi_trigger_stages: body.capi_trigger_stages,
    field_mappings: body.field_mappings,
  });

  return reply.status(201).send({
    success: true,
    data: {
      id: result.id,
      webhook_url: `/meta/webhook/${result.id}`,
    },
  });
}

export async function updateIntegration(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  if (ctx.rank < RANKS.TENANT_ADMIN) throw new ForbiddenError('Only tenant admins can modify the Meta integration');

  const body = UpdateIntegrationSchema.parse(request.body);
  await integrationService.updateIntegration(ctx, {
    app_secret: body.app_secret,
    verify_token: body.verify_token,
    pixel_id: body.pixel_id,
    access_token: body.access_token,
    graph_api_version: body.graph_api_version,
    is_active: body.is_active,
    capi_trigger_stages: body.capi_trigger_stages,
    field_mappings: body.field_mappings,
  });

  return reply.status(204).send();
}
