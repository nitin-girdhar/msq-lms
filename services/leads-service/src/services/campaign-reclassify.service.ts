import { sql } from 'drizzle-orm';
import { withServiceTx, sqlUuidArr } from '@platform/db';
import type { DrizzleTx } from '@platform/db';
import { resolveAutoAssignedUser, storedAutoAssignReason } from '../lib/assignment.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

/**
 * Re-routing leads after an admin corrects a Meta campaign's type.
 *
 * meta-conversion-api calls this the moment it writes a confirmed
 * campaign -> type mapping: it owns ext.meta_campaigns, but leads-service owns
 * the leads and the routing rules, so the fan-out lives here.
 *
 * Two separate things happen, and the difference matters:
 *
 *   RELABEL — every lead on that campaign, in every branch, gets the corrected
 *   campaign_type_id. Unconditional. A wrong label on a lead is just wrong.
 *
 *   RE-ROUTE — every OPEN lead of the campaign moves to the new type's pool in
 *   its own branch, unless its current owner already works that pool. Product
 *   decision 2026-09-26 (1.51.0), superseding the 1.49.0 rule that only moved
 *   auto-assigned, never-contacted leads: a lead of the wrong type sits with a
 *   team that cannot act on it (RLS hides a hiring lead from a sales rep), so
 *   leaving it there to protect a conversation left it with nobody who could
 *   finish that conversation. Unassigned open leads are picked into the new
 *   pool too.
 *
 * The DB work runs in one withServiceTx (BYPASSRLS). Justified: this is a
 * cross-BRANCH system operation invoked service-to-service with no user session,
 * so there is no org to scope an RLS transaction to — a campaign's leads are
 * spread across every branch that ran it. The tenant fence is therefore enforced
 * explicitly below, in SQL, against the campaign type's own tenant_id.
 */

export interface ReclassifyParams {
  metaCampaignId: string;
  campaignTypeId: string;
  dryRun: boolean;
  /** Stamped on lead_assignment_log.assigned_by_id when the caller knows who confirmed. */
  actorId?: string;
}

export interface ReclassifyBranchResult {
  org_id: string;
  org_name: string;
  leads_relabelled: number;
  leads_reassigned: number;
  leads_left_unassigned: number;
}

export interface ReclassifyResult {
  dry_run: boolean;
  campaigns_relabelled: number;
  leads_relabelled: number;
  leads_reassigned: number;
  leads_left_unassigned: number;
  by_branch: ReclassifyBranchResult[];
}

interface TypeRow {
  id: string;
  tenant_id: string;
  label: string;
}

interface CandidateLead {
  id: string;
  org_id: string;
  org_name: string;
}

interface AffectedLeadRow {
  org_id: string;
  org_name: string;
  lead_count: number;
}

/**
 * The leads of one Meta campaign inside one tenant. A lead belongs to the
 * campaign through its branch's marketing.ad_campaigns row, OR -- when that row
 * could not be created at intake (no catalogue status for the platform) and the
 * lead has no campaign_id -- through the Meta campaign id intake stamped into
 * metadata. Without the second arm those leads were never relabelled at all.
 * leads-service never reads ext.*, which is why metadata and not ext.meta_leads.
 */
function campaignLeadsPredicate(metaCampaignId: string, tenantId: string) {
  return sql`
    o.tenant_id = ${tenantId}::uuid
    AND NOT ml.is_deleted
    AND (
      EXISTS (SELECT 1 FROM marketing.ad_campaigns ac
              WHERE ac.id = ml.campaign_id AND ac.meta_campaign_id = ${metaCampaignId}::bigint)
      OR (ml.campaign_id IS NULL AND ml.metadata->>'campaign_id' = ${metaCampaignId})
    )`;
}

/**
 * Leads that CHANGE HANDS (1.51.0). All must hold:
 *
 *   1. active, not superseded, still open (non-terminated stage);
 *   2. either unassigned, or the current owner is not in the NEW type's pool for
 *      that branch -- an owner weighted for both pools simply keeps the lead.
 *
 * Interactions and manual assignment no longer protect a lead: see the header.
 *
 * Shared verbatim by the dry run and the real run -- the preview would otherwise
 * promise an impact different from the one the admin confirms.
 */
async function selectReroutableLeads(
  tx: DrizzleTx,
  metaCampaignId: string,
  tenantId: string,
  newTypeId: string,
): Promise<CandidateLead[]> {
  return (await tx.execute(sql`
    SELECT ml.id, ml.org_id, o.name AS org_name
    FROM lms.marketing_leads ml
    JOIN entity.organizations   o  ON o.id  = ml.org_id
    LEFT JOIN lms.lead_stage    ls ON ls.id = ml.stage_id
    WHERE ${campaignLeadsPredicate(metaCampaignId, tenantId)}
      AND ml.is_active
      AND ml.superseded_by IS NULL
      -- still open. IS DISTINCT FROM TRUE, not = FALSE: stage_id is nullable
      -- and the join is LEFT, so NULL = FALSE is NULL, which would drop every
      -- stageless lead right back out again.
      AND ls.is_terminated IS DISTINCT FROM TRUE
      -- unassigned, or the current owner is not in the new pool for THIS lead's
      -- branch. lms.lead_assignment_weights has no org_id -- the branch resolves
      -- through iam.user_org_mapping. Same department rule the picker applies: a
      -- weight row only counts when the owner's role department matches the new
      -- type's department.
      AND (
        ml.assigned_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM lms.lead_assignment_weights w
          JOIN iam.user_org_mapping uom ON uom.id = w.user_org_mapping_id
          JOIN iam.user_roles ur        ON ur.id  = uom.role_id
          JOIN marketing.campaign_types nct ON nct.id = w.campaign_type_id
          WHERE uom.user_id = ml.assigned_user_id
            AND uom.org_id  = ml.org_id
            AND uom.is_active
            AND w.campaign_type_id = ${newTypeId}::uuid
            AND w.weight > 0
            AND ur.department_id IS NOT NULL
            AND nct.department_id IS NOT DISTINCT FROM ur.department_id
        )
      )
    ORDER BY ml.org_id, ml.id
  `)) as unknown as CandidateLead[];
}

/** Every lead on the campaign, per branch — the relabel population. */
async function countAffectedLeads(
  tx: DrizzleTx,
  metaCampaignId: string,
  tenantId: string,
): Promise<AffectedLeadRow[]> {
  return (await tx.execute(sql`
    SELECT ml.org_id, o.name AS org_name, COUNT(*) AS lead_count
    FROM lms.marketing_leads ml
    JOIN entity.organizations   o  ON o.id  = ml.org_id
    WHERE ${campaignLeadsPredicate(metaCampaignId, tenantId)}
    GROUP BY ml.org_id, o.name
    ORDER BY o.name
  `)) as unknown as AffectedLeadRow[];
}

export async function reclassifyCampaign(params: ReclassifyParams): Promise<ReclassifyResult> {
  const { metaCampaignId, campaignTypeId, dryRun } = params;

  if (!/^\d+$/.test(metaCampaignId)) {
    throw new BadRequestError('meta_campaign_id must be a numeric Meta campaign id');
  }

  return withServiceTx(async (tx) => {
    const typeRows = (await tx.execute(sql`
      SELECT id, tenant_id, label
      FROM marketing.campaign_types
      WHERE id = ${campaignTypeId}::uuid AND is_active AND NOT is_deleted
      LIMIT 1
    `)) as unknown as TypeRow[];
    const newType = typeRows[0];
    if (!newType) throw new NotFoundError('Campaign type not found');

    // THE TENANT FENCE. RLS is bypassed on this transaction, so every query
    // above and below is qualified on the TYPE's tenant: a campaign that another
    // tenant also happens to run is never touched, and a type can never be
    // stamped on a lead outside its own tenant (which the FK would reject
    // anyway, but only after the relabel had already fanned out).
    const tenantId = newType.tenant_id;

    const affected = await countAffectedLeads(tx, metaCampaignId, tenantId);
    const candidates = await selectReroutableLeads(tx, metaCampaignId, tenantId, campaignTypeId);

    const byBranch = new Map<string, ReclassifyBranchResult>();
    for (const row of affected) {
      byBranch.set(row.org_id, {
        org_id: row.org_id,
        org_name: row.org_name,
        leads_relabelled: Number(row.lead_count),
        leads_reassigned: 0,
        leads_left_unassigned: 0,
      });
    }

    // Counted from a SELECT so the dry run reports the same number the real run
    // will change, rather than 0.
    const campaignRows = (await tx.execute(sql`
      SELECT ac.id
      FROM marketing.ad_campaigns ac
      JOIN entity.organizations o ON o.id = ac.org_id
      WHERE ac.meta_campaign_id = ${metaCampaignId}::bigint
        AND o.tenant_id = ${tenantId}::uuid
        AND ac.campaign_type_id IS DISTINCT FROM ${campaignTypeId}::uuid
    `)) as Array<{ id: string }>;
    const campaignsRelabelled = campaignRows.length;

    if (!dryRun) {
      // trg_lead_assignment_log fills assigned_by_id from this GUC; a service tx
      // does not set it the way withRoleTx does. Same pattern as
      // internal.repository.ts::reassignOrgLeads.
      if (params.actorId) {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${params.actorId}, true)`);
      }

      await tx.execute(sql`
        UPDATE marketing.ad_campaigns ac
        SET campaign_type_id = ${campaignTypeId}::uuid, updated_at = NOW()
        FROM entity.organizations o
        WHERE o.id = ac.org_id
          AND ac.meta_campaign_id = ${metaCampaignId}::bigint
          AND o.tenant_id = ${tenantId}::uuid
          AND ac.campaign_type_id IS DISTINCT FROM ${campaignTypeId}::uuid
      `);

      // Relabel everything EXCEPT the leads about to be re-routed. Those are
      // handled one statement at a time below, where the type change and the
      // assignee change land together — which is the only way
      // lms.log_lead_assignment() records the move as 'reclassified' rather than
      // as a plain 'reassigned'. Relabelling them here first would make the type
      // no longer DISTINCT by the time that statement ran.
      const excluded = candidates.map((c) => c.id);
      await tx.execute(sql`
        UPDATE lms.marketing_leads ml
        SET campaign_type_id = ${campaignTypeId}::uuid, updated_at = NOW()
        FROM entity.organizations o
        WHERE o.id = ml.org_id
          AND ${campaignLeadsPredicate(metaCampaignId, tenantId)}
          AND ml.campaign_type_id IS DISTINCT FROM ${campaignTypeId}::uuid
          ${excluded.length ? sql`AND ml.id <> ALL(${sqlUuidArr(excluded)})` : sql``}
      `);
    }

    let reassigned = 0;
    let leftUnassigned = 0;

    for (const lead of candidates) {
      const branch = byBranch.get(lead.org_id) ?? {
        org_id: lead.org_id,
        org_name: lead.org_name,
        leads_relabelled: 0,
        leads_reassigned: 0,
        leads_left_unassigned: 0,
      };
      byBranch.set(lead.org_id, branch);

      // IN THAT LEAD'S OWN BRANCH. A campaign runs across many branches and each
      // one has its own rotation; re-routing into another branch's pool would
      // hand the lead to someone who cannot act in that org at all.
      const pick = await resolveAutoAssignedUser(tx, lead.org_id, campaignTypeId);

      if (pick.userId) {
        reassigned += 1;
        branch.leads_reassigned += 1;
      } else {
        leftUnassigned += 1;
        branch.leads_left_unassigned += 1;
      }

      if (dryRun) continue;

      // The note the lead timeline shows. lms.log_lead_assignment() reads this
      // GUC into lead_assignment_log.note and, for a 'reclassified' row, appends
      // "From the <type> pool." itself. Set per lead: an empty target pool is a
      // different story from a successful move, and AC9 turns on that reason
      // being visible rather than the lead just going quiet.
      const note = pick.userId
        ? `Campaign reclassified to ${newType.label}.`
        : `Campaign reclassified to ${newType.label}; no eligible user in that pool for this branch.`;
      await tx.execute(sql`SELECT set_config('app.lead_transition_note', ${note}, true)`);

      // ONE statement, both columns. trg_lead_assignment_log fires AFTER UPDATE
      // OF assigned_user_id and only labels the row 'reclassified' when
      // campaign_type_id moved in that same statement. Splitting this into an
      // unassign then an assign would write 'unassigned' + 'initial' instead,
      // and the timeline would no longer say why the lead moved.
      await tx.execute(sql`
        UPDATE lms.marketing_leads
        SET assigned_user_id = ${pick.userId ? sql`${pick.userId}::uuid` : sql`NULL`},
            auto_assign_reason = ${storedAutoAssignReason(pick.reason)},
            campaign_type_id = ${campaignTypeId}::uuid,
            updated_at = NOW()
        WHERE id = ${lead.id}::uuid
      `);
    }

    const leadsRelabelled = affected.reduce((sum, r) => sum + Number(r.lead_count), 0);

    return {
      dry_run: dryRun,
      campaigns_relabelled: campaignsRelabelled,
      leads_relabelled: leadsRelabelled,
      leads_reassigned: reassigned,
      leads_left_unassigned: leftUnassigned,
      by_branch: [...byBranch.values()].sort((a, b) => a.org_name.localeCompare(b.org_name)),
    };
  });
}
