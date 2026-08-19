import { sql, and, eq, asc, isNull } from 'drizzle-orm';
import { withRoleTx, withServiceTx, sqlUuidArr, sqlTextArr } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import type { ScopeName } from '@platform/rbac';
import { resolveAutoAssignedUser } from '../../../lib/assignment.js';
import {
  leadStageTable,
  leadStageOutcomeTable,
  marketingLeadsTable,
  leadLinksTable,
  leadInteractionsTable,
  leadFollowUpsTable,
  interactionTypesTable,
} from '@platform/db/schema';
import { RANKS } from '@platform/authz';
import { BadRequestError, ConflictError, NotFoundError } from '../../../lib/errors.js';
import { resolveLeadWriteScope, effectiveInOrgActor } from '../../../lib/lead-write-scope.js';
import { insertFollowUpTx } from '../follow-ups/follow-ups.repository.js';
import type { CreateLeadInput, UpdateLeadInput } from '@lms/validation';

function coerceTags(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') return val.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

export interface ListLeadsFilters {
  status?: string;
  assigned_to?: string;
  assigned_user_id?: string;
  campaign_id?: string;
  search?: string;
  platforms?: string[];
  page: number;
  page_size: number;
  org_ids?: string[];
  actor_rank?: number;
  minRankToViewUnassigned: number;
  /** Broadest `lms.leads.view` scope the actor holds. Drives BOTH which rows are
   *  visible and which Postgres role the read runs under — see listLeads. */
  view_scope?: ScopeName | null;
  /** The actor + their reporting subtree, resolved by the service when
   *  view_scope is 'team'. */
  team_user_ids?: string[];
  /** May the actor see leads with no assignee? (rank >= minRankToViewUnassigned) */
  can_see_unassigned?: boolean;
  /** Exclude leads sitting in a terminal stage (converted / unqualified). */
  active_only?: boolean;
}

// Which rows of the branch(es) in scope this actor may see.
//
// Derived from the actor's `lms.leads.view` scope, NOT from whether the request
// happened to carry org_ids. The old rule keyed off `!useMultiOrg`, so simply
// sending an org_ids param skipped the own-leads fence entirely — which is how
// a 'team'-scoped holder of lms.leads.assign.bulk could pull (and reassign) an
// entire branch from the Bulk Assign screen. Scope decides; the request does not.
function visibilityClause(ctx: RoleTxContext, filters: ListLeadsFilters) {
  const scope = filters.view_scope ?? null;

  // 'org' and above see every row in the branches RLS already allows.
  if (scope === 'org' || scope === 'tenant' || scope === 'all') return undefined;

  const unassigned = filters.can_see_unassigned ? sql`assigned_user_id IS NULL` : undefined;

  if (scope === 'team') {
    // getTeamMemberIds always includes the actor, so an empty list means the
    // subtree could not be resolved — fall through to own-leads-only rather
    // than to "everything".
    const team = filters.team_user_ids?.length ? filters.team_user_ids : [ctx.user_id];
    return unassigned
      ? sql`(assigned_user_id = ANY(${sqlUuidArr(team)}) OR ${unassigned})`
      : sql`assigned_user_id = ANY(${sqlUuidArr(team)})`;
  }

  // 'own', or no scope at all: only what is assigned to the actor. An unassigned
  // lead is by definition nobody's, so it is excluded here even for an actor who
  // may view unassigned elsewhere — same rule Leads History's 'none' scope uses.
  return sql`assigned_user_id = ${ctx.user_id}::uuid`;
}

export async function listLeads(ctx: RoleTxContext, filters: ListLeadsFilters) {
  // A tenant-scoped reader needs the tenant Postgres role, or RLS pins the read
  // to their home branch and the branch they actually picked returns nothing.
  // The capability the controller resolved is the authority here, not
  // platform_role — see RoleTxContext.tenantWide.
  const tenantWide = filters.view_scope === 'tenant' || filters.view_scope === 'all';

  return withRoleTx({ ...ctx, ...(tenantWide ? { tenantWide: true, readOnly: true } : {}) }, async (tx) => {
    const { page, page_size } = filters;
    const offset = (page - 1) * page_size;
    const useMultiOrg = Boolean(filters.org_ids?.length);
    const assignedFilter = filters.assigned_user_id ?? filters.assigned_to;

    const where = and(
      sql`NOT is_deleted`,
      sql`superseded_by IS NULL`,
      useMultiOrg ? sql`org_id = ANY(${sqlUuidArr(filters.org_ids ?? [])})` : undefined,
      visibilityClause(ctx, filters),
      filters.active_only ? sql`is_terminated IS DISTINCT FROM TRUE` : undefined,
      filters.status ? sql`stage = ${filters.status}` : undefined,
      assignedFilter ? sql`assigned_user_id = ${assignedFilter}::uuid` : undefined,
      filters.campaign_id ? sql`campaign_id = ${filters.campaign_id}::uuid` : undefined,
      filters.search ? sql`full_name ILIKE ${`%${filters.search}%`}` : undefined,
      filters.platforms?.length ? sql`platform = ANY(${sqlTextArr(filters.platforms)})` : undefined,
    );

    const rows = (await tx.execute(sql`
      SELECT *, COUNT(*) OVER () AS total_count
      FROM lms.vw_dashboard_leads
      ${where ? sql`WHERE ${where}` : sql``}
      ORDER BY created_at DESC
      LIMIT ${page_size} OFFSET ${offset}
    `)) as Array<Record<string, unknown>>;

    const total = rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0;

    const [stage_options, stage_outcomes] = await Promise.all([
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

    return { leads: rows, total, page, page_size, stage_options, stage_outcomes };
  });
}

export async function getLeadById(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    // No explicit org_id filter here — RLS (org_isolation_policy for app_user,
    // tenant_isolation_policy for tenant_admin) already scopes this correctly,
    // and super_admin's service-role connection intentionally bypasses RLS.
    // A hardcoded `org_id = ctx.org_id` here would wrongly 404 a real lead
    // whenever the viewer's "acting" org differs from the lead's own org —
    // exactly the case for a tenant_admin/super_admin opening a lead from a
    // cross-org list (e.g. leads-history) that isn't their current session org.
    const rows = (await tx.execute(sql`
      SELECT *
      FROM lms.vw_dashboard_leads
      WHERE lead_id = ${leadId} AND NOT is_deleted
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

export async function getLeadFormData(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    // Single-table read from the base table — raw_webhook_data holds the verbatim
    // form submission captured at intake (e.g. Meta lead-gen field_data). RLS scopes
    // org/tenant access; no explicit org_id filter for the same reason as getLeadById.
    const rows = (await tx.execute(sql`
      SELECT raw_webhook_data, created_at
      FROM lms.marketing_leads
      WHERE id = ${leadId} AND NOT is_deleted
    `)) as Array<{ raw_webhook_data: Record<string, unknown> | null; created_at: string | Date }>;
    return rows[0] ?? null;
  });
}

export async function getLeadTimeline(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT
        event_id          AS "eventId",
        org_id            AS "orgId",
        lead_id           AS "leadId",
        event_type        AS "eventType",
        event_at          AS "eventAt",
        actor_name        AS "actorName",
        actor_email       AS "actorEmail",
        old_stage         AS "oldStage",
        old_stage_label   AS "oldStageLabel",
        new_stage         AS "newStage",
        new_stage_label   AS "newStageLabel",
        old_outcome       AS "oldOutcome",
        old_outcome_label AS "oldOutcomeLabel",
        new_outcome       AS "newOutcome",
        new_outcome_label AS "newOutcomeLabel",
        assigned_to_name  AS "assignedToName",
        note,
        followup_id       AS "followupId",
        followup_status   AS "followupStatus",
        followup_status_label AS "followupStatusLabel",
        scheduled_at      AS "scheduledAt",
        completed_at      AS "completedAt",
        interaction_type  AS "interactionType",
        interaction_type_label AS "interactionTypeLabel"
      FROM lms.vw_lead_followup_timeline
      WHERE lead_id = ${leadId}
      ORDER BY event_at DESC
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getLeadInteractions(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT li.*, u.full_name AS user_name, it.name AS interaction_type_name
      FROM lms.lead_interactions li
      JOIN iam.users u ON u.id = li.user_id
      LEFT JOIN lms.interaction_types it ON it.id = li.interaction_type_id
      WHERE li.lead_id = ${leadId} AND NOT li.is_deleted
      ORDER BY li.occurred_at DESC
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getLeadAssignmentHistory(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT log_id, lead_id, lead_full_name,
             assigned_by_name, assigned_by_email,
             assigned_to_name, assigned_to_email,
             previous_assignee_name,
             action, note, assigned_at, held_for
      FROM lms.vw_lead_assignment_timeline
      WHERE lead_id = ${leadId}
      ORDER BY assigned_at DESC
    `)) as Array<Record<string, unknown>>;
  });
}

export async function getLeadFollowUps(ctx: RoleTxContext, leadId: string) {
  return withRoleTx(ctx, async (tx) => {
    return (await tx.execute(sql`
      SELECT lf.*, u.full_name AS assigned_user_name, fs.name AS status_name, fs.label AS status_label
      FROM lms.lead_follow_ups lf
      JOIN iam.users u ON u.id = lf.assigned_user_id
      JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
      WHERE lf.lead_id = ${leadId} AND NOT lf.is_deleted
      ORDER BY lf.scheduled_at DESC
    `)) as Array<Record<string, unknown>>;
  });
}

export interface ListFollowUpsFilters {
  assigned_rep_id?: string;
  overdue_only?: boolean;
  actor_rank?: number;
  minRankToViewUnassigned: number;
}

export async function listFollowUps(ctx: RoleTxContext, filters: ListFollowUpsFilters) {
  return withRoleTx(ctx, async (tx) => {
    const where = and(
      sql`NOT ml.is_deleted`,
      sql`ml.superseded_by IS NULL`,
      sql`ml.org_id = ${ctx.org_id}::uuid`,
      sql`lstg.followup_required`,
      sql`ml.scheduled_at IS NOT NULL`,
      (filters.actor_rank !== undefined && filters.actor_rank < filters.minRankToViewUnassigned)
        ? sql`ml.assigned_user_id = ${ctx.user_id}::uuid`
        : (filters.assigned_rep_id ? sql`ml.assigned_user_id = ${filters.assigned_rep_id}::uuid` : undefined),
      filters.overdue_only ? sql`ml.scheduled_at < NOW()` : undefined,
    );

    // One row per lead. marketing_leads.scheduled_at/stage_id are the authoritative "current"
    // pointer (kept in sync on every follow-up create/reschedule/complete), so overdue/upcoming
    // is derived from them directly. lms.lead_follow_ups is append-only history — the lateral
    // join below only pulls its most recent row for display (id/status/notes), never to decide
    // whether the lead has an open follow-up.
    return (await tx.execute(sql`
      SELECT
        ml.id                             AS "leadId",
        lf.id                             AS "followUpId",
        ml.full_name                      AS "leadFullName",
        ml.phone                          AS "leadPhone",
        lstg.name                         AS "leadStage",
        lstg.label                        AS "leadStageLabel",
        u.full_name                       AS "assignedRepName",
        u.email                           AS "assignedRepEmail",
        (ml.scheduled_at < NOW())         AS "isOverdue",
        CASE WHEN ml.scheduled_at < NOW()
             THEN (EXTRACT(EPOCH FROM (NOW() - ml.scheduled_at)) / 60)::int
             ELSE NULL END                AS "minutesOverdue",
        fs.name                           AS "followUpStatus",
        fs.label                          AS "followUpStatusLabel",
        ml.scheduled_at                   AS "scheduledAt",
        li.created_at                     AS "lastInteractionAt",
        it.name                          AS "lastInteractionType",
        it.label                         AS "lastInteractionTypeLabel",
        lf.notes                         AS "notes"
      FROM lms.marketing_leads ml
      JOIN lms.lead_stage lstg ON lstg.id = ml.stage_id
      JOIN iam.users u ON u.id = ml.assigned_user_id
      LEFT JOIN LATERAL (
        SELECT lf2.*
        FROM lms.lead_follow_ups lf2
        WHERE lf2.lead_id = ml.id AND NOT lf2.is_deleted
        ORDER BY lf2.created_at DESC
        LIMIT 1
      ) lf ON true
      LEFT JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
      LEFT JOIN LATERAL (
        SELECT li2.created_at, li2.interaction_type_id
        FROM lms.lead_interactions li2
        WHERE li2.lead_id = ml.id
        ORDER BY li2.created_at DESC
        LIMIT 1
      ) li ON true
      LEFT JOIN lms.interaction_types it ON it.id = li.interaction_type_id
      WHERE ${where}
      ORDER BY (ml.scheduled_at < NOW()) DESC, ml.scheduled_at ASC
    `)) as Array<Record<string, unknown>>;
  });
}

// lms.lead_stage / lead_stage_outcome are tenant-scoped (N-6 Half B). Read
// under withRoleTx so RLS scopes rows to the caller's tenant (via current
// org) — a withServiceTx (BYPASSRLS) read would leak every tenant's stage
// catalog into the dropdown, as it previously did here. See
// lookups.repository.ts:getLookups for the same pattern.
export async function getStageOptions(ctx: RoleTxContext) {
  return withRoleTx(ctx, async (tx) => {
    return tx.select({
      id: leadStageTable.id,
      name: leadStageTable.name,
      label: leadStageTable.label,
      description: leadStageTable.description,
      sort_order: leadStageTable.sortOrder,
      followup_required: leadStageTable.followupRequired,
      is_rejected: leadStageTable.isRejected,
      is_terminated: leadStageTable.isTerminated,
    }).from(leadStageTable).orderBy(asc(leadStageTable.sortOrder));
  });
}

export async function getStageOutcomes(ctx: RoleTxContext, stageId?: string) {
  return withRoleTx(ctx, async (tx) => {
    const where = stageId ? eq(leadStageOutcomeTable.stageId, stageId) : undefined;
    return tx.select({
      id: leadStageOutcomeTable.id,
      name: leadStageOutcomeTable.name,
      label: leadStageOutcomeTable.label,
      description: leadStageOutcomeTable.description,
      stage_id: leadStageOutcomeTable.stageId,
      requires_comment: leadStageOutcomeTable.requiresComment,
      sort_order: leadStageOutcomeTable.sortOrder,
    }).from(leadStageOutcomeTable).where(where).orderBy(asc(leadStageOutcomeTable.sortOrder));
  });
}

export async function createLead(ctx: RoleTxContext, data: CreateLeadInput) {
  return withRoleTx(ctx, async (tx) => {
    const [defaultStage] = await tx
      .select({ id: leadStageTable.id })
      .from(leadStageTable)
      .where(eq(leadStageTable.name, 'new'))
      .limit(1);
    if (!defaultStage) throw new Error('Lead stage "new" not found');

    // Target org for the new lead. Defaults to the actor's own org; tenant_admin
    // may target any org within its tenant. The DB enforces this via the
    // org_isolation_policy / tenant_isolation_policy RLS WITH CHECK on
    // lms.marketing_leads — an unauthorized org_id is rejected at insert time,
    // it is never trusted on the basis of the request body alone.
    const targetOrgId = data.org_id ?? ctx.org_id;

    let duplicateLeadId: string | null = null;

    if (data.phone) {
      const [existing] = await tx
        .select({ id: marketingLeadsTable.id })
        .from(marketingLeadsTable)
        .where(and(
          eq(marketingLeadsTable.orgId, targetOrgId),
          eq(marketingLeadsTable.phone, data.phone),
          eq(marketingLeadsTable.isDeleted, false),
        ))
        .orderBy(asc(marketingLeadsTable.createdAt))
        .limit(1);
      if (existing) duplicateLeadId = existing.id;
    }

    if (data.email && !duplicateLeadId) {
      const [existing] = await tx
        .select({ id: marketingLeadsTable.id })
        .from(marketingLeadsTable)
        .where(and(
          eq(marketingLeadsTable.orgId, targetOrgId),
          eq(marketingLeadsTable.email, data.email),
          eq(marketingLeadsTable.isDeleted, false),
        ))
        .orderBy(asc(marketingLeadsTable.createdAt))
        .limit(1);
      if (existing) duplicateLeadId = existing.id;
    }

    const assignedUserId = data.assigned_user_id ?? await resolveAutoAssignedUser(tx, targetOrgId);

    const [inserted] = await tx
      .insert(marketingLeadsTable)
      .values({
        orgId: targetOrgId,
        firstName: data.first_name,
        middleName: data.middle_name ?? null,
        lastName: data.last_name ?? '',
        phone: data.phone ?? null,
        email: data.email ?? null,
        city: data.city ?? null,
        addressLine1: data.address_line1 ?? null,
        addressLine2: data.address_line2 ?? null,
        pincode: data.pincode ?? null,
        sourceId: data.source_id ?? null,
        campaignId: data.campaign_id ?? null,
        stageId: data.stage_id ?? defaultStage.id,
        assignedUserId,
        cityId: data.city_id ?? null,
        stateId: data.state_id ?? null,
        countryId: data.country_id ?? null,
        rawWebhookData: (data.raw_webhook_data ?? {}) as Record<string, unknown>,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
        tags: coerceTags(data.tags),
        createdBy: ctx.user_id,
      })
      .returning({ id: marketingLeadsTable.id });

    return { ...inserted!, duplicateLeadId };
  });
}

interface CurrentLeadRow {
  stage_id: string | null;
  outcome_id: string | null;
  outcome_comment: string | null;
  source_name: string | null;
  scheduled_at: Date | string | null;
  updated_at: Date | string;
}

/** Does this stage carry lead_stage.followup_required? NULL stage → false. */
async function stageRequiresFollowUp(
  tx: Parameters<Parameters<typeof withRoleTx>[1]>[0],
  stageId: string | null,
): Promise<boolean> {
  if (!stageId) return false;
  const rows = (await tx.execute(sql`
    SELECT followup_required FROM lms.lead_stage WHERE id = ${stageId}::uuid
  `)) as unknown as Array<{ followup_required: boolean | null }>;
  return Boolean(rows[0]?.followup_required);
}

// A lead parked in a followup_required stage with marketing_leads.scheduled_at
// NULL is invisible: the notifications-service poller requires scheduled_at IS
// NOT NULL, as does every overdue count and the follow-up queue. Nobody is
// reminded and nothing shows it is being neglected.
//
// The rule used to live only in the Edit Lead dialog (a client-side check), so
// any other caller — a script, an integration, or the dialog itself when its
// stage-catalog fetch failed — could move a lead into `contacting` and leave it
// dark. Enforcing it here makes the stage and its due time inseparable.
async function assertFollowUpIsScheduled(
  tx: Parameters<Parameters<typeof withRoleTx>[1]>[0],
  current: CurrentLeadRow,
  data: UpdateLeadInput,
): Promise<void> {
  // Scoped to a request that actually MOVES the stage. Leads that are already in
  // this state (written before the rule existed) must stay editable — refusing
  // every PATCH against them would mean a rep could not even re-assign one, and
  // the check would punish the people cleaning up rather than the write that
  // created the problem. Such a lead is repaired by the Edit Lead dialog, which
  // requires the due date for any edit while the stage needs a follow-up.
  if (data.stage_id === undefined || data.stage_id === current.stage_id) return;
  if (!(await stageRequiresFollowUp(tx, data.stage_id))) return;

  const willHaveFollowUp = data.follow_up_scheduled_at !== undefined || current.scheduled_at != null;
  if (!willHaveFollowUp) {
    throw new BadRequestError(
      'This status requires a follow-up. Provide follow_up_scheduled_at with the update.',
    );
  }
}

// `outcome_comment` is not an independent field: lms.check_lead_stage_outcome()
// NULLs it whenever the row ends up without an outcome, and again when a stage
// change orphans the outcome it belonged to. The API used to accept such a
// write and return 204, so a user typed a comment, saw a successful save, and
// the text was gone — data loss they had no way to detect.
//
// This reproduces the trigger's rules ahead of the UPDATE so the request is
// rejected with an explanation instead. Clearing the comment (empty/null) is
// always allowed — that agrees with the trigger rather than fighting it.
async function assertOutcomeCommentIsKeepable(
  tx: Parameters<Parameters<typeof withRoleTx>[1]>[0],
  current: CurrentLeadRow,
  data: UpdateLeadInput,
): Promise<void> {
  const stageId = data.stage_id !== undefined ? data.stage_id : current.stage_id;
  const outcomeId = data.outcome_id !== undefined ? data.outcome_id : current.outcome_id;

  // The trigger requires a non-empty outcome_comment whenever the resulting
  // outcome has requires_comment = TRUE, regardless of whether this request
  // touched outcome_comment at all. Check the outcome the row will end up
  // with, not just what was submitted, so an outcome-only PATCH that leaves
  // a required comment unset is rejected here instead of 500-ing on the raw
  // Postgres RAISE.
  if (outcomeId) {
    const finalComment = data.outcome_comment !== undefined ? data.outcome_comment : current.outcome_comment;
    const outcomeMetaRows = (await tx.execute(sql`
      SELECT stage_id::text AS stage_id, requires_comment FROM lms.lead_stage_outcome
      WHERE id = ${outcomeId}::uuid
    `)) as unknown as Array<{ stage_id: string | null; requires_comment: boolean | null }>;
    const outcomeMeta = outcomeMetaRows[0];

    if (outcomeMeta?.requires_comment && (typeof finalComment !== 'string' || finalComment.trim() === '')) {
      throw new BadRequestError(
        'This outcome requires a comment describing the reason. Please provide one.',
      );
    }

    // The outcome must belong to the stage the row will end up in; otherwise the
    // trigger either raises (explicit cross-stage outcome) or silently drops both
    // the outcome and the comment (outcome inherited across a stage change).
    //
    // Only reject on a stage we can actually see a mismatch for. This SELECT runs
    // under the caller's RLS, so an outcome row that is invisible here (e.g. a
    // catalog row whose tenant_id was never backfilled) returns nothing — that is
    // not evidence of a cross-stage pick, and claiming so would reject a
    // legitimate save. Defer to the trigger, which is the authority.
    const outcomeStageId = outcomeMeta?.stage_id;
    if (outcomeStageId !== undefined && outcomeStageId !== stageId) {
      throw new BadRequestError(
        'The selected outcome does not belong to this lead\'s stage, so the outcome and its comment cannot be saved. Pick an outcome that belongs to the stage.',
      );
    }
  }

  if (typeof data.outcome_comment !== 'string' || data.outcome_comment.trim() === '') return;

  if (!outcomeId) {
    throw new BadRequestError(
      'outcome_comment can only be saved together with an outcome. Select an outcome for this lead, or clear the comment.',
    );
  }
}

export async function updateLead(ctx: RoleTxContext, leadId: string, data: UpdateLeadInput) {
  return withRoleTx(ctx, async (tx) => {
    if (data.assigned_user_id !== undefined && data.assigned_user_id !== null) {
      const rows = (await tx.execute(sql`
        SELECT iam.can_assign_to(${ctx.org_id}::uuid, ${ctx.user_id}::uuid, ${data.assigned_user_id}::uuid) AS allowed
      `)) as Array<{ allowed: boolean }>;
      if (!rows[0]?.allowed) {
        throw new Error('Insufficient hierarchy authority to assign this lead');
      }
    }

    if (data.transition_note) {
      await tx.execute(sql`SELECT set_config('app.lead_transition_note', ${data.transition_note}, true)`);
    }

    // One locked read serves both checks below. FOR UPDATE is what makes the
    // concurrency check sound: without the lock two racing transactions both
    // read the same updated_at, both pass, and both write — the lost update we
    // are preventing. With it the second blocks, then re-reads the winner's
    // committed row and sees the version it expected is gone.
    // source_name rides along on this same read so the caller can decide whether
    // the lead is eligible for Meta CAPI feedback without a second query. It is a
    // scalar subquery rather than a join on purpose: FOR UPDATE would otherwise
    // try to lock lms.lead_sources too.
    const currentRows = (await tx.execute(sql`
      SELECT stage_id::text AS stage_id, outcome_id::text AS outcome_id, outcome_comment, updated_at,
             scheduled_at,
             (SELECT name FROM lms.lead_sources WHERE id = ml.source_id) AS source_name
      FROM lms.marketing_leads ml
      WHERE id = ${leadId}::uuid AND org_id = ${ctx.org_id}::uuid AND NOT is_deleted
      FOR UPDATE
    `)) as unknown as CurrentLeadRow[];
    const current = currentRows[0];
    // No row: fall through so the UPDATE below reports it as a 404, rather than
    // pre-empting it with a misleading conflict/validation error.
    if (current) {
      // Compared as epoch milliseconds, not as SQL timestamps: updated_at holds
      // microseconds, which a JS Date silently truncates, so an `updated_at =
      // :expected` guard in SQL would never match and every save would 409.
      if (data.expected_updated_at) {
        const expected = new Date(data.expected_updated_at).getTime();
        const actual = new Date(current.updated_at).getTime();
        if (Number.isNaN(expected)) {
          throw new BadRequestError('expected_updated_at is not a valid timestamp');
        }
        if (expected !== actual) {
          throw new ConflictError(
            'This lead was changed by someone else while you were editing it. Your changes were not saved — reload to see the current values, then re-apply them.',
          );
        }
      }
      await assertOutcomeCommentIsKeepable(tx, current, data);
      await assertFollowUpIsScheduled(tx, current, data);
    }

    const updateData: Record<string, unknown> = {};
    if (data.stage_id !== undefined)       updateData['stageId']       = data.stage_id;
    if (data.outcome_id !== undefined)     updateData['outcomeId']     = data.outcome_id;
    if (data.outcome_comment !== undefined) updateData['outcomeComment'] = data.outcome_comment;
    if (data.assigned_user_id !== undefined) updateData['assignedUserId'] = data.assigned_user_id;
    if (data.first_name !== undefined)     updateData['firstName']     = data.first_name;
    if (data.middle_name !== undefined)    updateData['middleName']    = data.middle_name;
    if (data.last_name !== undefined)      updateData['lastName']      = data.last_name;
    if (data.phone !== undefined)          updateData['phone']         = data.phone;
    if (data.email !== undefined)          updateData['email']         = data.email;
    if (data.city !== undefined)           updateData['city']          = data.city;
    if (data.city_id !== undefined)        updateData['cityId']        = data.city_id;
    if (data.state_id !== undefined)       updateData['stateId']       = data.state_id;
    if (data.country_id !== undefined)     updateData['countryId']     = data.country_id;
    if (data.address_line1 !== undefined)  updateData['addressLine1']  = data.address_line1;
    if (data.address_line2 !== undefined)  updateData['addressLine2']  = data.address_line2;
    if (data.pincode !== undefined)        updateData['pincode']       = data.pincode;
    if (data.source_id !== undefined)      updateData['sourceId']      = data.source_id;
    if (data.tags !== undefined)           updateData['tags']          = coerceTags(data.tags);
    if (data.metadata !== undefined)       updateData['metadata']      = data.metadata;

    // Moving a lead OUT of a follow-up stage (converted/unqualified/…) used to
    // leave the old due time on the row. Nothing surfaced it — every consumer
    // also joins lead_stage.followup_required — but the pointer then described a
    // follow-up nobody would ever do. Clear it, unless this same request is
    // scheduling one (checked below, and its insert would win anyway).
    if (
      data.stage_id !== undefined
      && current
      && data.stage_id !== current.stage_id
      && data.follow_up_scheduled_at === undefined
      && !(await stageRequiresFollowUp(tx, data.stage_id))
    ) {
      updateData['scheduledAt'] = null;
    }

    if (Object.keys(updateData).length === 0) {
      // A body carrying ONLY a follow-up would otherwise fall through this early
      // return and surface as "Lead not found" — a 404 for a lead that plainly
      // exists. This route schedules a follow-up alongside a lead change; on its
      // own it belongs to the dedicated endpoint.
      if (data.follow_up_scheduled_at !== undefined) {
        throw new BadRequestError(
          'follow_up_scheduled_at must accompany a lead change. Use POST /leads/:id/follow-ups to schedule one on its own.',
        );
      }
      return null;
    }

    // The row is already locked and version-checked above, so a plain guarded
    // UPDATE is enough here.
    const [updated] = await tx
      .update(marketingLeadsTable)
      .set(updateData as Parameters<typeof tx.update>[0] extends infer U ? Record<string, unknown> : never)
      .where(and(
        eq(marketingLeadsTable.id, leadId),
        eq(marketingLeadsTable.orgId, ctx.org_id),
        eq(marketingLeadsTable.isDeleted, false),
      ))
      .returning({ id: marketingLeadsTable.id, assignedUserId: marketingLeadsTable.assignedUserId });

    if (!updated) return null;

    // Same transaction as the stage move on purpose. The Edit Lead dialog used to
    // PATCH the stage and then POST the follow-up as a second request, so a
    // failure on the second left the lead in `contacting` with no due time and no
    // way for the user to tell.
    if (data.follow_up_scheduled_at !== undefined) {
      const assignedUserId = data.follow_up_assigned_user_id
        ?? updated.assignedUserId
        ?? await effectiveInOrgActor(tx, ctx.user_id, { orgId: ctx.org_id, assignedUserId: null });
      await insertFollowUpTx(tx, {
        orgId: ctx.org_id,
        leadId,
        assignedUserId,
        scheduledAt: new Date(data.follow_up_scheduled_at),
        notes: data.transition_note ?? null,
        createdBy: ctx.user_id,
      });
    }

    // Carried out for the Meta CAPI gate in the service layer: it needs to know
    // whether the stage actually moved, and whether this lead came from Meta.
    const outcome = {
      ...updated,
      previousStageId: current?.stage_id ?? null,
      sourceName: current?.source_name ?? null,
    };

    if (data.assigned_user_id !== undefined && data.assigned_user_id !== null) {
      await tx
        .update(leadFollowUpsTable)
        .set({ assignedUserId: data.assigned_user_id })
        .where(and(
          eq(leadFollowUpsTable.leadId, leadId),
          eq(leadFollowUpsTable.isDeleted, false),
          isNull(leadFollowUpsTable.completedAt),
        ));
    }

    if (data.note?.trim()) {
      await tx.insert(leadInteractionsTable).values({
        orgId: ctx.org_id,
        leadId,
        userId: ctx.user_id,
        notes: data.note.trim(),
      });
    }

    return outcome;
  });
}

export async function deleteLead(ctx: RoleTxContext, leadId: string, comment: string) {
  return withRoleTx(ctx, async (tx) => {
    await tx.insert(leadInteractionsTable).values({
      orgId: ctx.org_id,
      leadId,
      userId: ctx.user_id,
      notes: `Deletion reason: ${comment}`,
    });
    await tx.execute(sql`
      UPDATE lms.marketing_leads
      SET is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = ${ctx.user_id}::uuid
      WHERE id = ${leadId} AND org_id = ${ctx.org_id}
    `);
  });
}

export async function transferLead(
  ctx: RoleTxContext,
  sourceLeadId: string,
  targetOrgId: string,
  notes: string | undefined,
): Promise<{ sourceLeadId: string; newLeadId: string; assignedUserId: string | null }> {
  return withServiceTx(async (tx) => {
    // Fetch source lead — explicit org scoping (no RLS in service tx)
    const sourceRows = (await tx.execute(sql`
      SELECT id, org_id, first_name, middle_name, last_name, phone, email,
             address_line1, address_line2, pincode, city, city_id, state_id,
             country_id, source_id, campaign_id, tags, metadata, raw_webhook_data
      FROM lms.marketing_leads
      WHERE id = ${sourceLeadId}::uuid
        AND org_id = ${ctx.org_id}::uuid
        AND NOT is_deleted
        AND is_active = true
    `)) as Array<Record<string, unknown>>;

    if (!sourceRows[0]) throw new Error('Lead not found or already inactive');
    const src = sourceRows[0];

    // Verify target org is in the same tenant — explicit boundary check; fetch name for audit log
    const targetOrgRows = (await tx.execute(sql`
      SELECT o.id, o.name
      FROM entity.organizations o
      WHERE o.id = ${targetOrgId}::uuid
        AND o.tenant_id = (
          SELECT tenant_id FROM entity.organizations WHERE id = ${ctx.org_id}::uuid
        )
        AND NOT o.is_deleted AND o.is_active
    `)) as Array<{ id: string; name: string }>;

    if (!targetOrgRows[0]) throw new Error('Target org not found or not in the same tenant');
    const targetOrgName = targetOrgRows[0].name;

    // Stage lookups — lms.lead_stage is tenant-scoped (N-6 Half B) and this is a
    // BYPASSRLS service tx (transfer spans two orgs), so resolve stages for the
    // lead's tenant explicitly. Source and target orgs share a tenant (checked
    // above), so the source org's tenant is authoritative for both the new lead's
    // 'new' stage and the source lead's 'transferred_out' stage.
    const stageRows = (await tx.execute(sql`
      SELECT name, id FROM lms.lead_stage
      WHERE name IN ('new', 'transferred_out')
        AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${ctx.org_id}::uuid)
    `)) as Array<{ name: string; id: string }>;
    const newStageRow = stageRows.find((r) => r.name === 'new');
    const transferredOutStageRow = stageRows.find((r) => r.name === 'transferred_out');

    if (!newStageRow || !transferredOutStageRow) {
      throw new Error('Required lead stages not found for this tenant');
    }

    const autoAssignedUserId = await resolveAutoAssignedUser(tx, targetOrgId);

    const [newLead] = await tx
      .insert(marketingLeadsTable)
      .values({
        orgId:         targetOrgId,
        firstName:     src['first_name'] as string,
        middleName:    src['middle_name'] as string | null,
        lastName:      (src['last_name'] as string) ?? '',
        phone:         src['phone'] as string | null,
        email:         src['email'] as string | null,
        addressLine1:  src['address_line1'] as string | null,
        addressLine2:  src['address_line2'] as string | null,
        pincode:       src['pincode'] as string | null,
        city:          src['city'] as string | null,
        cityId:        src['city_id'] as string | null,
        stateId:       src['state_id'] as string | null,
        countryId:     src['country_id'] as string | null,
        sourceId:      src['source_id'] as string | null,
        campaignId:    src['campaign_id'] as string | null,
        stageId:       newStageRow.id,
        assignedUserId: autoAssignedUserId,
        tags:          coerceTags(src['tags']),
        metadata:      { ...(src['metadata'] as Record<string, unknown> ?? {}), transferred_from: sourceLeadId },
        rawWebhookData: (src['raw_webhook_data'] as Record<string, unknown> ?? {}),
        createdBy:     ctx.user_id,
      })
      .returning({ id: marketingLeadsTable.id });

    const newLeadId = newLead!.id;

    // Record the transfer link
    await tx.insert(leadLinksTable).values({
      sourceLeadId,
      sourceOrgId: ctx.org_id,
      destLeadId:  newLeadId,
      destOrgId:   targetOrgId,
      linkType:    'transfer',
      createdBy:   ctx.user_id,
      notes:       notes ?? null,
      status:      'completed',
    });

    // Set GUCs so the stage-change trigger captures actor + destination in lead_status_log
    const transitionNote = notes
      ? `Transferred to ${targetOrgName} — ${notes}`
      : `Transferred to ${targetOrgName}`;
    await tx.execute(sql`
      SELECT
        set_config('app.current_user_id',       ${ctx.user_id},      true),
        set_config('app.lead_transition_note',  ${transitionNote},    true)
    `);

    // Mark source lead as transferred out
    await tx
      .update(marketingLeadsTable)
      .set({
        stageId:     transferredOutStageRow.id,
        isActive:    false,
        supersededBy: newLeadId,
        updatedAt:   new Date(),
      })
      .where(and(
        eq(marketingLeadsTable.id, sourceLeadId),
        eq(marketingLeadsTable.orgId, ctx.org_id),
      ));

    return { sourceLeadId, newLeadId, assignedUserId: autoAssignedUserId };
  });
}

export async function createInteraction(
  ctx: RoleTxContext,
  leadId: string,
  data: { interaction_type_name?: string; notes?: string; occurred_at?: string },
) {
  return withRoleTx(ctx, async (tx) => {
    // Scope to the lead's REAL org (not the caller's home org). Invisible/cross-org
    // lead → null → clean 404; a platform super_admin's write lands in the lead's
    // org instead of raising the FK-org-scope trigger as a 500. See Issues #3/#4.
    const scope = await resolveLeadWriteScope(tx, leadId);
    if (!scope) throw new NotFoundError('Lead not found');

    let interactionTypeId: string | null = null;

    if (data.interaction_type_name) {
      const [typeRow] = await tx
        .select({ id: interactionTypesTable.id })
        .from(interactionTypesTable)
        .where(eq(interactionTypesTable.name, data.interaction_type_name))
        .limit(1);
      interactionTypeId = typeRow?.id ?? null;
    }

    // The interaction's user must map to the lead's org (DB trigger). Default to the
    // actor when they belong to that org, else the lead's assignee — records a
    // cross-org super_admin's interaction on behalf of the rep who owns the lead.
    const userId = await effectiveInOrgActor(tx, ctx.user_id, scope);

    const [inserted] = await tx
      .insert(leadInteractionsTable)
      .values({
        orgId: scope.orgId,
        leadId,
        userId,
        interactionTypeId,
        notes: data.notes ?? null,
        occurredAt: data.occurred_at ? new Date(data.occurred_at) : new Date(),
      })
      .returning({ id: leadInteractionsTable.id });

    return inserted!;
  });
}
