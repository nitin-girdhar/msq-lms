import { sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';
import type { MetaLeadPlatform } from './lead-sync.service.js';

export interface ResolvedOrgMapping {
  orgId: string;
  platform: MetaLeadPlatform;
}

// Routes a webhook event to the owning org. form_id is authoritative (a form
// belongs to exactly one Page, and form_id is globally unique in Meta's
// system); the PAGE-LEVEL row (form_id IS NULL) is the catch-all used when no
// exact form match exists, so a brand-new form created on an already-mapped
// Page is attributed automatically without a manual mapping entry first.
//
// The fallback is restricted to `form_id IS NULL`. It previously took the most
// recently created ACTIVE row for the page whatever its form_id, which meant an
// unknown form landed in whichever branch happened to have been mapped last —
// a FORM-level row for some unrelated form, if that row was newer than the
// page-level one. That contradicted this table's own documented precedence
// (db_scripts/02_tables_core.sql) and disagreed with the Python twin,
// common/mappings.py::resolve(), which has always gone exact-form -> page-level
// -> unmapped and never considers an unrelated form's row. The two paths read
// the same table and so could route the same lead to different branches.
// Restricting it here makes an unmatched form on a page with no page-level row
// UNMAPPED — logged and skipped — rather than silently attributed to a branch
// nobody chose, which is the safer of the two failures and what the Python
// already does. At most one ACTIVE page-level row per page is guaranteed by
// uq_meta_page_form_org_map_page_level, so the result is deterministic.
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
      const row = (rows as unknown as Array<{ org_id: string; platform: MetaLeadPlatform }>)[0];
      if (row) return { orgId: row.org_id, platform: row.platform };
    }

    // Fallback: this page's page-level catch-all row, if it has one.
    const pageRows = await tx.execute(
      sql`SELECT org_id, platform FROM ext.meta_page_form_org_map
          WHERE tenant_id = ${tenantId}::uuid AND page_id = ${pageId}::bigint
            AND form_id IS NULL AND is_active = true
          ORDER BY created_at DESC
          LIMIT 1`,
    );
    const pageRow = (pageRows as unknown as Array<{ org_id: string; platform: MetaLeadPlatform }>)[0];
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
      const row = (rows as unknown as Array<{ tenant_id: string; org_id: string; platform: MetaLeadPlatform }>)[0];
      if (row) return { tenantId: row.tenant_id, orgId: row.org_id, platform: row.platform };
    }

    // Fallback: this page's page-level catch-all row — same precedence rule as
    // resolveOrgId above, and for the same reason.
    const pageRows = await tx.execute(
      sql`SELECT tenant_id, org_id, platform FROM ext.meta_page_form_org_map
          WHERE page_id = ${pageId}::bigint AND form_id IS NULL AND is_active = true
          ORDER BY created_at DESC
          LIMIT 1`,
    );
    const pageRow = (pageRows as unknown as Array<{ tenant_id: string; org_id: string; platform: MetaLeadPlatform }>)[0];
    return pageRow ? { tenantId: pageRow.tenant_id, orgId: pageRow.org_id, platform: pageRow.platform } : null;
  });
}

/**
 * Stamps last_synced_at on the mapping row(s) a lead just arrived through
 * (1.51.0): the exact form row when there is one, the page-level row otherwise.
 * The admin grid reads it as "last lead received" -- the only signal that a
 * mapping is live. Best-effort on the webhook path; a failure costs a stale
 * timestamp, never a lead. withServiceTx for the same reason as the resolvers.
 */
export async function touchMappingLastLead(pageId: string, formId: string | null | undefined): Promise<void> {
  await withServiceTx((tx) => tx.execute(sql`
    UPDATE ext.meta_page_form_org_map
    SET last_synced_at = NOW()
    WHERE is_active
      AND page_id = ${pageId}::bigint
      AND (
        (${formId ?? null}::text IS NOT NULL AND form_id = ${formId ?? null}::bigint)
        OR (form_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM ext.meta_page_form_org_map f
              WHERE f.is_active AND f.page_id = ${pageId}::bigint AND f.form_id = ${formId ?? null}::bigint))
      )
  `));
}

// The admin CRUD that used to live below moved to page-org-map.admin.service.ts.
// The two resolvers above are the webhook path: an inbound Meta delivery carries
// no session, so they run on withServiceTx (BYPASSRLS) as a documented system
// operation. The admin surface is the opposite — an authenticated super_admin
// acting on one selected tenant, fully RLS-scoped through withTenantConfigTx —
// and keeping both in one module is how the read path ended up on withServiceTx
// beneath a comment claiming RLS scoped it.
