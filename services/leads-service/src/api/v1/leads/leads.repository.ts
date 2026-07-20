import { sql, and, eq, asc, isNull } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { resolveAutoAssignedUser } from '../../../lib/assignment.js';
import {
  leadStageTable,
  leadStageOutcomeTable,
  marketingLeadsTable,
  leadLinksTable,
  leadInteractionsTable,
  leadFollowUpsTable,
  interactionTypesTable,
} from '@crm/db/schema';
import { RANKS } from '@platform/authz';
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
}

export async function listLeads(ctx: RoleTxContext, filters: ListLeadsFilters) {
  return withRoleTx(ctx, async (tx) => {
    const { page, page_size } = filters;
    const offset = (page - 1) * page_size;
    const useMultiOrg = Boolean(filters.org_ids?.length);
    const assignedFilter = filters.assigned_user_id ?? filters.assigned_to;

    const where = and(
      sql`NOT is_deleted`,
      useMultiOrg ? sql`org_id = ANY(${filters.org_ids}::uuid[])` : undefined,
      (!useMultiOrg && filters.actor_rank !== undefined && filters.actor_rank < filters.minRankToViewUnassigned)
        ? sql`assigned_user_id = ${ctx.user_id}::uuid`
        : undefined,
      filters.status ? sql`stage = ${filters.status}` : undefined,
      assignedFilter ? sql`assigned_user_id = ${assignedFilter}::uuid` : undefined,
      filters.campaign_id ? sql`campaign_id = ${filters.campaign_id}::uuid` : undefined,
      filters.search ? sql`full_name ILIKE ${`%${filters.search}%`}` : undefined,
      filters.platforms?.length ? sql`platform = ANY(${filters.platforms}::text[])` : undefined,
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
        scheduled_at      AS "scheduledAt",
        completed_at      AS "completedAt",
        interaction_type  AS "interactionType"
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
        u.full_name                       AS "assignedRepName",
        u.email                           AS "assignedRepEmail",
        (ml.scheduled_at < NOW())         AS "isOverdue",
        CASE WHEN ml.scheduled_at < NOW()
             THEN (EXTRACT(EPOCH FROM (NOW() - ml.scheduled_at)) / 60)::int
             ELSE NULL END                AS "minutesOverdue",
        fs.name                           AS "followUpStatus",
        ml.scheduled_at                   AS "scheduledAt",
        li.created_at                     AS "lastInteractionAt",
        it.name                          AS "lastInteractionType",
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

export async function getStageOptions() {
  return withServiceTx(async (tx) => {
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

export async function getStageOutcomes(stageId?: string) {
  return withServiceTx(async (tx) => {
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

    if (Object.keys(updateData).length === 0) return null;

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

    return updated;
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
        cityId:        src['city_id'] as number | null,
        stateId:       src['state_id'] as number | null,
        countryId:     src['country_id'] as number | null,
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
    let interactionTypeId: string | null = null;

    if (data.interaction_type_name) {
      const [typeRow] = await tx
        .select({ id: interactionTypesTable.id })
        .from(interactionTypesTable)
        .where(eq(interactionTypesTable.name, data.interaction_type_name))
        .limit(1);
      interactionTypeId = typeRow?.id ?? null;
    }

    const [inserted] = await tx
      .insert(leadInteractionsTable)
      .values({
        orgId: ctx.org_id,
        leadId,
        userId: ctx.user_id,
        interactionTypeId,
        notes: data.notes ?? null,
        occurredAt: data.occurred_at ? new Date(data.occurred_at) : new Date(),
      })
      .returning({ id: leadInteractionsTable.id });

    return inserted!;
  });
}
