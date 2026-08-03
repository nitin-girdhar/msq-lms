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
  metadata?: Record<string, unknown>;
  raw_webhook_data?: Record<string, unknown>;
}

export interface IntakeLeadResult {
  id: string;
  is_duplicate: boolean;
  existing_lead_id: string | null;
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
    throw new AppError(
      `Intake lead creation failed (${response.status})`,
      HttpStatus.BAD_GATEWAY,
      { upstreamStatus: response.status, fields: Object.keys(body) },
    );
  }

  const json = (await response.json()) as { success: boolean; data: IntakeLeadResult };
  return json.data;
}
