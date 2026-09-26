import { sql } from 'drizzle-orm';
import { withServiceTx, withTenantConfigTx } from '@platform/db';
import { ConflictError, NotFoundError, BadRequestError, pgError } from '../lib/errors.js';
import { assertTenantExists } from '../lib/admin-tenant.js';
import type { MetaLeadPlatform } from './lead-sync.service.js';

// ── Admin CRUD for ext.meta_page_form_org_map (lookup-admin console) ─────────
//
// Split out of page-org-map.service.ts, which keeps the two webhook-path
// resolvers. Those two run on withServiceTx (BYPASSRLS) because inbound Meta
// deliveries carry no session at all — a documented system operation. Everything
// here is the opposite: an authenticated platform super_admin acting on ONE
// selected tenant, fully RLS-scoped. Mixing both in one module is what let the
// read path sit on withServiceTx under a comment claiming RLS scoped it.
//
// The administered tenant is an explicit argument on every operation. It is the
// tenant the operator SELECTED in the console (?tenant_id=), never the tenant on
// the caller's own session — platform staff belong to a different tenant, so
// using their own would scope every read to zero rows and stamp every write with
// the wrong owner.
//
// tenantId is therefore client-supplied input and is never the boundary:
//   * the controller gates on RANKS.SUPER_ADMIN before any of this is reached;
//   * assertTenantExists proves the id names a real tenant;
//   * withTenantConfigTx pins app.current_tenant_id to it and runs as app_user
//     (lms_svc here, a NOINHERIT member named on the policy by the widening
//     block at the foot of db_scripts/08_rls.sql), under which
//     ext.meta_page_form_org_map's admin_tenant_config_policy is what actually
//     fences the rows — including the WITH CHECK proving org_id sits inside that
//     same tenant.

export interface PageFormOrgMapping {
  id: string;
  tenant_id: string;
  org_id: string;
  page_id: string;
  // NULL for a page-level catch-all row: every form on that page routes to
  // org_id unless a more specific form_id row exists for it. See the column
  // comment in db_scripts/02_tables_core.sql and resolveOrgId's precedence.
  form_id: string | null;
  platform: MetaLeadPlatform;
  /** 1.51.0: the page/form fallback type (see page-org-map.schema.ts). */
  default_campaign_type_id: string | null;
  default_campaign_type_label: string | null;
  is_active: boolean;
  // When a lead last arrived through this row (1.51.0: stamped by the webhook
  // and the lead-pull Apply; it used to be written only by the retired Python
  // sync). The admin grid's only signal that a mapping actually receives leads.
  last_synced_at: string | null;
}

export interface AdminTenantScope {
  actorUserId: string;
  tenantId: string;
}

export async function listPageFormOrgMappings(
  scope: AdminTenantScope,
): Promise<PageFormOrgMapping[]> {
  return withTenantConfigTx({ actorUserId: scope.actorUserId, tenantId: scope.tenantId }, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);
    // Deliberately no `WHERE tenant_id = …`: admin_tenant_config_policy is the
    // scope here. A literal filter alongside it would pass the acceptance test
    // whether or not the policy is doing its job, which is the whole failure
    // mode this phase exists to remove.
    const rows = await tx.execute(
      sql`SELECT m.id, m.tenant_id, m.org_id, m.page_id::text AS page_id, m.form_id::text AS form_id,
                 m.platform, m.default_campaign_type_id, ct.label AS default_campaign_type_label,
                 m.is_active, m.last_synced_at
          FROM ext.meta_page_form_org_map m
          LEFT JOIN marketing.campaign_types ct ON ct.id = m.default_campaign_type_id
          ORDER BY m.created_at DESC`,
    );
    return rows as unknown as PageFormOrgMapping[];
  });
}

export interface CreatePageFormOrgMappingInput {
  org_id: string;
  page_id: string;
  // Omitted or null creates the page-level catch-all row. The DB column has
  // always been nullable; only the request schema forbade it.
  form_id?: string | null | undefined;
  platform: MetaLeadPlatform;
  default_campaign_type_id?: string | null | undefined;
}

/**
 * A default type must be a LIVE type of the administered tenant. Checked under
 * the admin transaction, where marketing.campaign_types' policy shows only that
 * tenant's rows — so another tenant's type id reads as "unknown", which is the
 * right answer. The FK alone would accept any tenant's type.
 */
async function assertDefaultTypeUsable(
  tx: Parameters<Parameters<typeof withTenantConfigTx>[1]>[0],
  campaignTypeId: string | null | undefined,
): Promise<void> {
  if (!campaignTypeId) return;
  const rows = (await tx.execute(sql`
    SELECT 1 FROM marketing.campaign_types
    WHERE id = ${campaignTypeId}::uuid AND is_active AND NOT is_deleted
    LIMIT 1
  `)) as unknown as unknown[];
  if (rows.length === 0) throw new BadRequestError('Unknown or inactive campaign type for this tenant');
}

/**
 * Turns a 23505 on this table into a 409 that says which of the two unique
 * rules was hit, because the remedy differs:
 *
 *   uq_meta_page_form_org_map            UNIQUE (page_id, form_id)
 *   uq_meta_page_form_org_map_page_level UNIQUE (page_id)
 *                                        WHERE form_id IS NULL AND is_active
 *
 * The second means a page may hold at most one ACTIVE page-level row, so the fix
 * is to edit or deactivate the existing catch-all — not to pick another form.
 *
 * RUNS IN ITS OWN TRANSACTION, after the failed INSERT's has rolled back. It
 * used to query the SAME transaction, which Postgres had already aborted on the
 * 23505 — every statement after it fails with 25P02 — so a duplicate surfaced
 * as a raw 500 and the 409 this function builds was never sent.
 *
 * The holding row is found under admin_tenant_config_policy (a fresh
 * withTenantConfigTx pinned to the same tenant). A conflicting row in ANOTHER
 * tenant is hidden by RLS, correctly — page_id and form_id are unique GLOBALLY,
 * not per tenant, so the collision may be with a tenant this operator is not
 * administering. That case is reported as exactly that, without leaking whose
 * row it is.
 *
 * The org is then named by NAME, read on withServiceTx: entity.organizations is
 * not readable under the admin transaction (its app_user policy keys on the
 * actor's own memberships, and a platform super_admin holds none in an
 * administered tenant). That read is by an org id the policy-scoped lookup just
 * returned, so it can only ever name a branch of the administered tenant.
 */
async function conflictFor(
  scope: AdminTenantScope,
  data: CreatePageFormOrgMappingInput,
  constraint: string | undefined,
): Promise<ConflictError> {
  const isPageLevelRule = constraint === 'uq_meta_page_form_org_map_page_level';

  const existing = await withTenantConfigTx(
    { actorUserId: scope.actorUserId, tenantId: scope.tenantId },
    async (tx) => {
      const rows = await tx.execute(
        sql`SELECT org_id
            FROM ext.meta_page_form_org_map
            WHERE page_id = ${data.page_id}::bigint
              AND form_id IS NOT DISTINCT FROM ${data.form_id ?? null}::bigint
              -- The page-level rule is a PARTIAL index over active rows only, so
              -- an inactive catch-all is not what blocked this insert.
              ${isPageLevelRule ? sql`AND is_active` : sql``}
            ORDER BY is_active DESC
            LIMIT 1`,
      );
      return (rows as unknown as Array<{ org_id: string }>)[0];
    },
  );

  const orgName = existing
    ? await withServiceTx(async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT name FROM entity.organizations WHERE id = ${existing.org_id}::uuid LIMIT 1`,
        )) as unknown as Array<{ name: string }>;
        return rows[0]?.name ?? null;
      })
    : null;

  if (!existing) {
    return new ConflictError(
      isPageLevelRule
        ? `Page ${data.page_id} already has an active page-level mapping owned by another tenant`
        : `Page ${data.page_id} is already mapped for this form by another tenant`,
      { constraint: constraint ?? null },
    );
  }

  const holder = orgName ? `${orgName} (org ${existing.org_id})` : `org ${existing.org_id}`;
  return new ConflictError(
    isPageLevelRule
      ? `Page ${data.page_id} already has an active page-level mapping to ${holder}. `
        + 'A page can have at most one active page-level row — edit or deactivate that one instead.'
      : `Page ${data.page_id}${data.form_id ? ` form ${data.form_id}` : ''} is already mapped `
        + `to ${holder}`,
    { constraint: constraint ?? null, org_id: existing.org_id, org_name: orgName },
  );
}

export async function createPageFormOrgMapping(
  scope: AdminTenantScope,
  data: CreatePageFormOrgMappingInput,
): Promise<{ id: string }> {
  try {
    return await withTenantConfigTx({ actorUserId: scope.actorUserId, tenantId: scope.tenantId }, async (tx) => {
      await assertTenantExists(tx, scope.tenantId);
      await assertDefaultTypeUsable(tx, data.default_campaign_type_id);
      const rows = await tx.execute(
        sql`INSERT INTO ext.meta_page_form_org_map (tenant_id, org_id, page_id, form_id, platform, default_campaign_type_id)
            VALUES (${scope.tenantId}::uuid, ${data.org_id}::uuid, ${data.page_id}::bigint,
                    ${data.form_id ?? null}::bigint, ${data.platform}, ${data.default_campaign_type_id ?? null}::uuid)
            RETURNING id`,
      );
      return (rows as unknown as Array<{ id: string }>)[0]!;
    });
  } catch (err) {
    // Translated OUTSIDE the transaction: once the INSERT fails, Postgres has
    // aborted it and refuses every further statement, so conflictFor opens its
    // own (see its comment).
    const { code, constraint } = pgError(err);
    if (code === '23505') throw await conflictFor(scope, data, constraint);
    // 42501 is admin_tenant_config_policy's WITH CHECK refusing an org_id
    // outside the administered tenant — the cross-tenant write the policy
    // exists to stop. It is a bad request, not a server fault, so it is
    // reported as a 400 naming the supplied org rather than a raw 500.
    if (code === '42501') {
      throw new BadRequestError(`org_id ${data.org_id} does not belong to the selected tenant`);
    }
    throw err;
  }
}

export interface UpdatePageFormOrgMappingInput {
  org_id?: string | undefined;
  is_active?: boolean | undefined;
  platform?: MetaLeadPlatform | undefined;
  /** null clears the default; undefined leaves it as is. */
  default_campaign_type_id?: string | null | undefined;
}

export async function updatePageFormOrgMapping(
  scope: AdminTenantScope,
  mappingId: string,
  data: UpdatePageFormOrgMappingInput,
): Promise<void> {
  try {
    await withTenantConfigTx<void>({ actorUserId: scope.actorUserId, tenantId: scope.tenantId }, async (tx) => {
      await assertTenantExists(tx, scope.tenantId);
      await assertDefaultTypeUsable(tx, data.default_campaign_type_id);
      // RETURNING id, and an empty result is a 404. Without it this statement
      // reported success for a mapping belonging to another tenant: RLS filtered
      // the row out, the UPDATE matched nothing, and the controller replied 204 as
      // though the edit had been applied. A nonexistent id gets the same answer on
      // purpose — distinguishing the two would confirm the existence of another
      // tenant's row.
      const rows = await tx.execute(
        sql`UPDATE ext.meta_page_form_org_map
            SET updated_at = NOW(),
                org_id    = COALESCE(${data.org_id ?? null}::uuid, org_id),
                is_active = COALESCE(${data.is_active ?? null}, is_active),
                platform  = COALESCE(${data.platform ?? null}, platform),
                default_campaign_type_id = CASE
                  WHEN ${data.default_campaign_type_id !== undefined} THEN ${data.default_campaign_type_id ?? null}::uuid
                  ELSE default_campaign_type_id
                END
            WHERE id = ${mappingId}::uuid
            RETURNING id`,
      );
      if ((rows as unknown as Array<{ id: string }>).length === 0) {
        throw new NotFoundError('Page/form org mapping not found');
      }
    });
  } catch (err) {
    // 1.51.0: the same translation create has always done. Re-activating a
    // page-level row while another active one exists (23505), or pointing a row
    // at a branch outside the tenant (42501), used to surface as a raw 500.
    const { code, constraint } = pgError(err);
    if (code === '23505') {
      throw new ConflictError(
        constraint === 'uq_meta_page_form_org_map_page_level'
          ? 'This page already has another active page-level mapping. Deactivate that one first.'
          : 'This page/form is already mapped by another row.',
        { constraint: constraint ?? null },
      );
    }
    if (code === '42501') {
      throw new BadRequestError('org_id does not belong to the selected tenant');
    }
    throw err;
  }
}

export async function deletePageFormOrgMapping(
  scope: AdminTenantScope,
  mappingId: string,
): Promise<void> {
  await withTenantConfigTx<void>({ actorUserId: scope.actorUserId, tenantId: scope.tenantId }, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);
    const rows = await tx.execute(
      sql`DELETE FROM ext.meta_page_form_org_map
          WHERE id = ${mappingId}::uuid
          RETURNING id`,
    );
    if ((rows as unknown as Array<{ id: string }>).length === 0) {
      throw new NotFoundError('Page/form org mapping not found');
    }
  });
}
