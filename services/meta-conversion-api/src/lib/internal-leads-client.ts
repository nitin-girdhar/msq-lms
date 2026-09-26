import { fetchWithTimeout } from '@platform/http';
import { config } from '../config/index.js';
import { AppError, HttpStatus } from './errors.js';

export interface IntakeLeadPayload {
  org_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  source?: string;
  city?: string;
  address_line1?: string;
  pincode?: string;
  // ── Meta campaign / routing ──
  //
  // These five had to be ADDED before anything could be forwarded. Until now
  // lead-sync.service.ts wrote campaign_id / adset_id / ad_id into
  // `ext.meta_leads` and passed NONE of them here — not even inside `metadata` —
  // so `lms.marketing_leads.campaign_id` was NULL for every live Meta lead and
  // the Campaign row on the lead-edit screen always read "-". The receiving
  // `WebhookLeadData` in leads-service has accepted and written them all along
  // (api/v1/intake/intake.repository.ts); this interface was the whole gap.
  //
  // Strings, not numbers: Meta campaign ids run to 17 digits, past
  // Number.MAX_SAFE_INTEGER, so a JSON number arrives with its low digits
  // already corrupted and matches the wrong campaign.
  meta_campaign_id?: string;
  meta_campaign_name?: string;
  meta_campaign_status?: string;
  meta_platform?: string;
  /** Resolved here, from `ext.meta_campaigns` — this service owns that mapping. */
  campaign_type_id?: string;
  /** `ext.meta_page_form_org_map.default_campaign_type_id`, likewise passed in. */
  default_campaign_type_id?: string;
  metadata?: Record<string, unknown>;
  raw_webhook_data?: Record<string, unknown>;
}

export interface IntakeLeadResult {
  id: string;
  is_duplicate: boolean;
  existing_lead_id: string | null;
  /** 1.51.0 -- optional so an older leads-service image still parses. */
  assigned_user_id?: string | null;
  campaign_type_id?: string | null;
  auto_assign_reason?: string | null;
}

export async function createIntakeLead(payload: IntakeLeadPayload): Promise<IntakeLeadResult> {
  const url = new URL('/api/v1/intake/webhook', config.leadsServiceUrl).toString();

  // Runs inside Meta's webhook delivery window: Meta retries a delivery it does
  // not see acknowledged quickly, so hanging here does not just leak a socket, it
  // multiplies the inbound load. Bounded short for that reason.
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalServiceSecret,
    },
    body: JSON.stringify(payload),
    timeoutMs: config.leadsServiceTimeoutMs,
    target: 'leads-service/intake',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // Do NOT stringify the body into the message. leads-service echoes the
    // rejected fields back, and the payload we just posted is a lead's name,
    // phone, email and every answer from the Meta form — so this message went
    // straight into an error-level log line as raw PII. The field names are
    // what actually diagnoses the failure; the values are not.
    //
    // `details` is the exception: leads-service builds it from field NAMES only
    // (see translatePgError), so it is safe to carry through and is the one
    // thing that says *why* the intake was rejected. `fields` stays as the
    // fallback for upstream bodies that carry no structured details.
    throw new AppError(
      `Intake lead creation failed (${response.status})`,
      HttpStatus.BAD_GATEWAY,
      {
        upstreamStatus: response.status,
        fields: Object.keys(body),
        ...(body['details'] !== undefined ? { upstream: body['details'] } : {}),
      },
    );
  }

  const json = (await response.json()) as { success: boolean; data: IntakeLeadResult };
  return json.data;
}

// ── Reclassification fan-out ────────────────────────────────────────────────

export interface ReclassifyBranchResult {
  org_id: string;
  org_name: string;
  leads_relabelled: number;
  leads_reassigned: number;
  leads_left_unassigned: number;
}

export interface ReclassifyResult {
  dry_run: boolean;
  campaigns_relabelled: number;
  leads_relabelled: number;
  leads_reassigned: number;
  leads_left_unassigned: number;
  by_branch: ReclassifyBranchResult[];
}

export interface ReclassifyRequest {
  meta_campaign_id: string;
  campaign_type_id: string;
  dry_run: boolean;
  actor_id?: string | undefined;
}

/**
 * Re-routes a campaign's existing leads after an admin corrects its type.
 *
 * This service owns `ext.meta_campaigns`; leads-service owns the leads and the
 * routing rules, so the fan-out across every branch that ran the campaign lives
 * there and is invoked over the shared-secret internal route.
 *
 * `dry_run` is sent EXPLICITLY on every call, never left to the far side's
 * default. leads-service defaults it to `true` deliberately — a caller that
 * forgets the flag should get a preview, not an unrequested fan-out — but
 * relying on that default from here would make the confirm path's behaviour
 * depend on a value defined in another repository's schema file.
 *
 * A longer timeout than intake's: this walks every branch that ran the campaign
 * and reassigns leads, where intake creates exactly one. It is also nowhere near
 * Meta's webhook delivery window — the caller is an admin who pressed Confirm
 * and is watching a spinner.
 */
export async function reclassifyCampaign(payload: ReclassifyRequest): Promise<ReclassifyResult> {
  const url = new URL('/api/v1/internal/campaign-reclassify', config.leadsServiceUrl).toString();

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalServiceSecret,
    },
    body: JSON.stringify(payload),
    timeoutMs: config.leadsReclassifyTimeoutMs,
    target: 'leads-service/campaign-reclassify',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // Field NAMES only, same rule as createIntakeLead above: the reclassify
    // response carries branch names and lead counts, and an error body echoed
    // verbatim into a log line is how PII gets there.
    throw new AppError(
      `Campaign reclassification failed (${response.status})`,
      HttpStatus.BAD_GATEWAY,
      {
        upstreamStatus: response.status,
        fields: Object.keys(body),
        ...(body['details'] !== undefined ? { upstream: body['details'] } : {}),
      },
    );
  }

  const json = (await response.json()) as { success: boolean; data: ReclassifyResult };
  return json.data;
}
