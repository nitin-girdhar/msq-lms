import type { FastifyInstance } from 'fastify';
import { listAdAccounts, syncAdAccounts, updateAdAccount } from './ad-accounts.controller.js';

export async function adAccountsRouter(app: FastifyInstance) {
  app.get('/ad-accounts', listAdAccounts);
  app.post('/ad-accounts/sync', syncAdAccounts);
  app.patch('/ad-accounts/:adAccountId', updateAdAccount);
}
