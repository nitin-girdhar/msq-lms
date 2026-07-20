import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { marketingPlatformsTable } from '@crm/db/schema';

type MarketingPlatformInsert = typeof marketingPlatformsTable.$inferInsert;
type MarketingPlatformUpdate = Partial<MarketingPlatformInsert>;
type MarketingPlatformCreateFields = Omit<MarketingPlatformInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) => tx.select().from(marketingPlatformsTable).where(eq(marketingPlatformsTable.tenantId, ctx.tenant_id)).orderBy(asc(marketingPlatformsTable.label)));
}

export async function create(ctx: RoleTxContext, fields: MarketingPlatformCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(marketingPlatformsTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: MarketingPlatformUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(marketingPlatformsTable).set(fields).where(and(eq(marketingPlatformsTable.id, id), eq(marketingPlatformsTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
