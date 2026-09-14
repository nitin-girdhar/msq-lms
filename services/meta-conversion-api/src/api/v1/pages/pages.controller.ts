import type { FastifyRequest, FastifyReply } from 'fastify';
import { RANKS } from '@platform/authz';
import { withTenantConfigTx } from '@platform/db';
import { parseAuthContext } from '../../../lib/auth-context.js';
import { assertTenantExists } from '../../../lib/admin-tenant.js';
import { ForbiddenError, NotFoundError } from '../../../lib/errors.js';
import * as integrationService from '../../../services/integration.service.js';
import * as metaApi from '../../../services/meta-api.service.js';
import { tenantScopedQuerySchema } from '../page-org-map/page-org-map.schema.js';

// Page discovery for the mapping screen: without it an admin has to paste raw
// numeric Meta Page ids, which are neither memorable nor verifiable by eye.
//
// Gated on RANKS.SUPER_ADMIN and scoped by an explicit ?tenant_id=, exactly like
// the page-org-map routes, because it spends the SELECTED tenant's stored Meta
// credentials to call the Graph API on their behalf.
//
// The response carries { page_id, name } only. getManagedPages never requests
// the page access token in the first place (see its comment), so unlike
// getIntegration — which withholds secrets it has already loaded — there is no
// secret in scope here to withhold.
export async function listPages(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = parseAuthContext(request, reply);
  if (!ctx) return;

  if (ctx.rank < RANKS.SUPER_ADMIN) {
    throw new ForbiddenError('Only super admins can list Meta pages');
  }
  const { tenant_id } = tenantScopedQuerySchema.parse(request.query);

  // Prove the id names a real tenant before spending credentials on it, the
  // same check every other admin route in this service makes.
  // getIntegrationByTenantId falls back to the shared-app integration when a
  // tenant has none of its own, so without this a made-up tenant id was answered
  // with the shared app's pages instead of a 404. The fallback itself is BY
  // DESIGN: the Meta app is owned by MSquare and tenants are mapped to it, so a
  // tenant with no config row of its own correctly lists the shared app's pages.
  await withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: tenant_id }, (tx) =>
    assertTenantExists(tx, tenant_id),
  );

  const integration = await integrationService.getIntegrationByTenantId(tenant_id);
  if (!integration || !integration.is_active) {
    throw new NotFoundError('No active Meta integration configured for this tenant');
  }

  const pages = await metaApi.getManagedPages(
    integration.access_token,
    integration.graph_api_version,
  );
  return reply.send({ success: true, data: pages });
}
