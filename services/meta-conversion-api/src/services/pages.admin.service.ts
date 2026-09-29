import { sql } from 'drizzle-orm';
import { withServiceTx, withTenantConfigTx } from '@platform/db';
import { assertTenantExists } from '../lib/admin-tenant.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import * as integrationService from './integration.service.js';
import * as metaApi from './meta-api.service.js';
import type { AdminTenantScope } from './page-org-map.admin.service.js';

// ── Page and form pickers for the mapping and lead-pull screens (1.51.0) ─────
//
// The shared Meta token manages EVERY tenant's pages, so listing /me/accounts
// raw offered an admin administering tenant A the pages of tenant B — and
// mapping or pulling one staged B's leads (and their PII) under A. Each page now
// says who owns it:
//
//   'this'  — mapped to the administered tenant
//   'other' — mapped to another tenant (named, for the super admin)
//   null    — not mapped anywhere yet
//
// Ownership is a CROSS-TENANT question (which tenant holds this page?), so it is
// read on withServiceTx — a documented system read of page ids, tenant ids and
// tenant names only, from super_admin routes. The screens refuse to act on an
// 'other' page; the forms endpoint below refuses outright.

export interface PageWithOwner {
  page_id: string;
  name: string | null;
  owner: 'this' | 'other' | null;
  owner_tenant_name: string | null;
}

async function pageOwners(): Promise<Map<string, { tenant_id: string; tenant_name: string | null }>> {
  const rows = (await withServiceTx((tx) => tx.execute(sql`
    SELECT DISTINCT ON (m.page_id) m.page_id::text AS page_id, m.tenant_id, t.name AS tenant_name
    FROM ext.meta_page_form_org_map m
    LEFT JOIN entity.tenants t ON t.id = m.tenant_id
    WHERE m.is_active
    ORDER BY m.page_id, m.created_at
  `))) as unknown as Array<{ page_id: string; tenant_id: string; tenant_name: string | null }>;
  return new Map(rows.map((r) => [r.page_id, { tenant_id: r.tenant_id, tenant_name: r.tenant_name }]));
}

async function integrationFor(tenantId: string) {
  const integration = await integrationService.getIntegrationByTenantId(tenantId);
  if (!integration || !integration.is_active) {
    throw new NotFoundError('No active Meta integration configured for this tenant');
  }
  return integration;
}

export async function listPagesWithOwner(scope: AdminTenantScope): Promise<PageWithOwner[]> {
  await withTenantConfigTx(scope, (tx) => assertTenantExists(tx, scope.tenantId));
  const integration = await integrationFor(scope.tenantId);
  const [pages, owners] = await Promise.all([
    metaApi.getManagedPages(integration.access_token, integration.graph_api_version),
    pageOwners(),
  ]);
  return pages.map((p) => {
    const o = owners.get(p.page_id);
    return {
      page_id: p.page_id,
      name: p.name,
      owner: o ? (o.tenant_id === scope.tenantId ? 'this' : 'other') : null,
      owner_tenant_name: o && o.tenant_id !== scope.tenantId ? o.tenant_name : null,
    };
  });
}

export interface PageForm {
  form_id: string;
  name: string | null;
  status: string | null;
  leads_count: number | null;
  /** The branch an EXACT form row routes this form to, if one exists. */
  mapped_org_id: string | null;
}

/**
 * The leadgen forms live on one page right now, for the mapping screen's form
 * picker (form ids used to be typed by hand). Also refreshes ext.meta_forms
 * under the administered tenant, which is what the per-lead form-name rules
 * read.
 *
 * Refused for a page mapped to ANOTHER tenant — listing it would disclose that
 * tenant's forms.
 */
export async function listPageForms(scope: AdminTenantScope, pageId: string): Promise<PageForm[]> {
  if (!/^\d+$/.test(pageId)) throw new BadRequestError('page_id must be numeric');
  await withTenantConfigTx(scope, (tx) => assertTenantExists(tx, scope.tenantId));

  const owner = (await pageOwners()).get(pageId);
  if (owner && owner.tenant_id !== scope.tenantId) {
    throw new BadRequestError('This page is mapped to another tenant');
  }

  const integration = await integrationFor(scope.tenantId);
  // /leadgen_forms needs a PAGE token; the tenant-level token is refused (#190).
  const tokens = await metaApi.getManagedPageTokens(integration.access_token, integration.graph_api_version);
  const pageToken = tokens.get(pageId);
  if (!pageToken) {
    throw new NotFoundError("This page is not among the integration's managed pages");
  }
  const forms = await metaApi.listLeadGenForms(pageId, pageToken, integration.graph_api_version);

  return withTenantConfigTx(scope, async (tx) => {
    for (const f of forms) {
      // A form already cached by another tenant is left alone (WHERE on the
      // update arm); RLS would refuse it anyway.
      await tx.execute(sql`
        INSERT INTO ext.meta_forms (tenant_id, page_id, form_id, name, status, leads_count, last_synced_at)
        VALUES (${scope.tenantId}::uuid, ${pageId}::bigint, ${f.form_id}::bigint, ${f.name}, ${f.status}, ${f.leads_count}, NOW())
        ON CONFLICT (form_id) DO UPDATE
          SET name = EXCLUDED.name, status = EXCLUDED.status, leads_count = EXCLUDED.leads_count,
              last_synced_at = NOW(), updated_at = NOW()
          WHERE ext.meta_forms.tenant_id = EXCLUDED.tenant_id
      `);
    }
    const mapped = (await tx.execute(sql`
      SELECT form_id::text AS form_id, org_id
      FROM ext.meta_page_form_org_map
      WHERE page_id = ${pageId}::bigint AND form_id IS NOT NULL AND is_active
    `)) as unknown as Array<{ form_id: string; org_id: string }>;
    const byForm = new Map(mapped.map((m) => [m.form_id, m.org_id]));
    return forms.map((f) => ({
      form_id: f.form_id,
      name: f.name,
      status: f.status,
      leads_count: f.leads_count,
      mapped_org_id: byForm.get(f.form_id) ?? null,
    }));
  });
}
