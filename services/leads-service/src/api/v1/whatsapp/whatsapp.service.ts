import type { RoleTxContext } from '@platform/db';
import { last10Digits } from '@platform/db';
import { logActivity } from '@platform/audit-log';
import { fetchWithTimeout, UpstreamTimeoutError } from '@platform/http';
import { AppError, BadRequestError, NotFoundError, HttpStatus } from '../../../lib/errors.js';
import { config } from '../../../config/index.js';
import * as leadsRepo from '../leads/leads.repository.js';
import * as leadsService from '../leads/leads.service.js';
import * as repo from './whatsapp.repository.js';
import type { WhatsAppTemplateRow } from './whatsapp.repository.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'] ?? '';

// The complete set of placeholder tokens a template row may reference. Anything
// else is a seeding/config mistake, and is surfaced as a 500 rather than being
// passed through — a template must never carry caller-supplied text.
const PLACEHOLDER_TOKENS = ['lead_first_name', 'lead_full_name', 'rep_name', 'org_name'] as const;
type PlaceholderToken = (typeof PLACEHOLDER_TOKENS)[number];

function isPlaceholderToken(t: string): t is PlaceholderToken {
  return (PLACEHOLDER_TOKENS as readonly string[]).includes(t);
}

export interface TemplateSummary {
  id: string;
  name: string;
  label: string;
  description: string | null;
  preview_text: string | null;
}

export async function listTemplates(
  ctx: RoleTxContext,
  leadId: string,
): Promise<TemplateSummary[]> {
  // Resolve the lead first so an unreadable/absent lead 404s instead of leaking
  // the template catalog to someone who cannot see the lead.
  const lead = await leadsRepo.getLeadById(ctx, leadId);
  if (!lead) throw new NotFoundError('Lead not found');

  const rows = await repo.listTemplates(ctx);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    label: r.label,
    description: r.description,
    preview_text: r.preview_text,
  }));
}

function resolvePlaceholders(
  fields: string[],
  values: Record<PlaceholderToken, string>,
  templateName: string,
): string[] {
  return fields.map((field) => {
    if (!isPlaceholderToken(field)) {
      throw new AppError(
        `WhatsApp template '${templateName}' references unknown placeholder '${field}'`,
        HttpStatus.INTERNAL,
      );
    }
    // Interakt rejects empty placeholder values, so fall back rather than send
    // a blank that would render as "Hi ,".
    return values[field] || 'there';
  });
}

interface SendResult {
  sent_to: string;
  template_label: string;
  interaction_id: string | null;
}

// Shape of communication-service's response envelope for a WhatsApp send.
interface CommsResponse {
  success?: boolean;
  data?: {
    results?: Array<{
      channel: string;
      success: boolean;
      error?: string;
      data?: { messages?: Array<{ phoneNumber: string; success: boolean; error?: string }> };
    }>;
  };
  error?: string;
}

/**
 * Reads the ACTUAL per-recipient outcome out of a communication-service reply.
 *
 * Necessary because `sendWhatsAppTemplate` marks the whatsapp channel
 * `success: true` even when every individual number failed — it only reports
 * transport-level failure at that level. The real status lives in
 * `data.results[].data.messages[].success`. Trusting the outer flag would log
 * failed sends as delivered.
 */
function extractSendError(body: CommsResponse): string | null {
  const channel = body.data?.results?.find((r) => r.channel === 'whatsapp');
  if (!channel) return body.error ?? 'WhatsApp service returned no result';
  if (!channel.success) return channel.error ?? 'WhatsApp send failed';

  const messages = channel.data?.messages ?? [];
  if (messages.length === 0) return 'WhatsApp service returned no message result';

  const failed = messages.find((m) => !m.success);
  return failed ? (failed.error ?? 'WhatsApp send failed') : null;
}

export async function sendToLead(
  ctx: RoleTxContext,
  tenantId: string,
  leadId: string,
  templateId: string,
): Promise<SendResult> {
  const lead = await leadsRepo.getLeadById(ctx, leadId);
  if (!lead) throw new NotFoundError('Lead not found');

  const phone = lead['phone'] ? String(lead['phone']) : '';
  // Mirrors the recipient normalisation the gateway does for the public comms
  // API: compare/validate on the last 10 digits so formatting and country-code
  // differences do not matter. Anything shorter cannot be dialled.
  if (last10Digits(phone).length !== 10) {
    throw new BadRequestError('This lead has no usable WhatsApp number');
  }

  const template: WhatsAppTemplateRow | null = await repo.getTemplateById(ctx, templateId);
  if (!template) throw new NotFoundError('WhatsApp template not found');

  const repName = await repo.getActorName(ctx);
  const values: Record<PlaceholderToken, string> = {
    lead_first_name: String(lead['first_name'] ?? ''),
    lead_full_name: String(lead['full_name'] ?? ''),
    rep_name: repName ?? '',
    org_name: String(lead['org_name'] ?? ''),
  };

  const bodyValues = resolvePlaceholders(template.body_fields ?? [], values, template.name);
  const headerValues = resolvePlaceholders(template.header_fields ?? [], values, template.name);

  // communication-service's /public-send is the service-to-service entry point
  // (guarded by requireInternalSecret, tenant read from headers). The
  // user-facing /whatsapp/template route instead expects gateway-injected auth
  // headers and is not callable from here.
  let response: Response;
  try {
    response = await fetchWithTimeout(`${config.communicationServiceUrl}/api/v1/communications/public-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
        'x-org-id': ctx.org_id,
        'x-user-id': ctx.user_id,
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({
        phone_numbers: [phone],
        template_name: template.provider_template_name,
        language_code: template.language_code,
        ...(bodyValues.length ? { body_values: bodyValues } : {}),
        ...(headerValues.length ? { header_values: headerValues } : {}),
      }),
      timeoutMs: config.communicationServiceTimeoutMs,
      target: 'communication-service/public-send',
    });
  } catch (err) {
    // 504 rather than 502 on a timeout: communication-service in turn calls
    // Interakt, so the likeliest cause is a slow third party rather than a dead
    // service, and the send may well have gone out. Say so — the alternative is
    // a user re-sending a WhatsApp message that already reached the customer.
    if (err instanceof UpstreamTimeoutError) {
      throw new AppError(
        'The messaging service did not respond in time. The message may still have been sent — check the lead timeline before retrying.',
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    throw new AppError(
      `Could not reach the messaging service: ${(err as Error).message}`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  const body = (await response.json().catch(() => null)) as CommsResponse | null;

  if (!response.ok || !body) {
    throw new AppError(
      body?.error ?? `Messaging service returned ${response.status}`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  const sendError = extractSendError(body);
  if (sendError) {
    // Deliberately no interaction row: the timeline must only ever claim a
    // message that actually left the building.
    throw new AppError(`WhatsApp send failed: ${sendError}`, HttpStatus.BAD_GATEWAY);
  }

  // Log through the leads service (not the repository) so the whatsapp
  // interaction type lookup, the cross-org actor resolution and the
  // 'interaction_created' activity all behave exactly as a manual log would.
  const interaction = await leadsService.createInteraction(ctx, leadId, {
    interaction_type: 'whatsapp',
    notes: `WhatsApp sent: ${template.label} (template: ${template.provider_template_name}) to ${phone}`,
  });

  await logActivity({
    action_type: 'whatsapp_sent',
    performed_by: ctx.user_id,
    lead_id: leadId,
    org_id: ctx.org_id,
    new_value: { template_name: template.provider_template_name, template_label: template.label },
  });

  return {
    sent_to: phone,
    template_label: template.label,
    interaction_id: interaction?.id ?? null,
  };
}
