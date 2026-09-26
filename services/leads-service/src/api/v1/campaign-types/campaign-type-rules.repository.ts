import { sql } from 'drizzle-orm';
import { withTenantConfigTx } from '@platform/db';
import type { DrizzleTx, RoleTxContext } from '@platform/db';
import { assertTenantExists } from '../../../lib/admin-tenant.js';
import type { CreateRuleBody, UpdateRuleBody, TestRulesBody } from './campaign-type-rules.schema.js';

// marketing.campaign_type_rules is TENANT-scoped exactly like
// marketing.campaign_types, and reached the same way: withTenantConfigTx pins
// app.current_tenant_id and admin_tenant_config_policy (08_rls.sql) fences every
// row to it. ctx.tenant_id is the gateway-signed session tenant, or — for a
// platform super_admin only — the tenant administered via ?tenant_id=
// (rank-checked in campaign-types.controller.ts::scopeCtx). The policy, not a
// WHERE clause, is the boundary; the tenant_id filters below are for index use
// and clarity, never for security.
//
// trg_campaign_type_rules_tenant_match refuses a rule whose type belongs to
// another tenant, so even a type id guessed from elsewhere cannot cross over.

function inTenantTx<T>(ctx: RoleTxContext, fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
  return withTenantConfigTx({ actorUserId: ctx.user_id, tenantId: ctx.tenant_id }, async (tx) => {
    await assertTenantExists(tx, ctx.tenant_id);
    return fn(tx);
  });
}

export interface RuleRow {
  id: string;
  rule_order: number;
  match_field: string;
  pattern: string;
  campaign_type_id: string;
  campaign_type_label: string | null;
  campaign_type_is_active: boolean | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export async function listRules(ctx: RoleTxContext): Promise<RuleRow[]> {
  return inTenantTx(ctx, async (tx) => (await tx.execute(sql`
    SELECT r.id, r.rule_order, r.match_field, r.pattern, r.campaign_type_id,
           ct.label AS campaign_type_label,
           (ct.is_active AND NOT ct.is_deleted) AS campaign_type_is_active,
           r.is_active, r.created_at, r.updated_at
    FROM marketing.campaign_type_rules r
    LEFT JOIN marketing.campaign_types ct ON ct.id = r.campaign_type_id
    WHERE r.tenant_id = ${ctx.tenant_id}::uuid AND NOT r.is_deleted
    ORDER BY r.rule_order, r.id
  `)) as unknown as RuleRow[]);
}

/** The type must be live and visible under this tenant's policy. */
async function typeIsUsable(tx: DrizzleTx, campaignTypeId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM marketing.campaign_types
    WHERE id = ${campaignTypeId}::uuid AND is_active AND NOT is_deleted
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

export async function createRule(ctx: RoleTxContext, data: CreateRuleBody): Promise<{ id: string } | 'bad_type'> {
  return inTenantTx(ctx, async (tx) => {
    if (!(await typeIsUsable(tx, data.campaign_type_id))) return 'bad_type';

    if (data.rule_order !== undefined) {
      // Make room: shift this position and everything after it down by one step.
      // Two statements because the per-tenant order index is not deferrable —
      // park the tail out of range first, then bring it back shifted.
      await tx.execute(sql`
        UPDATE marketing.campaign_type_rules SET rule_order = rule_order + 1000000
        WHERE tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted AND rule_order >= ${data.rule_order}
      `);
      await tx.execute(sql`
        UPDATE marketing.campaign_type_rules SET rule_order = rule_order - 1000000 + 10
        WHERE tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted AND rule_order >= 1000000
      `);
    }

    const inserted = (await tx.execute(sql`
      INSERT INTO marketing.campaign_type_rules (tenant_id, rule_order, match_field, pattern, campaign_type_id, created_by)
      VALUES (
        ${ctx.tenant_id}::uuid,
        COALESCE(${data.rule_order ?? null}::int,
                 (SELECT COALESCE(MAX(rule_order), 0) + 10 FROM marketing.campaign_type_rules
                   WHERE tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted)),
        ${data.match_field}, ${data.pattern}, ${data.campaign_type_id}::uuid, ${ctx.user_id}::uuid
      )
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return inserted[0]!;
  });
}

export async function updateRule(
  ctx: RoleTxContext,
  id: string,
  data: UpdateRuleBody,
): Promise<'ok' | 'not_found' | 'bad_type'> {
  return inTenantTx(ctx, async (tx) => {
    if (data.campaign_type_id && !(await typeIsUsable(tx, data.campaign_type_id))) return 'bad_type';
    const rows = (await tx.execute(sql`
      UPDATE marketing.campaign_type_rules
      SET match_field      = COALESCE(${data.match_field ?? null}, match_field),
          pattern          = COALESCE(${data.pattern ?? null}, pattern),
          campaign_type_id = COALESCE(${data.campaign_type_id ?? null}::uuid, campaign_type_id),
          is_active        = COALESCE(${data.is_active ?? null}::boolean, is_active)
      WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows[0] ? 'ok' : 'not_found';
  });
}

/** Soft delete: trg_campaign_type_rules_soft_delete turns the DELETE into is_deleted. */
export async function deleteRule(ctx: RoleTxContext, id: string): Promise<boolean> {
  return inTenantTx(ctx, async (tx) => {
    const found = (await tx.execute(sql`
      SELECT 1 FROM marketing.campaign_type_rules
      WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted
    `)) as unknown as unknown[];
    if (found.length === 0) return false;
    await tx.execute(sql`DELETE FROM marketing.campaign_type_rules WHERE id = ${id}::uuid`);
    return true;
  });
}

/**
 * Rewrites the whole live order in one transaction. `ruleIds` must be EXACTLY
 * the tenant's live rules — a partial list is refused so a half-loaded client
 * cannot silently renumber the rest. Positions are 10, 20, 30… so a later
 * insert-between needs no renumbering.
 */
export async function reorderRules(ctx: RoleTxContext, ruleIds: string[]): Promise<'ok' | 'mismatch'> {
  return inTenantTx(ctx, async (tx) => {
    const live = (await tx.execute(sql`
      SELECT id FROM marketing.campaign_type_rules
      WHERE tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted
    `)) as unknown as Array<{ id: string }>;
    const liveSet = new Set(live.map((r) => r.id));
    const given = new Set(ruleIds);
    if (given.size !== ruleIds.length || given.size !== liveSet.size || ![...given].every((id) => liveSet.has(id))) {
      return 'mismatch';
    }

    // Park everything out of range, then write the final positions — the order
    // index is not deferrable, so an in-place swap would collide mid-statement.
    await tx.execute(sql`
      UPDATE marketing.campaign_type_rules SET rule_order = rule_order + 1000000
      WHERE tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted
    `);
    const cases = sql.join(ruleIds.map((id, i) => sql`WHEN ${id}::uuid THEN ${(i + 1) * 10}`), sql` `);
    await tx.execute(sql`
      UPDATE marketing.campaign_type_rules
      SET rule_order = CASE id ${cases} END
      WHERE tenant_id = ${ctx.tenant_id}::uuid AND NOT is_deleted
    `);
    return 'ok';
  });
}

export interface RuleTestResult {
  campaign_type_id: string | null;
  campaign_type_label: string | null;
  rule_id: string | null;
  match_field: string | null;
  pattern: string | null;
}

export async function testRules(ctx: RoleTxContext, names: TestRulesBody): Promise<RuleTestResult> {
  return inTenantTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT m.campaign_type_id, ct.label AS campaign_type_label, m.rule_id, m.match_field, m.pattern
      FROM marketing.fn_match_campaign_type_rules(
        ${ctx.tenant_id}::uuid,
        ${names.campaign_name?.trim() || null}::text,
        ${names.form_name?.trim() || null}::text,
        ${names.adset_name?.trim() || null}::text,
        ${names.ad_name?.trim() || null}::text
      ) m
      LEFT JOIN marketing.campaign_types ct ON ct.id = m.campaign_type_id
    `)) as unknown as RuleTestResult[];
    return rows[0] ?? { campaign_type_id: null, campaign_type_label: null, rule_id: null, match_field: null, pattern: null };
  });
}
