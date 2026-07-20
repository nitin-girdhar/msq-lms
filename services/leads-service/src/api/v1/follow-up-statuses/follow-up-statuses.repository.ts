import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { followUpStatusesTable } from '@crm/db/schema';

type FollowUpStatusInsert = typeof followUpStatusesTable.$inferInsert;
type FollowUpStatusUpdate = Partial<FollowUpStatusInsert>;
type FollowUpStatusCreateFields = Omit<FollowUpStatusInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) => tx.select().from(followUpStatusesTable).where(eq(followUpStatusesTable.tenantId, ctx.tenant_id)).orderBy(asc(followUpStatusesTable.label)));
}

export async function create(ctx: RoleTxContext, fields: FollowUpStatusCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(followUpStatusesTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: FollowUpStatusUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(followUpStatusesTable).set(fields).where(and(eq(followUpStatusesTable.id, id), eq(followUpStatusesTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
