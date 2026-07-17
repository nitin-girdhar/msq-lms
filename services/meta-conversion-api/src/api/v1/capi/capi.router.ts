import type { FastifyInstance } from 'fastify';
import { handleManualCrmEvent, handleAutoTrigger } from './capi.controller.js';

export async function capiRouter(app: FastifyInstance) {
  app.post('/crm-event', handleManualCrmEvent);
  app.post('/capi/auto-trigger', handleAutoTrigger);
}
