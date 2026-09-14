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
  /** The role's department is set and equals the campaign type's department. */
  department_ok: boolean;
}

interface OpenLeadCount {
  assigned_user_id: string;
  open_count: number;
}

/**
 * Why a pick did or did not happen.
 *
 * This replaced a bare `null` return in 1.49.0. The old shape could not tell a
 * branch with nobody weighted apart from a branch whose weighted members all
 * lack the LMS capability, and callers had nothing to log either way: 10 of 30
 * production branches sat with no weighted user and auto-assign failed silently
 * for a long time before anyone noticed. Every caller must now log a
 * non-'assigned' reason — see intake.repository.ts's `lead.autoassign_skipped`.
 */
export type AutoAssignReason = 'assigned' | 'no_weighted_users' | 'no_department_match' | 'no_capable_users';

export interface AutoAssignResult {
  userId: string | null;
  reason: AutoAssignReason;
}

/**
 * Picks who a new, unassigned lead should go to WITHIN ONE (branch x campaign
 * type) POOL, based on each pool member's lms.lead_assignment_weights.weight
 * (% share) vs their current open-lead workload IN THAT SAME POOL.
 *
 * The type is not decoration: a hiring lead must reach the branch's HR rotation
 * and a sales lead its sales rotation, and lms.lead_assignment_weights is keyed
 * on (user_org_mapping_id, campaign_type_id) precisely so the two rotations are
 * separate memberships. Pass the type resolved by
 * lib/campaign-resolution.ts::resolveCampaignForLead, never a guess.
 *
 * A null campaignTypeId cannot match any weight row (the column is NOT NULL), so
 * it resolves to no pool at all and returns 'no_weighted_users'. That is the
 * honest answer: the alternative — falling back to an untyped, cross-pool
 * rotation — is the behaviour this change exists to remove.
 */
export async function resolveAutoAssignedUser(
  tx: DrizzleTx,
  orgId: string,
  campaignTypeId: string | null,
): Promise<AutoAssignResult> {
  if (!campaignTypeId) return { userId: null, reason: 'no_weighted_users' };

  const rows = (await tx.execute(sql`
    SELECT uom.user_id, w.weight, ur.name AS role_name, o.tenant_id,
           -- DEPARTMENT RULE (1.50.2): a weight only routes when the member's
           -- role sits in the campaign type's department. It is the same rule
           -- lms.fn_user_sees_campaign_type applies to visibility, so a pick can
           -- never hand someone a lead RLS then hides from them. Selected as a
           -- flag rather than filtered in WHERE so the caller can be told
           -- "weighted, but in the wrong department" apart from "nobody
           -- weighted" — rows that break the rule are kept on disk by decision
           -- and must be visible as the reason leads went unassigned.
           (ur.department_id IS NOT NULL
            AND ct.department_id IS NOT DISTINCT FROM ur.department_id) AS department_ok
    FROM iam.user_org_mapping uom
    -- INNER JOIN: a membership with no weight row is not in the rotation, which
    -- is what the weight > 0 filter below already meant when the weight was a
    -- NOT NULL DEFAULT 0 column on the mapping. The join does that filtering
    -- now; the explicit predicate is kept because an existing row CAN hold 0
    -- (deactivating a user zeroes it rather than deleting it).
    --
    -- Joined on the campaign type as well as the mapping since 1.49.0: the PK is
    -- (user_org_mapping_id, campaign_type_id), so one person holds one row per
    -- pool they belong to. Without this predicate the join fans a member out
    -- across every pool and a hiring lead can land on a sales-only rep.
    JOIN lms.lead_assignment_weights w
      ON w.user_org_mapping_id = uom.id
     AND w.campaign_type_id    = ${campaignTypeId}::uuid
    JOIN iam.users u             ON u.id  = uom.user_id
    JOIN iam.user_roles ur       ON ur.id = uom.role_id
    JOIN entity.organizations o  ON o.id  = uom.org_id
    JOIN marketing.campaign_types ct ON ct.id = w.campaign_type_id
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

  if (rows.length === 0) return { userId: null, reason: 'no_weighted_users' };

  const departmentRows = rows.filter((r) => r.department_ok);
  if (departmentRows.length === 0) return { userId: null, reason: 'no_department_match' };

  // The rank ladder is shared platform-wide, so a weighted org member whose
  // role has no LMS capability grant (e.g. a custom "Fitness Trainer" role
  // that happens to sit in-band) must not receive auto-assigned leads. All
  // rows share one org, hence one tenant, so this resolves once per distinct
  // role rather than once per row.
  //
  // Still CAPABILITY.LMS for every type: hiring leads are LMS leads too — they
  // live in lms.marketing_leads and are worked on the same screens — so the
  // product gate is unchanged by the split into pools. What a pool's members
  // see of the OTHER types is a separate question, answered by
  // lms.fn_user_sees_campaign_type() inside the row policy, not here.
  const tenantId = departmentRows[0]!.tenant_id;
  const roleNames = [...new Set(departmentRows.map((r) => r.role_name))];
  const lmsCapableRoles = new Set(
    (await Promise.all(roleNames.map(async (name) => [name, await hasCapability(tenantId, name, CAPABILITY.LMS)] as const)))
      .filter(([, ok]) => ok)
      .map(([name]) => name),
  );
  const eligibleRows = departmentRows.filter((r) => lmsCapableRoles.has(r.role_name));

  if (eligibleRows.length === 0) return { userId: null, reason: 'no_capable_users' };

  // SCOPED TO THE SAME POOL, and this is the easiest thing here to get wrong.
  // The deficit below is "share of the pool's work minus work already held", so
  // both halves have to be measured in the same pool. Counting a user's whole
  // open book instead would let a rep with 50 open SALES leads look permanently
  // over-served in the HIRING rotation and starve them of hiring leads
  // altogether — invisible on a small test dataset, systematic in production.
  const countRows = (await tx.execute(sql`
    SELECT ml.assigned_user_id, COUNT(*) AS open_count
    FROM lms.marketing_leads ml
    JOIN lms.lead_stage ls ON ls.id = ml.stage_id
    WHERE ml.org_id = ${orgId}::uuid
      AND ml.campaign_type_id = ${campaignTypeId}::uuid
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

  // Random, not first-wins: a deterministic tie-break clusters every new lead on
  // whichever user happens to sort first until their count finally moves.
  return { userId: candidates[Math.floor(Math.random() * candidates.length)]!, reason: 'assigned' };
}
