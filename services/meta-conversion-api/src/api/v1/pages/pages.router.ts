import type { FastifyInstance } from 'fastify';
import { listPages, listPageForms } from './pages.controller.js';

export async function pagesRouter(app: FastifyInstance) {
  app.get('/pages', listPages);
  // 1.51.0: the mapping screen's form picker.
  app.get('/pages/:pageId/forms', listPageForms);
}
