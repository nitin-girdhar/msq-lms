import { createHash } from 'crypto';

export type ActionSource =
  | 'website'
  | 'app'
  | 'phone_call'
  | 'chat'
  | 'email'
  | 'other'
  | 'system_generated';

export interface CapiUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  wa?: string;
}

export interface CapiEventData {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: ActionSource;
  event_source_url?: string;
  user_data: CapiUserData;
  custom_data: Record<string, unknown>;
}

export interface CapiRequestBody {
  data: CapiEventData[];
}

export interface LeadPiiFields {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  whatsapp_number?: string | null;
}

export interface CapiPayloadInput {
  lead: LeadPiiFields;
  leadId: string;
  formId: string;
  eventName: string;
  actionSource: ActionSource;
  triggeredAt?: Date;
  eventSourceUrl?: string;
  customData?: Record<string, unknown>;
}

export interface CapiPayloadResult {
  eventId: string;
  requestPayload: CapiEventData;
  apiBody: CapiRequestBody;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function hashEmail(email: string): string {
  return sha256Hex(email.toLowerCase().trim());
}

function hashName(name: string): string {
  return sha256Hex(name.toLowerCase().trim());
}

function hashPhone(phone: string): string {
  return sha256Hex(phone.replace(/\D/g, ''));
}

function buildUserData(lead: LeadPiiFields): CapiUserData {
  const userData: CapiUserData = {};
  if (lead.email)           userData.em = hashEmail(lead.email);
  if (lead.phone)           userData.ph = hashPhone(lead.phone);
  if (lead.first_name)      userData.fn = hashName(lead.first_name);
  if (lead.last_name)       userData.ln = hashName(lead.last_name);
  if (lead.whatsapp_number) userData.wa = hashPhone(lead.whatsapp_number);
  return userData;
}

function buildEventId(leadId: string, eventName: string): string {
  return sha256Hex(`${leadId}:${eventName}`);
}

export function buildCapiPayload(input: CapiPayloadInput): CapiPayloadResult {
  const eventId = buildEventId(input.leadId, input.eventName);
  const eventTime = Math.floor((input.triggeredAt ?? new Date()).getTime() / 1000);
  const userData = buildUserData(input.lead);

  const requestPayload: CapiEventData = {
    event_name: input.eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: input.actionSource,
    ...(input.eventSourceUrl ? { event_source_url: input.eventSourceUrl } : {}),
    user_data: userData,
    custom_data: {
      lead_id: input.leadId,
      form_id: input.formId,
      ...(input.customData ?? {}),
    },
  };

  return {
    eventId,
    requestPayload,
    apiBody: { data: [requestPayload] },
  };
}
