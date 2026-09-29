import type { FastifyInstance } from 'fastify';
import { webhookRouter } from './webhook/webhook.router.js';
import { capiRouter } from './capi/capi.router.js';
import { integrationRouter } from './integration/integration.router.js';
import { pageOrgMapRouter } from './page-org-map/page-org-map.router.js';
import { pagesRouter } from './pages/pages.router.js';
import { campaignsRouter } from './campaigns/campaigns.router.js';
import { leadPullRouter } from './lead-pull/lead-pull.router.js';
import { adAccountsRouter } from './ad-accounts/ad-accounts.router.js';
import { leadInboxRouter } from './lead-inbox/lead-inbox.router.js';

export async function v1Router(app: FastifyInstance) {
  await app.register(webhookRouter);
  await app.register(capiRouter);
  await app.register(integrationRouter);
  await app.register(pageOrgMapRouter);
  await app.register(pagesRouter);
  await app.register(campaignsRouter);
  await app.register(leadPullRouter);
  await app.register(adAccountsRouter);
  await app.register(leadInboxRouter);
}
