import type { FastifyInstance } from 'fastify';
import { authenticateSuperAdmin } from '../../../middleware/super-admin.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import { createMarketingPlatformSchema, updateMarketingPlatformSchema , tenantScopedQuerySchema} from './marketing-platforms.schema.js';
import { MarketingPlatformsController } from './marketing-platforms.controller.js';

export async function marketingPlatformsRouter(app: FastifyInstance) {
  const ctrl = new MarketingPlatformsController();

  app.get('/lookups/marketing-platforms',       { preHandler: [authenticateSuperAdmin, validate({ query: tenantScopedQuerySchema })] }, ctrl.list);
  app.post('/lookups/marketing-platforms',      { preHandler: [authenticateSuperAdmin, validate({ body: createMarketingPlatformSchema, query: tenantScopedQuerySchema })] }, ctrl.create);
  app.patch('/lookups/marketing-platforms/:id', { preHandler: [authenticateSuperAdmin, validate({ body: updateMarketingPlatformSchema, query: tenantScopedQuerySchema })] }, ctrl.update);
}
