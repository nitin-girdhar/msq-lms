import type { FastifyInstance } from 'fastify';
import { listInbox, retryInbox, ignoreInbox } from './lead-inbox.controller.js';

export async function leadInboxRouter(app: FastifyInstance) {
  app.get('/lead-inbox', listInbox);
  app.post('/lead-inbox/:id/retry', retryInbox);
  app.post('/lead-inbox/:id/ignore', ignoreInbox);
}
