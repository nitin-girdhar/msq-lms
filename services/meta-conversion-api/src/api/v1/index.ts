import type { FastifyInstance } from 'fastify';
import { webhookRouter } from './webhook/webhook.router.js';
import { capiRouter } from './capi/capi.router.js';
import { integrationRouter } from './integration/integration.router.js';
import { pageOrgMapRouter } from './page-org-map/page-org-map.router.js';

export async function v1Router(app: FastifyInstance) {
  await app.register(webhookRouter);
  await app.register(capiRouter);
  await app.register(integrationRouter);
  await app.register(pageOrgMapRouter);
}
