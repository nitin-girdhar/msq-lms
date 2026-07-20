import { sql, eq, and, asc } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@platform/db';
import type { RoleTxContext, DrizzleTx } from '@platform/db';
import {
  adCampaignsTable,
  marketingPlatformsTable,
  campaignStatusesTable,
} from '@platform/db/schema';
import { BadRequestError } from '../../../lib/errors.js';
import type { CreateCampaignBody, UpdateCampaignBody } from './campaigns.schema.js';

export async function listCampaigns(ctx: RoleTxContext) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT ac.id, ac.org_id, ac.name, ac.budget, ac.started_at, ac.ended_at, ac.created_at, ac.updated_at,
             mp.name AS platform_name, cs.name AS status_name, cs.id AS status_id, mp.id AS platform_id,
             COUNT(ml.id) FILTER (WHERE NOT ml.is_deleted) AS lead_count
      FROM marketing.ad_campaigns ac
      JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
      JOIN marketing.campaign_statuses cs ON cs.id = ac.status_id
      LEFT JOIN lms.marketing_leads ml ON ml.campaign_id = ac.id
      WHERE NOT ac.is_deleted AND ac.org_id = ${ctx.org_id}
      GROUP BY ac.id, mp.name, cs.name, cs.id, mp.id
      ORDER BY ac.created_at DESC
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getCampaignById(ctx: RoleTxContext, campaignId: string) {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ac.id, ac.org_id, ac.name, ac.budget, ac.started_at, ac.ended_at, ac.created_at, ac.updated_at,
             mp.name AS platform_name, cs.name AS status_name, cs.id AS status_id, mp.id AS platform_id,
             COUNT(ml.id) FILTER (WHERE NOT ml.is_deleted) AS lead_count
      FROM marketing.ad_campaigns ac
      JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
      JOIN marketing.campaign_statuses cs ON cs.id = ac.status_id
      LEFT JOIN lms.marketing_leads ml ON ml.campaign_id = ac.id
      WHERE NOT ac.is_deleted AND ac.org_id = ${ctx.org_id} AND ac.id = ${campaignId}
      GROUP BY ac.id, mp.name, cs.name, cs.id, mp.id
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

async function resolvePlatformId(tx: DrizzleTx, name: string) {
  const [row] = await tx
    .select({ id: marketingPlatformsTable.id })
    .from(marketingPlatformsTable)
    .where(eq(marketingPlatformsTable.name, name))
    .limit(1);
  if (!row) throw new BadRequestError(`Marketing platform not found: ${name}`);
  return row.id;
}

async function resolveStatusId(tx: DrizzleTx, name: string) {
  const [row] = await tx
    .select({ id: campaignStatusesTable.id })
    .from(campaignStatusesTable)
    .where(eq(campaignStatusesTable.name, name))
    .limit(1);
  if (!row) throw new BadRequestError(`Campaign status not found: ${name}`);
  return row.id;
}

export async function createCampaign(ctx: RoleTxContext, data: CreateCampaignBody) {
  return withRoleTx(ctx, async (tx) => {
    const [platformId, statusId] = await Promise.all([
      resolvePlatformId(tx, data.platform_name),
      resolveStatusId(tx, data.status_name),
    ]);

    const [inserted] = await tx
      .insert(adCampaignsTable)
      .values({
        orgId: ctx.org_id,
        name: data.name,
        platformId,
        statusId,
        budget: data.budget ? String(data.budget) : null,
        startedAt: data.started_at ? new Date(data.started_at) : null,
        endedAt: data.ended_at ? new Date(data.ended_at) : null,
      })
      .returning({ id: adCampaignsTable.id });

    return inserted!;
  });
}

export async function updateCampaign(ctx: RoleTxContext, campaignId: string, data: UpdateCampaignBody) {
  return withRoleTx(ctx, async (tx) => {
    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined)       updateData['name']      = data.name;
    if (data.budget !== undefined)     updateData['budget']    = data.budget != null ? String(data.budget) : null;
    if (data.started_at !== undefined) updateData['startedAt'] = data.started_at ? new Date(data.started_at) : null;
    if (data.ended_at !== undefined)   updateData['endedAt']   = data.ended_at ? new Date(data.ended_at) : null;

    if (data.platform_name !== undefined) {
      updateData['platformId'] = await resolvePlatformId(tx, data.platform_name);
    }
    if (data.status_name !== undefined) {
      updateData['statusId'] = await resolveStatusId(tx, data.status_name);
    }

    if (Object.keys(updateData).length === 0) return null;

    const [updated] = await tx
      .update(adCampaignsTable)
      .set(updateData as Record<string, unknown>)
      .where(and(
        eq(adCampaignsTable.id, campaignId),
        eq(adCampaignsTable.orgId, ctx.org_id),
        eq(adCampaignsTable.isDeleted, false),
      ))
      .returning({ id: adCampaignsTable.id });

    return updated ?? null;
  });
}

export async function deleteCampaign(ctx: RoleTxContext, campaignId: string) {
  return withRoleTx(ctx, async (tx) => {
    await tx.execute(sql`
      UPDATE marketing.ad_campaigns
      SET is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = ${ctx.user_id}::uuid
      WHERE id = ${campaignId} AND org_id = ${ctx.org_id}
    `);
  });
}

export async function listMarketingPlatforms() {
  return withServiceTx(async (tx) => {
    return tx.select({
      id: marketingPlatformsTable.id,
      name: marketingPlatformsTable.name,
      description: marketingPlatformsTable.description,
    }).from(marketingPlatformsTable).orderBy(asc(marketingPlatformsTable.name));
  });
}

export async function listCampaignStatuses() {
  return withServiceTx(async (tx) => {
    return tx.select({
      id: campaignStatusesTable.id,
      name: campaignStatusesTable.name,
      description: campaignStatusesTable.description,
    }).from(campaignStatusesTable).orderBy(asc(campaignStatusesTable.name));
  });
}
