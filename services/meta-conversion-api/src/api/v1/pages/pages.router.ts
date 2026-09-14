import type { FastifyInstance } from 'fastify';
import { listPages } from './pages.controller.js';

export async function pagesRouter(app: FastifyInstance) {
  app.get('/pages', listPages);
}
