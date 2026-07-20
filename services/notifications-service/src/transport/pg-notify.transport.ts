import { pgListen } from '@platform/db';
import type { EventTransport, LeadEvent } from './types.js';

const CHANNEL = 'crm_events';

export class PgNotifyTransport implements EventTransport {
  private unlisten: (() => Promise<void>) | null = null;

  async subscribe(handler: (event: LeadEvent) => void): Promise<void> {
    this.unlisten = await pgListen(CHANNEL, (payload: string) => {
      try {
        const event = JSON.parse(payload) as LeadEvent;
        handler(event);
      } catch (err) {
        console.error('[pg-notify-transport] Failed to parse NOTIFY payload:', err);
      }
    });
  }

  async close(): Promise<void> {
    if (this.unlisten) {
      await this.unlisten();
      this.unlisten = null;
    }
  }
}
