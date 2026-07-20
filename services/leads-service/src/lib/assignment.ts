import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@platform/db';

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
}

interface OpenLeadCount {
  assigned_user_id: string;
  open_count: number;
}

/**
 * Picks who a new, unassigned lead should go to based on each org member's
 * lead_assignment_weight (% share) vs their current open-lead workload.
 * Returns null when the org has no eligible weighted users — callers should
 * leave the lead unassigned in that case (existing/manual behavior).
 */
export async function resolveAutoAssignedUser(tx: DrizzleTx, orgId: string): Promise<string | null> {
  const eligibleRows = (await tx.execute(sql`
    SELECT uom.user_id, uom.lead_assignment_weight AS weight
    FROM iam.user_org_mapping uom
    JOIN iam.user_roles ur ON ur.id = uom.role_id
    WHERE uom.org_id = ${orgId}::uuid
      AND uom.is_active
      AND uom.lead_assignment_weight > 0
      AND ur.rank > ${LMS_RANK_READ_ONLY}
      AND ur.rank < ${LMS_RANK_ADMIN}
  `)) as unknown as EligibleUser[];

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
