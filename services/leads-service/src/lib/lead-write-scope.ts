import { sql } from 'drizzle-orm';
import { withRoleTx } from '@platform/db';
import type { DrizzleTx, RoleTxContext } from '@platform/db';
import { ForbiddenError } from './errors.js';

// ── Cross-org write scoping for lead sub-resources (follow-ups, interactions) ──
//
// lms.lead_follow_ups / lms.lead_interactions carry their own org_id, and DB
// triggers (check_follow_up_fk_org_scope / check_interaction_fk_org_scope) reject
// any row whose org_id does not match the parent lead's org — and whose
// assigned/acting user has no active mapping to that org. Blindly stamping the
// row with the CALLER's home org (ctx.org_id) therefore blows up as a raw 500
// whenever the acting org differs from the lead's own org:
//   • a regular user targeting a lead outside their org (should be 404), and
//   • a platform super_admin (homed in one branch) acting on any other org's
//     lead (should succeed — platform scope).
//
// Resolving the lead's REAL org from the row — under the caller's RLS visibility —
// fixes both: an invisible lead returns null (→ clean 404), and a visible one
// yields the org the write must actually land in. See openissues.md Issues #3/#4.

export interface LeadWriteScope {
  /** The lead's own org — the org the sub-resource row must be stamped with. */
  orgId: string;
  /** The lead's current assignee — a user guaranteed to map to `orgId`, or null
   *  when the lead is unassigned. */
  assignedUserId: string | null;
}

/**
 * Resolve the parent lead for a write, scoped by the caller's RLS visibility.
 * Returns null when the lead is not visible/exists (caller gets a clean 404
 * instead of a trigger-raised 500).
 */
export async function resolveLeadWriteScope(
  tx: DrizzleTx,
  leadId: string,
): Promise<LeadWriteScope | null> {
  const rows = (await tx.execute(sql`
    SELECT org_id AS "orgId", assigned_user_id AS "assignedUserId"
    FROM lms.marketing_leads
    WHERE id = ${leadId}::uuid AND NOT is_deleted
    LIMIT 1
  `)) as Array<{ orgId: string; assignedUserId: string }>;
  return rows[0] ?? null;
}

/** Does `userId` hold an active mapping to `orgId`? (Same predicate the FK-org-scope
 *  triggers enforce.) */
export async function actorMapsToOrg(
  tx: DrizzleTx,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 AS ok
    FROM iam.user_org_mapping uom
    JOIN iam.users u ON u.id = uom.user_id
    WHERE uom.user_id = ${userId}::uuid
      AND uom.org_id  = ${orgId}::uuid
      AND uom.is_active
      AND u.is_active AND NOT u.is_deleted
    LIMIT 1
  `)) as Array<{ ok: number }>;
  return rows.length > 0;
}

/**
 * The user id to attribute an in-org write to, in priority order:
 *   1. the actor, when they hold a mapping to the lead's org (the normal case —
 *      a user acting in an org they belong to);
 *   2. else the lead's current assignee — records a cross-org platform/tenant
 *      admin's write on behalf of the rep who owns the lead;
 *   3. else the actor themselves — the lead is UNASSIGNED and the actor is a
 *      cross-org super_admin/tenant_admin with no mapping here. The FK-org-scope
 *      trigger now accepts these actors via iam.fn_actor_can_act_in_org, so
 *      attributing to the actor is valid instead of raising on a null assignee.
 */
export async function effectiveInOrgActor(
  tx: DrizzleTx,
  actorUserId: string,
  scope: LeadWriteScope,
): Promise<string> {
  if (await actorMapsToOrg(tx, actorUserId, scope.orgId)) return actorUserId;
  return scope.assignedUserId ?? actorUserId;
}

// ── Which branch a lead write actually lands in ────────────────────────────────
//
// The grid and the write path used to disagree about branches: `listLeads`
// promotes a tenant-scoped reader to the `tenant_admin` PG role, so the dashboard
// lists every branch's leads, while every write was pinned to `ctx.org_id` — the
// branch the actor happens to be switched into. Editing a lead the grid had just
// shown therefore matched zero rows and surfaced as "Lead not found" for a lead
// that plainly exists. Resolve the lead's OWN org and run the write there.

/**
 * The lead's branch, fenced to the caller's tenant.
 *
 * Reads under the tenant role deliberately: the whole point is to see a lead in a
 * sibling branch, which `app_user` RLS would hide. `readOnly: true` makes the
 * transaction physically incapable of writing, and the `o.tenant_id` join is what
 * stops this from ever reaching across tenants — the id comes from the verified
 * session, never from the request. Same query as
 * assignments.repository.getLeadOrgId, which has served the Assignments grid.
 *
 * Returns null for a lead that does not exist, is deleted, or belongs to another
 * tenant — all of which the caller reports as a plain 404.
 */
export async function resolveLeadOrgId(ctx: RoleTxContext, leadId: string): Promise<string | null> {
  return withRoleTx({ ...ctx, tenantWide: true, readOnly: true }, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ml.org_id
      FROM lms.marketing_leads ml
      JOIN entity.organizations o ON o.id = ml.org_id AND NOT o.is_deleted
      WHERE ml.id = ${leadId}::uuid AND NOT ml.is_deleted
        AND o.tenant_id = ${ctx.tenant_id}::uuid
    `)) as Array<{ org_id: string }>;
    return rows[0] ? String(rows[0].org_id) : null;
  });
}

/** The branches this actor manages: their own active mappings, tenant-fenced. The
 *  same set the header's branch switcher is built from. */
export async function getCoveredOrgIds(ctx: RoleTxContext): Promise<string[]> {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT uom.org_id
      FROM iam.user_org_mapping uom
      JOIN entity.organizations o ON o.id = uom.org_id AND NOT o.is_deleted
      WHERE uom.user_id = ${ctx.user_id}::uuid
        AND uom.is_active
        AND o.tenant_id = ${ctx.tenant_id}::uuid
    `)) as Array<{ org_id: string }>;
    const ids = rows.map((r) => String(r.org_id));
    return ids.length ? ids : [ctx.org_id];
  });
}

/**
 * The transaction context a write against `leadOrgId` must run under, plus the
 * assertion that this actor may write there at all.
 *
 * Cross-branch reach is NOT taken from the lms.leads.edit ladder: its widest rung
 * is `.any`, which resolveScope reports as 'all' but which means org-wide — a
 * branch admin holding it must not become tenant-wide. The two signals that do
 * mean cross-branch are the platform role (tenant_admin/super_admin) and the
 * actor's own active org mappings.
 *
 * The elevated context also carries the LEAD's org, so `app.current_org_id` — and
 * with it every audit trigger (audit.marketing_leads_history, lms.lead_status_log,
 * lms.lead_assignment_log) — records the branch the row actually lives in rather
 * than the branch the actor was sitting in. user_id/tenant_id are untouched: the
 * acting user is always the verified session user.
 *
 * `tenantWide` is not an RLS bypass — tenant_isolation_policy still fences every
 * row to app.current_tenant_id. It widens BRANCH reach inside one tenant, which is
 * why callers keep an explicit `org_id = leadOrgId` predicate on each statement
 * rather than leaning on RLS alone. Same trade-off assignments.service.writeCtxForOrg
 * already makes for Bulk Assign.
 */
export async function leadWriteCtx(ctx: RoleTxContext, leadOrgId: string): Promise<RoleTxContext> {
  if (leadOrgId === ctx.org_id) return ctx;
  // super_admin already runs on the BYPASSRLS service connection; org_id only
  // feeds the audit GUC, so point it at the lead's branch like the others.
  if (ctx.role === 'super_admin') return { ...ctx, org_id: leadOrgId };
  if (ctx.role === 'tenant_admin') return { ...ctx, org_id: leadOrgId, tenantWide: true };
  const covered = await getCoveredOrgIds(ctx);
  if (!covered.includes(leadOrgId)) {
    throw new ForbiddenError('This lead belongs to a branch you cannot edit in');
  }
  return { ...ctx, org_id: leadOrgId, tenantWide: true };
}
