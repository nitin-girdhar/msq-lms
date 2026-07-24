import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';

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
