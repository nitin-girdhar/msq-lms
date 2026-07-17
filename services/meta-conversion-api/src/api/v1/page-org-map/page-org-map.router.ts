import type { FastifyInstance } from 'fastify';
import { listMappings, createMapping, updateMapping, deleteMapping } from './page-org-map.controller.js';

export async function pageOrgMapRouter(app: FastifyInstance) {
  app.get('/page-org-map', listMappings);
  app.post('/page-org-map', createMapping);
  app.patch('/page-org-map/:mappingId', updateMapping);
  app.delete('/page-org-map/:mappingId', deleteMapping);
}
