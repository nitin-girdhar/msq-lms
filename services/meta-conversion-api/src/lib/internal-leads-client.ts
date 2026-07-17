import { config } from '../config/index.js';

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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalServiceSecret,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Intake lead creation failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const json = (await response.json()) as { success: boolean; data: IntakeLeadResult };
  return json.data;
}
