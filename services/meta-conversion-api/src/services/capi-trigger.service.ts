import { sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';
import { getIntegrationByTenantId } from './integration.service.js';
import { sendCapiEvent } from './meta-api.service.js';
import { buildCapiPayload } from './capi-payload.builder.js';
import type { ActionSource } from './capi-payload.builder.js';

export interface CapiTriggerInput {
  marketingLeadId: string;
  orgId: string;
  eventName?: string | undefined;
  newStageId?: string | undefined;
  actionSource?: ActionSource | undefined;
  triggeredBy: 'auto_stage_change' | 'manual';
  triggeredByUserId?: string | undefined;
}

/**
 * Stable machine codes for why a CAPI event was not sent.
 *
 * Skips are NOT written to ext.meta_capi_outbound_logs — that table only
 * records actual send attempts — so this code is the only durable signal for
 * "the trigger fired but nothing reached Meta". It is logged as `reason_code`
 * and is deliberately separate from the human-readable `reason` so that
 * rewording a message never breaks a log query or an alert.
 */
export const CAPI_SKIP_REASONS = {
  LEAD_NOT_FOUND: 'Marketing lead not found',
  NOT_META_ORIGIN: 'Lead did not originate from Meta — no CAPI feedback sent',
  ORG_NOT_FOUND: 'Organization not found',
  NO_ACTIVE_INTEGRATION: 'No active Meta integration for this tenant',
  NO_EVENT_NAME_OR_STAGE: 'No eventName or newStageId provided',
  NO_STAGE_EVENT_MAPPING: 'No Meta CAPI event mapped for this lead stage',
  ALREADY_SENT: 'CAPI event already sent successfully for this lead+event',
} as const;

export type CapiSkipReason = keyof typeof CAPI_SKIP_REASONS;

export interface CapiTriggerResult {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  reason?: string | undefined;
  reasonCode?: CapiSkipReason | undefined;
  logId?: string | undefined;
}

function skip(code: CapiSkipReason): CapiTriggerResult {
  return { status: 'SKIPPED', reason: CAPI_SKIP_REASONS[code], reasonCode: code };
}

export async function triggerCapiEvent(input: CapiTriggerInput): Promise<CapiTriggerResult> {
  return withServiceTx(async (tx) => {
    // Get the marketing lead data (for PII fields)
    const leadResult = await tx.execute(
      sql`SELECT id, org_id, first_name, last_name, phone, email
          FROM lms.marketing_leads WHERE id = ${input.marketingLeadId} LIMIT 1`,
    );
    const lead = (leadResult as unknown as Array<{
      id: string; org_id: string; first_name: string | null;
      last_name: string | null; phone: string | null; email: string | null;
    }>)[0];
    if (!lead) return skip('LEAD_NOT_FOUND');

    // Try to get linked meta_lead for richer data. A lead only ever gets CAPI
    // feedback sent back to Meta if it actually originated from Meta — leads
    // created via any other source (public API, manual entry, etc.) must
    // never trigger an outbound Meta event.
    const metaResult = await tx.execute(
      sql`SELECT id, meta_lead_id::text as meta_lead_id, form_id::text as form_id,
                 email, phone, first_name, last_name, whatsapp_number
          FROM ext.meta_leads WHERE marketing_lead_id = ${input.marketingLeadId} LIMIT 1`,
    );
    const metaLead = (metaResult as unknown as Array<{
      id: string; meta_lead_id: string; form_id: string;
      email: string | null; phone: string | null; first_name: string | null;
      last_name: string | null; whatsapp_number: string | null;
    }>)[0];

    if (!metaLead) {
      return skip('NOT_META_ORIGIN');
    }

    const tenantResult = await tx.execute(
      sql`SELECT tenant_id FROM entity.organizations WHERE id = ${input.orgId} LIMIT 1`,
    );
    const tenantId = (tenantResult as unknown as Array<{ tenant_id: string }>)[0]?.tenant_id;
    if (!tenantId) return skip('ORG_NOT_FOUND');

    const integration = await getIntegrationByTenantId(tenantId);
    if (!integration || !integration.is_active) {
      return skip('NO_ACTIVE_INTEGRATION');
    }

    let eventName = input.eventName;
    if (!eventName) {
      if (!input.newStageId) {
        return skip('NO_EVENT_NAME_OR_STAGE');
      }
      // Resolve by stage_id (never by stage name text) via the lead_stage -> CAPI event mapping.
      const mappingResult = await tx.execute(
        sql`SELECT capi_event_code FROM ext.vw_lead_stage_capi_event_map WHERE stage_id = ${input.newStageId} LIMIT 1`,
      );
      const mapping = (mappingResult as unknown as Array<{ capi_event_code: string }>)[0];
      if (!mapping) {
        return skip('NO_STAGE_EVENT_MAPPING');
      }
      eventName = mapping.capi_event_code;
    }

    // Check idempotency: has a successful event already been sent?
    const existingResult = await tx.execute(
      sql`SELECT id FROM ext.meta_capi_outbound_logs
          WHERE marketing_lead_id = ${input.marketingLeadId}
            AND event_name = ${eventName}
            AND delivery_status = 'SUCCESS'
          LIMIT 1`,
    );
    if ((existingResult as unknown as Array<{ id: string }>).length > 0) {
      return skip('ALREADY_SENT');
    }

    // Build CAPI payload using the best available data
    const piiFields = {
      email: metaLead?.email ?? lead.email,
      phone: metaLead?.phone ?? lead.phone,
      first_name: metaLead?.first_name ?? lead.first_name,
      last_name: metaLead?.last_name ?? lead.last_name,
      whatsapp_number: metaLead?.whatsapp_number ?? null,
    };

    const leadIdForEvent = metaLead?.meta_lead_id ?? input.marketingLeadId;
    const formId = metaLead?.form_id ?? 'unknown';

    const payload = buildCapiPayload({
      lead: piiFields,
      leadId: leadIdForEvent,
      formId,
      eventName,
      actionSource: input.actionSource ?? 'system_generated',
    });

    // Send to Meta CAPI
    const result = await sendCapiEvent(
      integration.pixel_id,
      integration.access_token,
      integration.graph_api_version,
      payload.apiBody,
    );

    // Log the result
    const logResult = await tx.execute(
      sql`INSERT INTO ext.meta_capi_outbound_logs (
            org_id, marketing_lead_id, meta_lead_id, event_name, event_id,
            delivery_status, fb_trace_id, request_payload, response_payload,
            triggered_by, triggered_by_user_id
          ) VALUES (
            ${input.orgId}, ${input.marketingLeadId}, ${metaLead?.id ?? null},
            ${eventName}, ${payload.eventId},
            ${result.status}, ${result.fbTraceId ?? null},
            ${JSON.stringify(payload.requestPayload)},
            ${result.metaResponse ? JSON.stringify(result.metaResponse) : null},
            ${input.triggeredBy}, ${input.triggeredByUserId ?? null}
          ) RETURNING id`,
    );
    const logId = (logResult as unknown as Array<{ id: string }>)[0]?.id;

    return { status: result.status, logId };
  });
}
