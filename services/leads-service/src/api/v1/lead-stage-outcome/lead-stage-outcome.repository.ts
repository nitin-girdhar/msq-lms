import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { leadStageOutcomeTable, leadStageTable } from '@platform/db/schema';

type LeadStageOutcomeInsert = typeof leadStageOutcomeTable.$inferInsert;
type LeadStageOutcomeUpdate = Partial<LeadStageOutcomeInsert>;
type LeadStageOutcomeCreateFields = Omit<LeadStageOutcomeInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) =>
    tx
      .select({
        id: leadStageOutcomeTable.id,
        stageId: leadStageOutcomeTable.stageId,
        name: leadStageOutcomeTable.name,
        label: leadStageOutcomeTable.label,
        description: leadStageOutcomeTable.description,
        requiresComment: leadStageOutcomeTable.requiresComment,
        sortOrder: leadStageOutcomeTable.sortOrder,
        isActive: leadStageOutcomeTable.isActive,
        stageName: leadStageTable.name,
        stageLabel: leadStageTable.label,
      })
      .from(leadStageOutcomeTable)
      .leftJoin(leadStageTable, eq(leadStageOutcomeTable.stageId, leadStageTable.id))
      .where(eq(leadStageOutcomeTable.tenantId, ctx.tenant_id))
      .orderBy(asc(leadStageOutcomeTable.label)),
  );
}

export async function create(ctx: RoleTxContext, fields: LeadStageOutcomeCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(leadStageOutcomeTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: LeadStageOutcomeUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(leadStageOutcomeTable).set(fields).where(and(eq(leadStageOutcomeTable.id, id), eq(leadStageOutcomeTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
