import type { FastifyInstance } from 'fastify';
import { handleWebhookChallenge, handleWebhookPost } from './webhook.controller.js';

export async function webhookRouter(app: FastifyInstance) {
  // Tenant-less: shared Meta App covering multiple tenants
  // (ext.meta_tenant_config row with tenant_id IS NULL).
  app.get('/webhook', handleWebhookChallenge);
  app.post('/webhook', handleWebhookPost);

  // Per-tenant: dedicated Meta App for a single tenant.
  app.get('/webhook/:integrationId', handleWebhookChallenge);
  app.post('/webhook/:integrationId', handleWebhookPost);
}
