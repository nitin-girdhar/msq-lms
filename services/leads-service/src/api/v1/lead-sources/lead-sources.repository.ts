import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { leadSourcesTable } from '@crm/db/schema';

type LeadSourceInsert = typeof leadSourcesTable.$inferInsert;
type LeadSourceUpdate = Partial<LeadSourceInsert>;
type LeadSourceCreateFields = Omit<LeadSourceInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) => tx.select().from(leadSourcesTable).where(eq(leadSourcesTable.tenantId, ctx.tenant_id)).orderBy(asc(leadSourcesTable.label)));
}

export async function create(ctx: RoleTxContext, fields: LeadSourceCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(leadSourcesTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: LeadSourceUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(leadSourcesTable).set(fields).where(and(eq(leadSourcesTable.id, id), eq(leadSourcesTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
