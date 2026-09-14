import { sql, and, eq } from 'drizzle-orm';
import { withTenantConfigTx, withServiceTx } from '@platform/db';
import type { DrizzleTx, RoleTxContext } from '@platform/db';
import { campaignTypesTable } from '@platform/db/schema';
import { assertTenantExists } from '../../../lib/admin-tenant.js';
import type { CreateCampaignTypeBody, UpdateCampaignTypeBody } from './campaign-types.schema.js';

// marketing.campaign_types is TENANT-scoped, not org-scoped: a type is a
// tenant's catalog entry shared by every branch, so there is no org_id to key
// on. Its write policy (admin_tenant_config_policy, 08_rls.sql) is keyed on
// app.current_tenant_id — and withRoleTx's app_user branch never sets that GUC,
// only app.current_org_id, so a write through it would be refused. This is why
// every tenant-scoped LMS catalog in this service (lead-sources,
// campaign-statuses, …) goes through withTenantConfigTx instead.
//
// Not a BYPASSRLS path: it still runs as the product login under the tenant
// policy, so the database itself makes another tenant's rows unreachable.
// ctx.tenant_id is the caller's own gateway-signed session tenant — or, for a
// platform super_admin only, the tenant they are administering from the
// lookup-admin console (?tenant_id=, rank-checked in campaign-types.controller.ts).
// Either way it is never taken from the body, and it is not the boundary: the
// policy is.
//
// CONSEQUENCE, and the reason the reads below join nothing: this transaction
// pins app.current_tenant_id and NOT app.current_org_id, while iam.departments
// and lms.marketing_leads are both fenced on the latter. Joining either here
// returns zero rows with no error — the exact silent-empty failure this repo has
// already been bitten by twice. Anything needing those tables is resolved
// separately; see getCampaignTypeUsage.
//
// Every transaction first proves the tenant exists (lib/admin-tenant.ts): on
// the admin path the id is client-supplied, and an unknown one must read as a
// 404, not as an empty catalog.
function inTenantTx<T>(ctx: RoleTxContext, fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    await assertTenantExists(tx, ctx.tenant_id);
    return fn(tx);
  });
}

export async function listCampaignTypes(ctx: RoleTxContext) {
  return inTenantTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT id, name, label, description, department_id,
             match_keywords, is_default, match_priority, sort_order,
             is_active, created_at, updated_at
      FROM marketing.campaign_types
      WHERE tenant_id = ${ctx.tenant_id}::uuid
        AND NOT is_deleted
      ORDER BY sort_order ASC, label ASC
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getCampaignTypeById(ctx: RoleTxContext, id: string) {
  return inTenantTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, name, label, description, department_id,
             match_keywords, is_default, match_priority, sort_order,
             is_active, created_at, updated_at
      FROM marketing.campaign_types
      WHERE id = ${id}::uuid
        AND tenant_id = ${ctx.tenant_id}::uuid
        AND NOT is_deleted
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

export async function createCampaignType(ctx: RoleTxContext, data: CreateCampaignTypeBody) {
  return inTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(campaignTypesTable)
      .values({
        // Never a body-supplied tenant: the acting tenant is the gateway's
        // answer, and the RLS WITH CHECK re-asserts it on the way in.
        tenantId: ctx.tenant_id,
        name: data.name,
        label: data.label,
        description: data.description ?? null,
        departmentId: data.department_id ?? null,
        ...(data.match_keywords ? { matchKeywords: data.match_keywords } : {}),
        ...(data.match_priority !== undefined ? { matchPriority: data.match_priority } : {}),
        ...(data.sort_order !== undefined ? { sortOrder: data.sort_order } : {}),
        createdBy: ctx.user_id,
      })
      .returning({ id: campaignTypesTable.id });
    return row!;
  });
}

export async function updateCampaignType(ctx: RoleTxContext, id: string, data: UpdateCampaignTypeBody) {
  return inTenantTx(ctx, async (tx) => {
    const updateData: Record<string, unknown> = {};

    if (data.label !== undefined)          updateData['label']         = data.label;
    if (data.description !== undefined)    updateData['description']   = data.description;
    if (data.department_id !== undefined)  updateData['departmentId']  = data.department_id;
    if (data.match_keywords !== undefined) updateData['matchKeywords'] = data.match_keywords;
    if (data.match_priority !== undefined) updateData['matchPriority'] = data.match_priority;
    if (data.sort_order !== undefined)     updateData['sortOrder']     = data.sort_order;
    if (data.is_active !== undefined)      updateData['isActive']      = data.is_active;

    if (Object.keys(updateData).length === 0) return null;

    const [row] = await tx
      .update(campaignTypesTable)
      .set(updateData)
      .where(and(
        eq(campaignTypesTable.id, id),
        eq(campaignTypesTable.tenantId, ctx.tenant_id),
        eq(campaignTypesTable.isDeleted, false),
      ))
      .returning({ id: campaignTypesTable.id });

    return row ?? null;
  });
}

export interface CampaignTypeUsage {
  is_default: boolean;
  lead_count: number;
  campaign_count: number;
  weighted_user_count: number;
  /** ext.meta_campaigns rows mapped to this type — inbound leads route through it. */
  meta_campaign_count: number;
  /** Active page/form mappings using it as their default type. */
  form_default_count: number;
}

/**
 * What still depends on this type — the delete guard's evidence.
 *
 * Checked in the application rather than left to the foreign keys. Both
 * lms.marketing_leads.campaign_type_id and marketing.ad_campaigns.campaign_type_id
 * are ON DELETE RESTRICT, so a HARD delete would be refused — but the platform
 * convention here is a SOFT delete, which no FK polices. Without this an admin
 * could retire the pool that a live rotation and thousands of leads still point
 * at, and nothing would complain until those leads quietly stopped routing.
 *
 * withServiceTx (BYPASSRLS), deliberately, and this is the one place in this
 * module that bypasses: a type is TENANT-wide while its leads and campaigns live
 * in branches, and lms.marketing_leads is fenced to the acting org. Counted under
 * the caller's own scope, an org_admin in one branch would be told a type is
 * unused while another branch is still running it — a guard that answers "safe"
 * because it cannot see the danger is worse than none. Every query is qualified
 * on the TYPE's own tenant_id, which is first confirmed to be the caller's, so
 * nothing outside their tenant is read or counted.
 */
export async function getCampaignTypeUsage(ctx: RoleTxContext, id: string): Promise<CampaignTypeUsage | null> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ct.is_default,
             (SELECT COUNT(*) FROM lms.marketing_leads ml
               JOIN entity.organizations mo ON mo.id = ml.org_id
              WHERE ml.campaign_type_id = ct.id
                AND mo.tenant_id = ct.tenant_id
                AND NOT ml.is_deleted) AS lead_count,
             (SELECT COUNT(*) FROM marketing.ad_campaigns ac
               JOIN entity.organizations ao ON ao.id = ac.org_id
              WHERE ac.campaign_type_id = ct.id
                AND ao.tenant_id = ct.tenant_id
                AND NOT ac.is_deleted) AS campaign_count,
             (SELECT COUNT(*) FROM lms.lead_assignment_weights w
               WHERE w.campaign_type_id = ct.id AND w.weight > 0) AS weighted_user_count,
             -- The Meta-side references, through a SECURITY DEFINER function:
             -- this service never reads ext.* directly.
             mu.meta_campaign_count,
             mu.form_default_count
      FROM marketing.campaign_types ct
      CROSS JOIN LATERAL marketing.fn_campaign_type_usage(ct.id) mu
      WHERE ct.id = ${id}::uuid
        -- The tenant fence, restated because RLS is off on this transaction.
        AND ct.tenant_id = ${ctx.tenant_id}::uuid
        AND NOT ct.is_deleted
      LIMIT 1
    `)) as Array<{
      is_default: boolean;
      lead_count: string;
      campaign_count: string;
      weighted_user_count: string;
      meta_campaign_count: string;
      form_default_count: string;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      is_default: Boolean(row.is_default),
      lead_count: Number(row.lead_count),
      campaign_count: Number(row.campaign_count),
      weighted_user_count: Number(row.weighted_user_count),
      meta_campaign_count: Number(row.meta_campaign_count),
      form_default_count: Number(row.form_default_count),
    };
  });
}

export async function deleteCampaignType(ctx: RoleTxContext, id: string) {
  return inTenantTx(ctx, async (tx) => {
    // Soft delete, the platform convention. is_active goes down with it:
    // chk_campaign_types_active_deleted forbids a row that is both.
    const rows = (await tx.execute(sql`
      UPDATE marketing.campaign_types
      SET is_deleted = TRUE, is_active = FALSE,
          deleted_at = CLOCK_TIMESTAMP(), deleted_by = ${ctx.user_id}::uuid
      WHERE id = ${id}::uuid
        AND tenant_id = ${ctx.tenant_id}::uuid
        AND NOT is_deleted
      RETURNING id
    `)) as Array<{ id: string }>;
    return rows.length > 0;
  });
}
