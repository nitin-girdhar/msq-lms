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
  /** The lead's current assignee — a user guaranteed to map to `orgId`. */
  assignedUserId: string;
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
 * The user id to attribute an in-org write to. Prefers the actor when they belong
 * to the lead's org; otherwise falls back to the lead's own assignee — the case
 * for a platform super_admin acting cross-org, who has no mapping in the target
 * org, so the row is recorded on behalf of the lead's owning rep.
 */
export async function effectiveInOrgActor(
  tx: DrizzleTx,
  actorUserId: string,
  scope: LeadWriteScope,
): Promise<string> {
  return (await actorMapsToOrg(tx, actorUserId, scope.orgId))
    ? actorUserId
    : scope.assignedUserId;
}
