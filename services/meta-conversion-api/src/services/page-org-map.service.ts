import { sql } from 'drizzle-orm';
import { withServiceTx, withRoleTx, type RoleTxContext } from '@crm/db';

export interface ResolvedOrgMapping {
  orgId: string;
  platform: 'fb' | 'ig';
}

// Routes a webhook event to the owning org. form_id is authoritative (a form
// belongs to exactly one Page, and form_id is globally unique in Meta's
// system); page_id is used only as a fallback default so a brand-new form
// created on an already-mapped Page is attributed automatically without
// requiring a manual mapping entry first.
export async function resolveOrgId(
  tenantId: string,
  pageId: string,
  formId: string | undefined,
): Promise<ResolvedOrgMapping | null> {
  return withServiceTx(async (tx) => {
    if (formId) {
      const rows = await tx.execute(
        sql`SELECT org_id, platform FROM ext.meta_page_form_org_map
            WHERE tenant_id = ${tenantId}::uuid AND form_id = ${formId}::bigint AND is_active = true
            LIMIT 1`,
      );
      const row = (rows as unknown as Array<{ org_id: string; platform: 'fb' | 'ig' }>)[0];
      if (row) return { orgId: row.org_id, platform: row.platform };
    }

    // Fallback: any known org mapping for this page (most recently active one).
    const pageRows = await tx.execute(
      sql`SELECT org_id, platform FROM ext.meta_page_form_org_map
          WHERE tenant_id = ${tenantId}::uuid AND page_id = ${pageId}::bigint AND is_active = true
          ORDER BY created_at DESC
          LIMIT 1`,
    );
    const pageRow = (pageRows as unknown as Array<{ org_id: string; platform: 'fb' | 'ig' }>)[0];
    return pageRow ? { orgId: pageRow.org_id, platform: pageRow.platform } : null;
  });
}

export interface ResolvedTenantOrgMapping extends ResolvedOrgMapping {
  tenantId: string;
}

// Used by the tenant-less webhook (shared Meta App covering multiple
// tenants — no tenant_id available up front). form_id/page_id are globally
// unique (uq_meta_page_form_org_map UNIQUE (page_id, form_id)), so both
// tenant and org can be resolved from the mapping row alone, without a
// tenant_id filter.
export async function resolveTenantAndOrg(
  pageId: string,
  formId: string | undefined,
): Promise<ResolvedTenantOrgMapping | null> {
  return withServiceTx(async (tx) => {
    if (formId) {
      const rows = await tx.execute(
        sql`SELECT tenant_id, org_id, platform FROM ext.meta_page_form_org_map
            WHERE form_id = ${formId}::bigint AND is_active = true
            LIMIT 1`,
      );
      const row = (rows as unknown as Array<{ tenant_id: string; org_id: string; platform: 'fb' | 'ig' }>)[0];
      if (row) return { tenantId: row.tenant_id, orgId: row.org_id, platform: row.platform };
    }

    // Fallback: any known org mapping for this page (most recently active one).
    const pageRows = await tx.execute(
      sql`SELECT tenant_id, org_id, platform FROM ext.meta_page_form_org_map
          WHERE page_id = ${pageId}::bigint AND is_active = true
          ORDER BY created_at DESC
          LIMIT 1`,
    );
    const pageRow = (pageRows as unknown as Array<{ tenant_id: string; org_id: string; platform: 'fb' | 'ig' }>)[0];
    return pageRow ? { tenantId: pageRow.tenant_id, orgId: pageRow.org_id, platform: pageRow.platform } : null;
  });
}

export interface PageFormOrgMapping {
  id: string;
  tenant_id: string;
  org_id: string;
  page_id: string;
  form_id: string;
  platform: 'fb' | 'ig';
  is_active: boolean;
}

export async function listPageFormOrgMappings(tenantId: string): Promise<PageFormOrgMapping[]> {
  return withServiceTx(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, tenant_id, org_id, page_id::text as page_id, form_id::text as form_id, platform, is_active
          FROM ext.meta_page_form_org_map
          WHERE tenant_id = ${tenantId}::uuid
          ORDER BY created_at DESC`,
    );
    return rows as unknown as PageFormOrgMapping[];
  });
}

export interface CreatePageFormOrgMappingInput {
  org_id: string;
  page_id: string;
  form_id: string;
  platform: 'fb' | 'ig';
}

export async function createPageFormOrgMapping(
  ctx: RoleTxContext,
  data: CreatePageFormOrgMappingInput,
): Promise<{ id: string }> {
  return withRoleTx(ctx, async (tx) => {
    const rows = await tx.execute(
      sql`INSERT INTO ext.meta_page_form_org_map (tenant_id, org_id, page_id, form_id, platform)
          VALUES (${ctx.tenant_id}::uuid, ${data.org_id}::uuid, ${data.page_id}::bigint, ${data.form_id}::bigint, ${data.platform})
          RETURNING id`,
    );
    return (rows as unknown as Array<{ id: string }>)[0]!;
  });
}

export interface UpdatePageFormOrgMappingInput {
  org_id?: string | undefined;
  is_active?: boolean | undefined;
}

export async function updatePageFormOrgMapping(
  ctx: RoleTxContext,
  mappingId: string,
  data: UpdatePageFormOrgMappingInput,
): Promise<void> {
  await withRoleTx<void>(ctx, async (tx) => {
    await tx.execute(
      sql`UPDATE ext.meta_page_form_org_map
          SET updated_at = NOW(),
              org_id    = COALESCE(${data.org_id ?? null}::uuid, org_id),
              is_active = COALESCE(${data.is_active ?? null}, is_active)
          WHERE id = ${mappingId}::uuid AND tenant_id = ${ctx.tenant_id}::uuid`,
    );
  });
}

export async function deletePageFormOrgMapping(ctx: RoleTxContext, mappingId: string): Promise<void> {
  await withRoleTx<void>(ctx, async (tx) => {
    await tx.execute(
      sql`DELETE FROM ext.meta_page_form_org_map WHERE id = ${mappingId}::uuid AND tenant_id = ${ctx.tenant_id}::uuid`,
    );
  });
}
