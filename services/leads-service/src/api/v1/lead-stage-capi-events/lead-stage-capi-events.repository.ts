import { asc, and, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { leadStageTable, leadStageCapiEventMapTable } from '@platform/db/schema';

// One row per active stage in the tenant, with its mapping (if any) joined in
// — this is what the admin's mapping table actually renders, not the raw
// mapping table (a stage with no row would otherwise just be absent, and the
// UI would have no way to offer "map this one").
export async function listWithStages(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) =>
    tx
      .select({
        stageId: leadStageTable.id,
        stageName: leadStageTable.name,
        stageLabel: leadStageTable.label,
        capiEventTypeId: leadStageCapiEventMapTable.capiEventTypeId,
      })
      .from(leadStageTable)
      .leftJoin(leadStageCapiEventMapTable, eq(leadStageCapiEventMapTable.stageId, leadStageTable.id))
      .where(and(eq(leadStageTable.tenantId, ctx.tenant_id), eq(leadStageTable.isActive, true)))
      .orderBy(asc(leadStageTable.sortOrder), asc(leadStageTable.label)),
  );
}

export async function upsert(ctx: RoleTxContext, stageId: string, capiEventTypeId: number) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    await tx
      .insert(leadStageCapiEventMapTable)
      .values({ tenantId: ctx.tenant_id, stageId, capiEventTypeId })
      .onConflictDoUpdate({
        target: leadStageCapiEventMapTable.stageId,
        set: { capiEventTypeId, updatedAt: new Date() },
      });
  });
}

// "No event" is modeled as "no row" (capi_event_type_id is NOT NULL on the
// table), so clearing a mapping is a real delete rather than a PATCH — the one
// place in the console that deletes rather than deactivates, because there is
// no is_active column here to deactivate.
export async function remove(ctx: RoleTxContext, stageId: string) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    await tx
      .delete(leadStageCapiEventMapTable)
      .where(and(eq(leadStageCapiEventMapTable.stageId, stageId), eq(leadStageCapiEventMapTable.tenantId, ctx.tenant_id)));
  });
}
