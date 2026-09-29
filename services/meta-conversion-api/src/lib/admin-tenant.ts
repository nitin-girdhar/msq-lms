import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';
import { NotFoundError } from './errors.js';

/**
 * Proves a console-supplied `?tenant_id=` names a real tenant before anything is
 * read or written under it.
 *
 * Must be called INSIDE the caller's own `withTenantConfigTx`, so the check is
 * itself RLS-scoped: `entity.tenants`' tenant_self_policy is
 * `id = app.current_tenant_id`, which the helper has just pinned to this same
 * id. A bogus or non-existent tenant then returns no row and becomes a clean
 * 404, instead of a foreign-key violation surfacing three statements later — or,
 * on a read path, an empty list that looks like "this tenant has nothing".
 *
 * Lives here rather than in one service because three admin surfaces now need
 * it (page/form mappings, campaigns, the campaign fetch) and a per-service copy
 * is how one of them ends up quietly skipping the check.
 */
export async function assertTenantExists(tx: DrizzleTx, tenantId: string): Promise<void> {
  const rows = await tx.execute(
    sql`SELECT id FROM entity.tenants WHERE id = ${tenantId}::uuid LIMIT 1`,
  );
  if ((rows as unknown as Array<{ id: string }>).length === 0) {
    throw new NotFoundError('Tenant not found');
  }
}
