import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { interactionTypesTable } from '@platform/db/schema';

type InteractionTypeInsert = typeof interactionTypesTable.$inferInsert;
type InteractionTypeUpdate = Partial<InteractionTypeInsert>;
type InteractionTypeCreateFields = Omit<InteractionTypeInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) => tx.select().from(interactionTypesTable).where(eq(interactionTypesTable.tenantId, ctx.tenant_id)).orderBy(asc(interactionTypesTable.label)));
}

export async function create(ctx: RoleTxContext, fields: InteractionTypeCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(interactionTypesTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: InteractionTypeUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(interactionTypesTable).set(fields).where(and(eq(interactionTypesTable.id, id), eq(interactionTypesTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
