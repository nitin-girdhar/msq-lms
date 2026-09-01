import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';
import { hasCapability } from '@platform/db';
import { CAPABILITY } from '@platform/rbac';

// LMS auto-assignment eligibility bounds, on the iam.user_roles ladder this
// query reads. Inlined (not imported from @lms/authz) because this file used
// to live in the platform-shared @platform/db package (dependency-cruiser wall);
// moved into leads-service (P-1) since it's pure LMS business logic. Values
// match the LMS scale: read_only (0) .. lms_admin (80).
const LMS_RANK_READ_ONLY = 0;
const LMS_RANK_ADMIN = 80;

interface EligibleUser {
  user_id: string;
  weight: number;
  role_name: string;
}

interface OpenLeadCount {
  assigned_user_id: string;
  open_count: number;
}

/**
 * Picks who a new, unassigned lead should go to based on each org member's
 * lms.lead_assignment_weights.weight (% share) vs their current open-lead
 * workload.
 * Returns null when the org has no eligible weighted users — callers should
 * leave the lead unassigned in that case (existing/manual behavior).
 */
export async function resolveAutoAssignedUser(tx: DrizzleTx, orgId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT uom.user_id, w.weight, ur.name AS role_name, o.tenant_id
    FROM iam.user_org_mapping uom
    -- INNER JOIN: a membership with no weight row is not in the rotation, which
    -- is what the weight > 0 filter below already meant when the weight was a
    -- NOT NULL DEFAULT 0 column on the mapping. The join does that filtering
    -- now; the explicit predicate is kept because an existing row CAN hold 0
    -- (deactivating a user zeroes it rather than deleting it).
    JOIN lms.lead_assignment_weights w ON w.user_org_mapping_id = uom.id
    JOIN iam.users u             ON u.id  = uom.user_id
    JOIN iam.user_roles ur       ON ur.id = uom.role_id
    JOIN entity.organizations o  ON o.id  = uom.org_id
    WHERE uom.org_id = ${orgId}::uuid
      AND uom.is_active
      -- An active MAPPING is not enough. Deactivating a user writes
      -- iam.users.is_active and zeroes the weight, but leaves the org mapping
      -- itself untouched; lms.check_lead_fk_org_scope() then re-validates the pick
      -- through iam.fn_actor_can_act_in_org, which DOES check the user row.
      -- Picking such a user makes every insert RAISE — surfacing as a 404 out
      -- of intake and silently dropping every inbound lead for that branch
      -- (Gurugram - Sector 104, Aug 13-24). Mirror the trigger predicate
      -- exactly so the picker and the trigger cannot disagree again.
      AND u.is_active AND NOT u.is_deleted
      AND w.weight > 0
      AND ur.rank > ${LMS_RANK_READ_ONLY}
      AND ur.rank < ${LMS_RANK_ADMIN}
  `)) as unknown as Array<EligibleUser & { tenant_id: string }>;

  if (rows.length === 0) return null;

  // The rank ladder is shared platform-wide, so a weighted org member whose
  // role has no LMS capability grant (e.g. a custom "Fitness Trainer" role
  // that happens to sit in-band) must not receive auto-assigned leads. All
  // rows share one org, hence one tenant, so this resolves once per distinct
  // role rather than once per row.
  const tenantId = rows[0]!.tenant_id;
  const roleNames = [...new Set(rows.map((r) => r.role_name))];
  const lmsCapableRoles = new Set(
    (await Promise.all(roleNames.map(async (name) => [name, await hasCapability(tenantId, name, CAPABILITY.LMS)] as const)))
      .filter(([, ok]) => ok)
      .map(([name]) => name),
  );
  const eligibleRows = rows.filter((r) => lmsCapableRoles.has(r.role_name));

  if (eligibleRows.length === 0) return null;

  const countRows = (await tx.execute(sql`
    SELECT ml.assigned_user_id, COUNT(*) AS open_count
    FROM lms.marketing_leads ml
    JOIN lms.lead_stage ls ON ls.id = ml.stage_id
    WHERE ml.org_id = ${orgId}::uuid
      AND ml.is_active
      AND NOT ml.is_deleted
      AND NOT ls.is_terminated
      AND ml.assigned_user_id IS NOT NULL
    GROUP BY ml.assigned_user_id
  `)) as unknown as OpenLeadCount[];

  const countByUser = new Map<string, number>(
    countRows.map((r) => [r.assigned_user_id, Number(r.open_count)]),
  );

  const totalOpen = eligibleRows.reduce((sum, u) => sum + (countByUser.get(u.user_id) ?? 0), 0) + 1;

  let bestDeficit = -Infinity;
  let candidates: string[] = [];
  for (const u of eligibleRows) {
    const current = countByUser.get(u.user_id) ?? 0;
    const deficit = (u.weight / 100) * totalOpen - current;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      candidates = [u.user_id];
    } else if (deficit === bestDeficit) {
      candidates.push(u.user_id);
    }
  }

  return candidates[Math.floor(Math.random() * candidates.length)]!;
}
