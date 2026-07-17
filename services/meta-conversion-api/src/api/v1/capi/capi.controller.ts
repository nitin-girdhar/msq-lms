import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { triggerCapiEvent } from '../../../services/capi-trigger.service.js';
import { parseAuthContext } from '../../../lib/auth-context.js';
import { metaConfig } from '../../../config/meta.config.js';
import type { ActionSource } from '../../../services/capi-payload.builder.js';

const ManualCrmEventSchema = z.object({
  marketingLeadId: z.string().uuid(),
  eventName: z.string().min(1).default('Lead'),
  actionSource: z
    .string()
    .refine(
      (v) => (metaConfig.capi.supported_action_sources as readonly string[]).includes(v),
      (v) => ({ message: `actionSource "${v}" is not supported` }),
    )
    .default('system_generated'),
  eventSourceUrl: z.string().url().optional(),
});

const AutoTriggerSchema = z.object({
  marketingLeadId: z.string().uuid(),
  orgId: z.string().uuid(),
  newStageId: z.string().uuid(),
});

export async function handleManualCrmEvent(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const body = ManualCrmEventSchema.parse(request.body);

  const result = await triggerCapiEvent({
    marketingLeadId: body.marketingLeadId,
    orgId: ctx.org_id,
    eventName: body.eventName,
    actionSource: body.actionSource as ActionSource,
    triggeredBy: 'manual',
    triggeredByUserId: ctx.user_id,
  });

  const httpStatus = result.status === 'FAILED' ? 502 : 200;
  return reply.status(httpStatus).send({
    success: result.status !== 'FAILED',
    status: result.status,
    reason: result.reason,
    logId: result.logId,
  });
}

export async function handleAutoTrigger(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const secret = request.headers['x-internal-secret'] as string | undefined;
  const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'];
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = AutoTriggerSchema.parse(request.body);

  const result = await triggerCapiEvent({
    marketingLeadId: body.marketingLeadId,
    orgId: body.orgId,
    newStageId: body.newStageId,
    actionSource: 'system_generated',
    triggeredBy: 'auto_stage_change',
  });

  return reply.status(200).send({
    success: result.status !== 'FAILED',
    status: result.status,
    reason: result.reason,
    logId: result.logId,
  });
}
