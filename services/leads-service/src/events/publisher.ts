import { pgNotify } from '@crm/db';

const CHANNEL = 'crm_events';

export async function publishEvent(
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await pgNotify(CHANNEL, { type: topic, ...payload, ts: Date.now() });
    console.log(`[publishEvent] NOTIFY sent: ${topic} lead_id=${payload.lead_id}`);
  } catch (err) {
    console.error('[publishEvent] NOTIFY failed:', err);
  }
}
