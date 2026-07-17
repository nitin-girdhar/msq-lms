import { sql, asc } from 'drizzle-orm';
import { withServiceTx, withRoleTx } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { marketingLeadsTable, leadStageTable, leadStageOutcomeTable } from '@crm/db/schema';

function sqlUuidArr(arr: string[]) {
  if (arr.length === 0) return sql`'{}'::uuid[]`;
  return sql`ARRAY[${sql.join(arr.map(v => sql`${v}::uuid`), sql`, `)}]`;
}

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
  FROM crm.marketing_leads ml
  JOIN entity.organizations o ON o.id = ml.org_id
  JOIN crm.lead_stage ls ON ls.id = ml.stage_id
  JOIN iam.users u ON u.id = ml.assigned_user_id
  LEFT JOIN iam.user_roles ur ON ur.id = u.role_id
  WHERE NOT ml.is_deleted AND ml.assigned_user_id IS NOT NULL
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
      FROM crm.marketing_leads ml
      JOIN entity.organizations o ON o.id = ml.org_id
      JOIN crm.lead_stage ls ON ls.id = ml.stage_id
      JOIN iam.users u ON u.id = ml.assigned_user_id
      LEFT JOIN iam.user_roles ur ON ur.id = u.role_id
      WHERE NOT ml.is_deleted AND ml.assigned_user_id IS NOT NULL AND ml.id = ${id}::uuid
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

export async function getUserForAssignment(ctx: RoleTxContext, targetUserId: string) {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT u.id, u.full_name, u.email, u.is_active, u.is_deleted,
             ur.rank, ur.name AS role_name
      FROM iam.users u
      JOIN iam.user_roles ur ON ur.id = u.role_id
      WHERE u.id = ${targetUserId}::uuid AND NOT u.is_deleted
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
      UPDATE crm.marketing_leads
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
      SELECT assigned_user_id FROM crm.marketing_leads WHERE id = ${data.lead_id}::uuid AND NOT is_deleted
    `)) as Array<{ assigned_user_id: string | null }>;

    const rows = (await tx.execute(sql`
      UPDATE crm.marketing_leads
      SET assigned_user_id = ${data.assigned_to}::uuid
      WHERE id = ${data.lead_id}::uuid AND NOT is_deleted
      RETURNING id, assigned_user_id, org_id, updated_at
    `)) as Array<Record<string, unknown>>;

    return { result: rows[0] ?? null, previous_assignee: before?.assigned_user_id ?? null };
  });
}

export async function unassignLead(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE crm.marketing_leads
      SET assigned_user_id = NULL
      WHERE id = ${leadId}::uuid AND NOT is_deleted
      RETURNING id, org_id
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

// ── Leads History ──────────────────────────────────────────────────────────

export interface LeadsHistoryFilters {
  userIds?: string[] | undefined;
  orgIds: string[] | null;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  stageIds?: string[] | undefined;
  outcomeIds?: string[] | undefined;
  activeOnly: boolean;
  page: number;
  pageSize: number;
}

export async function listAssignmentsFiltered(ctx: RoleTxContext, filters: LeadsHistoryFilters) {
  const offset = (filters.page - 1) * filters.pageSize;

  return withRoleTx(ctx, async (tx) => {
    const conditions: ReturnType<typeof sql>[] = [
      sql`NOT ml.is_deleted`,
      sql`ml.assigned_user_id IS NOT NULL`,
    ];

    if (filters.userIds?.length) {
      conditions.push(sql`ml.assigned_user_id = ANY(${sqlUuidArr(filters.userIds)})`);
    }
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
    if (filters.activeOnly) {
      conditions.push(sql`ls.is_terminated = FALSE`);
    }

    const where = sql.join(conditions, sql` AND `);

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
        ml.created_at       AS lead_created_at,
        ml.updated_at       AS assigned_at,
        ml.is_active, ml.superseded_by,
        COUNT(*) OVER ()    AS total_count
      FROM crm.marketing_leads ml
      JOIN entity.organizations o   ON o.id  = ml.org_id
      JOIN crm.lead_stage ls        ON ls.id = ml.stage_id
      JOIN iam.users u              ON u.id  = ml.assigned_user_id
      LEFT JOIN iam.user_roles ur   ON ur.id = u.role_id
      LEFT JOIN crm.lead_stage_outcome lso ON lso.id = ml.outcome_id
      WHERE ${where}
      ORDER BY ml.created_at DESC
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `)) as Array<Record<string, unknown>>;

    const total = rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0;
    return { assignments: rows, total, page: filters.page, page_size: filters.pageSize };
  });
}

export async function getStageAndOutcomeOptions() {
  return withServiceTx(async (tx) => {
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

export async function getTeamMemberIds(ctx: RoleTxContext, managerId: string, orgId: string): Promise<string[]> {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT member_id FROM iam.vw_user_team_members
      WHERE manager_id = ${managerId}::uuid AND org_id = ${orgId}::uuid
    `)) as Array<{ member_id: string }>;
    return [managerId, ...rows.map(r => r.member_id)];
  });
}
