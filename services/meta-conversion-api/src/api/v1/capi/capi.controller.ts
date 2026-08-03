import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { triggerCapiEvent, type CapiTriggerResult } from '../../../services/capi-trigger.service.js';
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

/**
 * Emits the one line that says whether an event actually reached Meta.
 *
 * Both endpoints answer HTTP 200 for SUCCESS, SKIPPED and FAILED alike, so the
 * status code carries no information — a caller watching the logs sees a wall
 * of identical 200s whether or not anything was sent. Worse, the six skip paths
 * are never persisted (ext.meta_capi_outbound_logs only records real send
 * attempts), so without this line a silently-skipping integration is invisible.
 *
 * Every field is an ID or an enum. The lead's PII is never included: the
 * marketingLeadId identifies the record precisely for anyone who needs to look
 * it up, and the redaction in @platform/logger would censor the rest anyway.
 */
function logOutcome(
  request: FastifyRequest,
  result: CapiTriggerResult,
  fields: Record<string, unknown>,
): void {
  const level = result.status === 'FAILED' ? 'warn' : 'info';
  request.log[level](
    {
      evt: 'capi.trigger',
      outcome: result.status,
      reason_code: result.reasonCode,
      logId: result.logId,
      ...fields,
    },
    'CAPI trigger',
  );
}

export async function handleManualCrmEvent(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  const body = ManualCrmEventSchema.parse(request.body);

  const startedAt = Date.now();
  const result = await triggerCapiEvent({
    marketingLeadId: body.marketingLeadId,
    orgId: ctx.org_id,
    eventName: body.eventName,
    actionSource: body.actionSource as ActionSource,
    triggeredBy: 'manual',
    triggeredByUserId: ctx.user_id,
  });

  logOutcome(request, result, {
    triggeredBy: 'manual',
    marketingLeadId: body.marketingLeadId,
    orgId: ctx.org_id,
    eventName: body.eventName,
    durationMs: Date.now() - startedAt,
  });

  const httpStatus = result.status === 'FAILED' ? 502 : 200;
  return reply.status(httpStatus).send({
    success: result.status !== 'FAILED',
    status: result.status,
    reason: result.reason,
    reasonCode: result.reasonCode,
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
    // A mismatched INTERNAL_SERVICE_SECRET between leads-service and this
    // container silently drops every auto-trigger: the caller discards the
    // response, and nothing here recorded the rejection. Log it loudly —
    // a burst of these means a misconfigured deployment, not an attack.
    request.log.warn(
      { evt: 'capi.auto_trigger.unauthorized', secretConfigured: Boolean(INTERNAL_SECRET) },
      'Rejected auto-trigger with invalid internal secret',
    );
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = AutoTriggerSchema.parse(request.body);

  const startedAt = Date.now();
  const result = await triggerCapiEvent({
    marketingLeadId: body.marketingLeadId,
    orgId: body.orgId,
    newStageId: body.newStageId,
    actionSource: 'system_generated',
    triggeredBy: 'auto_stage_change',
  });

  logOutcome(request, result, {
    triggeredBy: 'auto_stage_change',
    marketingLeadId: body.marketingLeadId,
    orgId: body.orgId,
    newStageId: body.newStageId,
    durationMs: Date.now() - startedAt,
  });

  return reply.status(200).send({
    success: result.status !== 'FAILED',
    status: result.status,
    reason: result.reason,
    reasonCode: result.reasonCode,
    logId: result.logId,
  });
}
