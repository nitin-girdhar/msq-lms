import { sql } from 'drizzle-orm';
import { withServiceTx, sqlUuidArr } from '@platform/db';
import { resolveAutoAssignedUser, type AutoAssignReason } from '../../../lib/assignment.js';
import { BadRequestError, NotFoundError } from '../../../lib/errors.js';
import type { RerunBody } from './lead-assignment-rerun.schema.js';

/** Leads looked at per call — keeps one run well inside the gateway's 30s budget. */
export const RERUN_BATCH_LIMIT = 500;

const RERUN_NOTE = 'Auto-assignment re-run from the admin console.';

type SkipReason = Exclude<AutoAssignReason, 'assigned'>;

export interface RerunScope {
  tenantId: string;
  actorUserId: string;
}

export interface RerunBranchResult {
  org_id: string;
  org_name: string;
  campaign_type_id: string;
  campaign_type_label: string;
  assigned: number;
  left_unassigned: number;
  reasons: Record<SkipReason, number>;
}

export interface RerunResult {
  dry_run: boolean;
  /** Leads examined in this batch. */
  candidates: number;
  assigned: number;
  left_unassigned: number;
  /** Matching leads beyond this batch. */
  remaining: number;
  /** Pass back as body.cursor to continue after this batch; null when done. */
  next_cursor: string | null;
  by_branch: RerunBranchResult[];
}

interface CandidateRow {
  id: string;
  org_id: string;
  org_name: string;
  campaign_type_id: string;
  campaign_type_label: string;
  created_at: string;
  total_count: string;
}

/**
 * Re-runs auto-assignment for leads that arrived UNASSIGNED — typically because
 * their pool had nobody eligible (no weights, weights in the wrong department,
 * or no LMS-capable role) — once an admin has fixed that.
 *
 * withServiceTx (BYPASSRLS), a documented system operation, for the same reason
 * as services/campaign-reclassify.service.ts: lms.marketing_leads is org-scoped
 * RLS and this acts across every branch of ONE tenant for a platform
 * super_admin who holds no membership in it. The tenant fence is therefore
 * explicit in SQL on every statement: the tenant must exist, every filter id
 * must belong to it, and every lead is joined to its organization and required
 * to sit in that tenant.
 *
 * Candidate selection is ONE query shared by the dry run and the real run, so
 * the preview reports exactly the leads the real run acts on. It only fills
 * GAPS: a lead with an owner, with any logged interaction, in a terminated
 * stage, superseded or inactive is never touched — this tool must never move a
 * lead away from a person.
 */
export async function rerunAutoAssignment(
  scope: RerunScope,
  filters: RerunBody,
  dryRun: boolean,
): Promise<RerunResult> {
  return withServiceTx(async (tx) => {
    const tenantRows = (await tx.execute(sql`
      SELECT id FROM entity.tenants WHERE id = ${scope.tenantId}::uuid LIMIT 1
    `)) as Array<{ id: string }>;
    if (!tenantRows[0]) throw new NotFoundError('Tenant not found');

    if (filters.org_ids.length > 0) {
      const found = (await tx.execute(sql`
        SELECT id FROM entity.organizations
        WHERE id = ANY(${sqlUuidArr(filters.org_ids)})
          AND tenant_id = ${scope.tenantId}::uuid
          AND NOT is_deleted
      `)) as Array<{ id: string }>;
      const known = new Set(found.map((r) => r.id));
      const missing = filters.org_ids.filter((id) => !known.has(id));
      if (missing.length > 0) throw new BadRequestError(`Branch not found in this tenant: ${missing.join(', ')}`);
    }

    if (filters.campaign_type_ids.length > 0) {
      const found = (await tx.execute(sql`
        SELECT id FROM marketing.campaign_types
        WHERE id = ANY(${sqlUuidArr(filters.campaign_type_ids)})
          AND tenant_id = ${scope.tenantId}::uuid
      `)) as Array<{ id: string }>;
      const known = new Set(found.map((r) => r.id));
      const missing = filters.campaign_type_ids.filter((id) => !known.has(id));
      if (missing.length > 0) throw new BadRequestError(`Campaign type not found in this tenant: ${missing.join(', ')}`);
    }

    const [cursorAt, cursorId] = filters.cursor ? filters.cursor.split('|') as [string, string] : [null, null];

    const candidates = (await tx.execute(sql`
      SELECT ml.id,
             ml.org_id,
             o.name                 AS org_name,
             ml.campaign_type_id,
             ct.label               AS campaign_type_label,
             ml.created_at::text    AS created_at,
             COUNT(*) OVER ()       AS total_count
      FROM lms.marketing_leads ml
      JOIN entity.organizations o     ON o.id  = ml.org_id
      JOIN marketing.campaign_types ct ON ct.id = ml.campaign_type_id
      LEFT JOIN lms.lead_stage ls     ON ls.id = ml.stage_id
      WHERE o.tenant_id = ${scope.tenantId}::uuid
        AND ml.assigned_user_id IS NULL
        AND ml.is_active
        AND NOT ml.is_deleted
        AND ml.superseded_by IS NULL
        -- IS DISTINCT FROM TRUE: stage_id is nullable and the join is LEFT.
        AND ls.is_terminated IS DISTINCT FROM TRUE
        AND NOT EXISTS (
          SELECT 1 FROM lms.lead_interactions li
          WHERE li.lead_id = ml.id AND NOT li.is_deleted
        )
        ${filters.org_ids.length > 0 ? sql`AND ml.org_id = ANY(${sqlUuidArr(filters.org_ids)})` : sql``}
        ${filters.campaign_type_ids.length > 0 ? sql`AND ml.campaign_type_id = ANY(${sqlUuidArr(filters.campaign_type_ids)})` : sql``}
        ${cursorAt ? sql`AND (ml.created_at, ml.id) > (${cursorAt}::timestamptz, ${cursorId}::uuid)` : sql``}
      ORDER BY ml.created_at, ml.id
      LIMIT ${RERUN_BATCH_LIMIT}
    `)) as unknown as CandidateRow[];

    if (!dryRun && candidates.length > 0) {
      // Read by trg_lead_assignment_log: the actor on the log row, and the note
      // the lead timeline shows next to "From the <type> pool.".
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${scope.actorUserId}, true)`);
      await tx.execute(sql`SELECT set_config('app.lead_transition_note', ${RERUN_NOTE}, true)`);
    }

    const byKey = new Map<string, RerunBranchResult>();
    let assigned = 0;
    let leftUnassigned = 0;

    for (const lead of candidates) {
      const key = `${lead.org_id}:${lead.campaign_type_id}`;
      const bucket = byKey.get(key) ?? {
        org_id: lead.org_id,
        org_name: lead.org_name,
        campaign_type_id: lead.campaign_type_id,
        campaign_type_label: lead.campaign_type_label,
        assigned: 0,
        left_unassigned: 0,
        reasons: { no_weighted_users: 0, no_department_match: 0, no_capable_users: 0 },
      };
      byKey.set(key, bucket);

      // In the lead's OWN branch and type — the same department-aware picker
      // every intake path uses.
      const pick = await resolveAutoAssignedUser(tx, lead.org_id, lead.campaign_type_id);
      if (!pick.userId) {
        leftUnassigned += 1;
        bucket.left_unassigned += 1;
        if (pick.reason !== 'assigned') bucket.reasons[pick.reason] += 1;
        continue;
      }

      if (dryRun) {
        assigned += 1;
        bucket.assigned += 1;
        continue;
      }

      // `AND assigned_user_id IS NULL`: a person may have claimed the lead since
      // it was selected; their claim wins.
      const updated = (await tx.execute(sql`
        UPDATE lms.marketing_leads
        SET assigned_user_id = ${pick.userId}::uuid, updated_at = NOW()
        WHERE id = ${lead.id}::uuid AND assigned_user_id IS NULL
        RETURNING id
      `)) as Array<{ id: string }>;
      if (updated[0]) {
        assigned += 1;
        bucket.assigned += 1;
      }
    }

    const total = candidates[0] ? Number(candidates[0].total_count) : 0;
    const last = candidates[candidates.length - 1];
    const remaining = Math.max(total - candidates.length, 0);

    return {
      dry_run: dryRun,
      candidates: candidates.length,
      assigned,
      left_unassigned: leftUnassigned,
      remaining,
      next_cursor: remaining > 0 && last ? `${last.created_at}|${last.id}` : null,
      by_branch: [...byKey.values()].sort((a, b) =>
        a.org_name.localeCompare(b.org_name) || a.campaign_type_label.localeCompare(b.campaign_type_label)),
    };
  });
}
