import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';
import { NotFoundError } from './errors.js';

/**
 * Proves the tenant a transaction is pinned to names a real tenant before
 * anything is read or written under it.
 *
 * Must be called INSIDE the caller's own `withTenantConfigTx`, so the check is
 * itself RLS-scoped: `entity.tenants`' tenant_self_policy is
 * `id = app.current_tenant_id`, which the helper has just pinned to this same
 * id. A bogus `?tenant_id=` from the lookup-admin console then becomes a clean
 * 404 instead of an empty catalog that reads as "this tenant has no types" —
 * or, on a write, a foreign-key violation three statements later.
 *
 * A copy of meta-conversion-api's lib/admin-tenant.ts, not an import: services
 * share code only through workspace packages, and this is one query.
 */
export async function assertTenantExists(tx: DrizzleTx, tenantId: string): Promise<void> {
  const rows = await tx.execute(
    sql`SELECT id FROM entity.tenants WHERE id = ${tenantId}::uuid LIMIT 1`,
  );
  if ((rows as unknown as Array<{ id: string }>).length === 0) {
    throw new NotFoundError('Tenant not found');
  }
}
