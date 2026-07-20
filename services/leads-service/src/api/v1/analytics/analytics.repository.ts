import { sql } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@platform/db';
import { organizationsTable } from '@platform/db/schema';
import { eq } from 'drizzle-orm';

async function resolveTenantId(orgId: string): Promise<string> {
  return withServiceTx(async (tx) => {
    const [row] = await tx
      .select({ tenantId: organizationsTable.tenantId })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    if (!row) throw new Error(`Organization not found: ${orgId}`);
    return row.tenantId;
  });
}

export async function getOrgPerformanceSnapshot(orgId: string, userId: string) {
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM lms.vw_org_performance_snapshot WHERE org_id = ${orgId}::uuid
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

export async function getTenantDashboard(orgId: string, userId: string) {
  const tenantId = await resolveTenantId(orgId);
  return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT * FROM lms.vw_tenant_full_dashboard WHERE tenant_id = ${tenantId}::uuid
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getTenantCampaignSummary(orgId: string, userId: string) {
  const tenantId = await resolveTenantId(orgId);
  return withRoleTx({ role: 'tenant_admin', org_id: orgId, tenant_id: tenantId, user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT * FROM marketing.vw_tenant_campaign_summary WHERE tenant_id = ${tenantId}::uuid ORDER BY campaign_name
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getPipelineByStage(orgId: string, userId: string) {
  return withRoleTx({ role: 'org_admin', org_id: orgId, tenant_id: '', user_id: userId }, async (tx) => {
    return (await tx.execute(sql`
      SELECT ls.name AS stage, ls.label AS stage_label, COUNT(ml.id)::INT AS count
      FROM lms.lead_stage ls
      LEFT JOIN lms.marketing_leads ml
        ON ml.stage_id = ls.id AND ml.org_id = ${orgId}::uuid AND NOT ml.is_deleted
      GROUP BY ls.id, ls.name, ls.label
      ORDER BY ls.sort_order
    `)) as Array<Record<string, unknown>>;
  });
}
