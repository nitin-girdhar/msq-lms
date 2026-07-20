import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { leadStageTable } from '@platform/db/schema';

type LeadStageInsert = typeof leadStageTable.$inferInsert;
type LeadStageUpdate = Partial<LeadStageInsert>;
type LeadStageCreateFields = Omit<LeadStageInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) => tx.select().from(leadStageTable).where(eq(leadStageTable.tenantId, ctx.tenant_id)).orderBy(asc(leadStageTable.label)));
}

// Used by lead-stage-outcome to validate a stage_id FK before insert/update.
export async function getById(ctx: RoleTxContext, id: string) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.select().from(leadStageTable).where(and(eq(leadStageTable.id, id), eq(leadStageTable.tenantId, ctx.tenant_id)));
    return row ?? null;
  });
}

export async function create(ctx: RoleTxContext, fields: LeadStageCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(leadStageTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: LeadStageUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(leadStageTable).set(fields).where(and(eq(leadStageTable.id, id), eq(leadStageTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
