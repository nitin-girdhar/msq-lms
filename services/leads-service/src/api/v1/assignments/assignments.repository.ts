import { sql, asc } from 'drizzle-orm';
import { withRoleTx, sqlUuidArr } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { marketingLeadsTable, leadStageTable, leadStageOutcomeTable } from '@platform/db/schema';
import { isTenantWideRole } from '@platform/authz';

const ASSIGNMENT_SELECT = sql`
  SELECT
    ml.id               AS id,
    ml.id               AS lead_id,
    o.name              AS branch,
    ml.assigned_user_id AS assigned_to,
    u.full_name         AS assigned_rep_name,
    u.email             AS assigned_rep_email,
    ur.name             AS assigned_rep_role,
    ml.full_name        AS lead_full_name,
    ml.phone            AS lead_phone,
    ml.email            AS lead_email,
    ml.org_id,
    ls.name             AS lead_stage,
    ml.updated_at       AS assigned_at,
    COUNT(*) OVER ()    AS total_count
  FROM lms.marketing_leads ml
  JOIN entity.organizations o ON o.id = ml.org_id
  JOIN lms.lead_stage ls ON ls.id = ml.stage_id
  JOIN iam.users u ON u.id = ml.assigned_user_id
  LEFT JOIN iam.user_roles ur ON ur.id = u.role_id
  WHERE NOT ml.is_deleted AND ml.superseded_by IS NULL AND ml.assigned_user_id IS NOT NULL
`;

export async function listAllAssignments(ctx: RoleTxContext, orgIds: string[] | null, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  return withRoleTx(ctx, async (tx) => {
    const rows = orgIds === null
      ? (await tx.execute(sql`
          ${ASSIGNMENT_SELECT}
          ORDER BY ml.updated_at DESC LIMIT ${pageSize} OFFSET ${offset}
        `)) as Array<Record<string, unknown>>
      : (await tx.execute(sql`
          ${ASSIGNMENT_SELECT}
          AND ml.org_id = ANY(${sqlUuidArr(orgIds)})
          ORDER BY ml.updated_at DESC LIMIT ${pageSize} OFFSET ${offset}
        `)) as Array<Record<string, unknown>>;
    const total = rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0;
    return { assignments: rows, total, page, page_size: pageSize };
  });
}

export async function listMyAssignments(ctx: RoleTxContext, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      ${ASSIGNMENT_SELECT}
      AND ml.assigned_user_id = ${ctx.user_id}::uuid AND ml.org_id = ${ctx.org_id}::uuid
      ORDER BY ml.updated_at DESC LIMIT ${pageSize} OFFSET ${offset}
    `)) as Array<Record<string, unknown>>;
    const total = rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0;
    return { assignments: rows, total, page, page_size: pageSize };
  });
}

export async function getAssignmentById(ctx: RoleTxContext, id: string) {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ml.id, ml.id AS lead_id, o.name AS branch,
             ml.assigned_user_id AS assigned_to,
             u.full_name AS assigned_rep_name, u.email AS assigned_rep_email,
             ur.name AS assigned_rep_role,
             ml.full_name AS lead_full_name, ml.phone AS lead_phone, ml.email AS lead_email,
             ml.org_id, ls.name AS lead_stage, ml.updated_at AS assigned_at
      FROM lms.marketing_leads ml
      JOIN entity.organizations o ON o.id = ml.org_id
      JOIN lms.lead_stage ls ON ls.id = ml.stage_id
      JOIN iam.users u ON u.id = ml.assigned_user_id
      LEFT JOIN iam.user_roles ur ON ur.id = u.role_id
      WHERE NOT ml.is_deleted AND ml.superseded_by IS NULL AND ml.assigned_user_id IS NOT NULL AND ml.id = ${id}::uuid
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

/**
 * The assignment target, resolved within the branches the CALLER covers.
 *
 * iam.users carries org_isolation_policy, which scopes app_user to the branch
 * the caller is switched into — so a plain read returned null for a target in
 * another of the caller's own branches, and the assignment failed as "target
 * not found" long before any authority check ran. The read is therefore
 * elevated, and bounded instead by an EXISTS over the caller's active mappings:
 * the target must share a branch with the caller. A user the caller covers no
 * branch with still resolves to null, exactly as before.
 *
 * Rank comes from the shared branch's mapping row rather than u.role_id, since
 * the same person can hold different roles in different branches and it is the
 * role in the branch they are being assigned in that governs.
 *
 * A tenant-wide role skips the shared-branch requirement: they are not always
 * mapped to every branch individually (see auth.service's getMyOrgs), so
 * requiring a shared mapping would REMOVE reach they have today. The tenant
 * predicate still bounds them. This is only the lookup — iam.can_assign_to,
 * evaluated against the lead's own org, remains the authority on the write.
 */
export async function getUserForAssignment(ctx: RoleTxContext, targetUserId: string) {
  const sharesABranchWithCaller = isTenantWideRole(ctx.role)
    ? sql`TRUE`
    : sql`EXISTS (
        SELECT 1 FROM iam.user_org_mapping a_uom
        WHERE a_uom.user_id = ${ctx.user_id}::uuid
          AND a_uom.org_id = t_uom.org_id
          AND a_uom.is_active
      )`;
  return withRoleTx({ ...ctx, tenantWide: true, readOnly: true }, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT u.id, u.org_id, u.full_name, u.email, u.is_active, u.is_deleted,
             ur.rank, ur.name AS role_name
      FROM iam.users u
      JOIN iam.user_org_mapping t_uom ON t_uom.user_id = u.id AND t_uom.is_active
      JOIN iam.user_roles ur          ON ur.id = t_uom.role_id
      JOIN entity.organizations o     ON o.id = t_uom.org_id
      WHERE u.id = ${targetUserId}::uuid AND NOT u.is_deleted
        AND o.tenant_id = ${ctx.tenant_id}::uuid
        AND ${sharesABranchWithCaller}
      ORDER BY ur.rank DESC
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

export async function assignLead(ctx: RoleTxContext, data: {
  lead_id: string;
  assigned_to: string;
}) {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE lms.marketing_leads
      SET assigned_user_id = ${data.assigned_to}::uuid
      WHERE id = ${data.lead_id}::uuid AND assigned_user_id IS NULL AND NOT is_deleted
      RETURNING id, assigned_user_id, org_id, updated_at
    `)) as Array<Record<string, unknown>>;
    if (!rows[0]) throw Object.assign(new Error('Lead is already assigned'), { code: '23505' });
    return rows[0];
  });
}

export async function reassignLead(ctx: RoleTxContext, data: {
  lead_id: string;
  assigned_to: string;
}) {
  return withRoleTx(ctx, async (tx) => {
    const [before] = (await tx.execute(sql`
      SELECT assigned_user_id FROM lms.marketing_leads WHERE id = ${data.lead_id}::uuid AND NOT is_deleted
    `)) as Array<{ assigned_user_id: string | null }>;

    const rows = (await tx.execute(sql`
      UPDATE lms.marketing_leads
      SET assigned_user_id = ${data.assigned_to}::uuid
      WHERE id = ${data.lead_id}::uuid AND NOT is_deleted
      RETURNING id, assigned_user_id, org_id, updated_at
    `)) as Array<Record<string, unknown>>;

    return { result: rows[0] ?? null, previous_assignee: before?.assigned_user_id ?? null };
  });
}

export async function getLeadsForBulkAssignment(ctx: RoleTxContext, leadIds: string[]) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT id, org_id, assigned_user_id
      FROM lms.marketing_leads
      WHERE id = ANY(${sqlUuidArr(leadIds)}) AND NOT is_deleted AND superseded_by IS NULL
    `)) as Array<{ id: string; org_id: string; assigned_user_id: string | null }>;
  });
}

export async function bulkAssignLeads(ctx: RoleTxContext, data: {
  leadIds: string[];
  assignedTo: string;
}) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      UPDATE lms.marketing_leads
      SET assigned_user_id = ${data.assignedTo}::uuid
      WHERE id = ANY(${sqlUuidArr(data.leadIds)}) AND NOT is_deleted
        AND assigned_user_id IS DISTINCT FROM ${data.assignedTo}::uuid
      RETURNING id, org_id, assigned_user_id
    `)) as Array<Record<string, unknown>>;
  });
}

export async function unassignLead(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE lms.marketing_leads
      SET assigned_user_id = NULL
      WHERE id = ${leadId}::uuid AND NOT is_deleted
      RETURNING id, org_id
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

// ── Leads History ──────────────────────────────────────────────────────────

// How unassigned leads (assigned_user_id IS NULL) participate in the result.
// `userIds` alone cannot express the union case ("Rani OR unassigned"), hence a
// second axis.
//
//   mode      | userIds     | meaning
//   ----------|-------------|--------------------------------------------------
//   exclude   | empty       | all assigned leads in scope
//   exclude   | non-empty   | those users only
//   include   | empty       | everything — assigned and unassigned
//   include   | non-empty   | those users OR unassigned
//   only      | must be []  | unassigned only
export type UnassignedMode = 'exclude' | 'include' | 'only';

export interface LeadsHistoryFilters {
  userIds?: string[] | undefined;
  // Required, not optional-with-default: the compiler then forces every scope
  // branch in the service to state its intent, so a future branch cannot
  // silently inherit "include" and widen who sees unassigned leads.
  unassignedMode: UnassignedMode;
  orgIds: string[] | null;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  stageIds?: string[] | undefined;
  outcomeIds?: string[] | undefined;
  sourceIds?: string[] | undefined;
  activeOnly: boolean;
  sortBy?: LeadsHistorySortKey | undefined;
  sortDir?: SortDirection | undefined;
  page: number;
  pageSize: number;
}

// ORDER BY is built from this whitelist only — a client-supplied string is never
// interpolated into the SQL.
export type LeadsHistorySortKey = 'created_at' | 'assignee' | 'stage' | 'branch';
export type SortDirection = 'asc' | 'desc';

const SORT_EXPR: Record<LeadsHistorySortKey, ReturnType<typeof sql>> = {
  created_at: sql`ml.created_at`,
  // COALESCE, not `u.full_name NULLS FIRST`: the grid re-sorts its loaded page
  // client-side off a valueGetter that yields the literal 'Unassigned', so the
  // server must place unassigned rows where an alphabetical sort on that string
  // would. Sorting NULLs to one end instead makes rows visibly jump after each
  // fetch.
  assignee:   sql`COALESCE(u.full_name, 'Unassigned')`,
  stage:      sql`ls.label`,
  branch:     sql`o.name`,
};

export async function listAssignmentsFiltered(ctx: RoleTxContext, filters: LeadsHistoryFilters) {
  const offset = (filters.page - 1) * filters.pageSize;

  return withRoleTx(ctx, async (tx) => {
    const conditions: ReturnType<typeof sql>[] = [
      sql`NOT ml.is_deleted`,
      // A superseded row is a stale duplicate of a re-submitted lead (see
      // intake.repository.ts::createWebhookLead), not a distinct report-worthy
      // record — exclude it regardless of the activeOnly/stage filter.
      sql`ml.superseded_by IS NULL`,
    ];

    // Assignment predicate. The service is responsible for deciding whether the
    // caller may see unassigned leads at all (see listLeadsHistory); by the time
    // we get here that decision is already encoded in unassignedMode.
    if (filters.unassignedMode === 'only') {
      // 'only' ignores userIds by contract. Fail loudly rather than AND two
      // contradictory predicates and silently return zero rows.
      if (filters.userIds?.length) {
        throw new Error("listAssignmentsFiltered: unassignedMode 'only' cannot be combined with userIds");
      }
      conditions.push(sql`ml.assigned_user_id IS NULL`);
    } else if (filters.unassignedMode === 'exclude') {
      conditions.push(sql`ml.assigned_user_id IS NOT NULL`);
      if (filters.userIds?.length) {
        conditions.push(sql`ml.assigned_user_id = ANY(${sqlUuidArr(filters.userIds)})`);
      }
    } else if (filters.userIds?.length) {
      conditions.push(
        sql`(ml.assigned_user_id = ANY(${sqlUuidArr(filters.userIds)}) OR ml.assigned_user_id IS NULL)`,
      );
    }
    // 'include' with no userIds → no assignment predicate at all.
    if (filters.orgIds !== null && filters.orgIds.length > 0) {
      conditions.push(sql`ml.org_id = ANY(${sqlUuidArr(filters.orgIds)})`);
    }
    if (filters.dateFrom) {
      conditions.push(sql`ml.created_at >= ${filters.dateFrom}::timestamptz`);
    }
    if (filters.dateTo) {
      conditions.push(sql`ml.created_at <= (${filters.dateTo}::date + INTERVAL '1 day')`);
    }
    if (filters.stageIds?.length) {
      conditions.push(sql`ml.stage_id = ANY(${sqlUuidArr(filters.stageIds)})`);
    }
    if (filters.outcomeIds?.length) {
      conditions.push(sql`ml.outcome_id = ANY(${sqlUuidArr(filters.outcomeIds)})`);
    }
    if (filters.sourceIds?.length) {
      conditions.push(sql`ml.source_id = ANY(${sqlUuidArr(filters.sourceIds)})`);
    }
    if (filters.activeOnly) {
      // IS DISTINCT FROM TRUE, not `= FALSE`: lead_stage is LEFT JOINed because
      // ml.stage_id is nullable, and `NULL = FALSE` is NULL, which would drop
      // every stageless lead right back out again. Opt-in only — the report's
      // default shows leads of every status; the Stage filter narrows this.
      conditions.push(sql`ls.is_terminated IS DISTINCT FROM TRUE`);
    }

    const where = sql.join(conditions, sql` AND `);

    const sortExpr = SORT_EXPR[filters.sortBy ?? 'created_at'];
    const sortDir = filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`;

    const rows = (await tx.execute(sql`
      SELECT
        ml.id, ml.id AS lead_id,
        o.name              AS branch,
        ml.assigned_user_id AS assigned_to,
        u.full_name         AS assigned_rep_name,
        u.email             AS assigned_rep_email,
        ur.name             AS assigned_rep_role,
        ml.full_name        AS lead_full_name,
        ml.phone            AS lead_phone,
        ml.email            AS lead_email,
        ml.org_id,
        ls.name             AS lead_stage,
        ls.label            AS lead_stage_label,
        ls.is_terminated,
        lso.name            AS lead_stage_outcome,
        lso.label           AS lead_stage_outcome_label,
        src.name            AS lead_source,
        src.label           AS lead_source_label,
        ml.created_at       AS lead_created_at,
        ml.updated_at       AS assigned_at,
        ml.is_active, ml.superseded_by,
        COUNT(*) OVER ()    AS total_count
      FROM lms.marketing_leads ml
      JOIN entity.organizations o   ON o.id  = ml.org_id
      LEFT JOIN lms.lead_stage ls   ON ls.id = ml.stage_id
      LEFT JOIN iam.users u         ON u.id  = ml.assigned_user_id
      LEFT JOIN iam.user_roles ur   ON ur.id = u.role_id
      LEFT JOIN lms.lead_stage_outcome lso ON lso.id = ml.outcome_id
      LEFT JOIN lms.lead_sources src ON src.id = ml.source_id
      WHERE ${where}
      ORDER BY ${sortExpr} ${sortDir}, ml.created_at DESC, ml.id
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `)) as Array<Record<string, unknown>>;

    const total = rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0;
    return { assignments: rows, total, page: filters.page, page_size: filters.pageSize };
  });
}

// lms.lead_stage / lead_stage_outcome are tenant-scoped (N-6 Half B). Read
// under withRoleTx so RLS scopes rows to the caller's tenant — a
// withServiceTx (BYPASSRLS) read would leak every tenant's stage catalog
// into this filter, as it previously did here.
export async function getStageAndOutcomeOptions(ctx: RoleTxContext) {
  return withRoleTx(ctx, async (tx) => {
    const [stageOptions, stageOutcomes] = await Promise.all([
      tx.select({
        id: leadStageTable.id,
        name: leadStageTable.name,
        label: leadStageTable.label,
        sort_order: leadStageTable.sortOrder,
        followup_required: leadStageTable.followupRequired,
        is_rejected: leadStageTable.isRejected,
        is_terminated: leadStageTable.isTerminated,
      }).from(leadStageTable).orderBy(asc(leadStageTable.sortOrder)),
      tx.select({
        id: leadStageOutcomeTable.id,
        name: leadStageOutcomeTable.name,
        label: leadStageOutcomeTable.label,
        stage_id: leadStageOutcomeTable.stageId,
        requires_comment: leadStageOutcomeTable.requiresComment,
        sort_order: leadStageOutcomeTable.sortOrder,
      }).from(leadStageOutcomeTable).orderBy(asc(leadStageOutcomeTable.sortOrder)),
    ]);
    return { stage_options: stageOptions, stage_outcomes: stageOutcomes };
  });
}

/**
 * The branches this actor covers — every active iam.user_org_mapping row, not
 * just ctx.org_id, which is only the branch they are currently switched into
 * (BranchSwitcher / POST /auth/switch-org).
 *
 * Reads iam.vw_user_org_access, the same view identity-service's getUserOrgs
 * uses to build the branch picker, so the picker and the rows behind it cannot
 * disagree. The view is security_invoker and granted to app_user/tenant_admin
 * (07_grants.sql), so RLS still applies on top.
 *
 * Falls back to the current org when a legacy single-branch user has no mapping
 * row at all — never to "every org", which would be a silent widening.
 */
export async function getCoveredOrgIds(ctx: RoleTxContext): Promise<string[]> {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT org_id
      FROM iam.vw_user_org_access
      WHERE user_id = ${ctx.user_id}::uuid AND tenant_id = ${ctx.tenant_id}::uuid
    `)) as Array<{ org_id: string }>;
    const ids = rows.map((r) => String(r.org_id));
    return ids.length ? ids : [ctx.org_id];
  });
}

export async function getTeamMemberIds(ctx: RoleTxContext, managerId: string, orgId: string): Promise<string[]> {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT member_id FROM iam.vw_user_team_members
      WHERE manager_id = ${managerId}::uuid AND org_id = ${orgId}::uuid
    `)) as Array<{ member_id: string }>;
    return [managerId, ...rows.map(r => r.member_id)];
  });
}
