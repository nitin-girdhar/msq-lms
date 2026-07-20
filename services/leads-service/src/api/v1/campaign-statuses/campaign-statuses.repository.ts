import { and, asc, eq } from 'drizzle-orm';
import { withTenantConfigTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { campaignStatusesTable } from '@platform/db/schema';

type CampaignStatusInsert = typeof campaignStatusesTable.$inferInsert;
type CampaignStatusUpdate = Partial<CampaignStatusInsert>;
type CampaignStatusCreateFields = Omit<CampaignStatusInsert, 'tenantId'>;

export async function list(ctx: RoleTxContext) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, (tx) => tx.select().from(campaignStatusesTable).where(eq(campaignStatusesTable.tenantId, ctx.tenant_id)).orderBy(asc(campaignStatusesTable.label)));
}

export async function create(ctx: RoleTxContext, fields: CampaignStatusCreateFields) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.insert(campaignStatusesTable).values({ ...fields, tenantId: ctx.tenant_id }).returning();
    return row;
  });
}

export async function update(ctx: RoleTxContext, id: string, fields: CampaignStatusUpdate) {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    const [row] = await tx.update(campaignStatusesTable).set(fields).where(and(eq(campaignStatusesTable.id, id), eq(campaignStatusesTable.tenantId, ctx.tenant_id))).returning();
    return row ?? null;
  });
}
