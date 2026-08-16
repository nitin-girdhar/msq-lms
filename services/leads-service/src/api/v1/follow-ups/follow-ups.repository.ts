import { sql, eq, and } from 'drizzle-orm';
import { withRoleTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { leadFollowUpsTable, followUpStatusesTable, marketingLeadsTable } from '@platform/db/schema';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../lib/errors.js';
import { resolveLeadWriteScope, effectiveInOrgActor } from '../../../lib/lead-write-scope.js';

type Tx = Parameters<Parameters<typeof withRoleTx>[1]>[0];

/**
 * Opens a pending follow-up on a lead: moves the marketing_leads.scheduled_at
 * pointer and appends the lead_follow_ups history row, both inside the caller's
 * transaction.
 *
 * Shared rather than inlined because PATCH /leads/:id now schedules a follow-up
 * as part of a stage move (so the two commit together — a stage change into a
 * followup_required stage must never be able to land without its due time), and
 * completing a follow-up opens the next one. All three paths have to agree on
 * what "scheduled" means, so they call this.
 */
export async function insertFollowUpTx(
  tx: Tx,
  args: {
    orgId: string;
    leadId: string;
    assignedUserId: string;
    scheduledAt: Date;
    notes?: string | null;
    createdBy: string;
  },
) {
  const [pendingStatus] = await tx
    .select({ id: followUpStatusesTable.id })
    .from(followUpStatusesTable)
    .where(eq(followUpStatusesTable.name, 'pending'))
    .limit(1);
  if (!pendingStatus) throw new BadRequestError('Follow-up status "pending" not found');

  const [lead] = await tx
    .select({ stageId: marketingLeadsTable.stageId, outcomeId: marketingLeadsTable.outcomeId })
    .from(marketingLeadsTable)
    .where(eq(marketingLeadsTable.id, args.leadId))
    .limit(1);

  // Primary table first: marketing_leads.scheduled_at is the source of truth for
  // "when is this lead's next follow-up due" (drives overdue/upcoming everywhere).
  await tx
    .update(marketingLeadsTable)
    .set({ scheduledAt: args.scheduledAt })
    .where(and(eq(marketingLeadsTable.id, args.leadId), eq(marketingLeadsTable.orgId, args.orgId)));

  // lead_follow_ups is append-only: every follow-up action is a new row, never an UPDATE.
  const [inserted] = await tx
    .insert(leadFollowUpsTable)
    .values({
      orgId: args.orgId,
      leadId: args.leadId,
      assignedUserId: args.assignedUserId,
      statusId: pendingStatus.id,
      stageId: lead?.stageId ?? null,
      outcomeId: lead?.outcomeId ?? null,
      scheduledAt: args.scheduledAt,
      notes: args.notes ?? null,
      createdBy: args.createdBy,
    })
    .returning({ id: leadFollowUpsTable.id });

  return inserted!;
}

export async function createFollowUp(
  ctx: RoleTxContext,
  leadId: string,
  data: { assigned_user_id?: string; scheduled_at: string; notes?: string },
) {
  return withRoleTx(ctx, async (tx) => {
    // Scope to the lead's REAL org (not the caller's home org). Invisible/cross-org
    // lead → null → clean 404; a platform super_admin's write lands in the lead's
    // org instead of raising the FK-org-scope trigger as a 500. See Issues #3/#4.
    const scope = await resolveLeadWriteScope(tx, leadId);
    if (!scope) throw new NotFoundError('Lead not found');
    const leadOrgId = scope.orgId;

    if (data.assigned_user_id !== undefined && data.assigned_user_id !== ctx.user_id) {
      const rows = (await tx.execute(sql`
        SELECT iam.can_assign_to(${leadOrgId}::uuid, ${ctx.user_id}::uuid, ${data.assigned_user_id}::uuid) AS allowed
      `)) as Array<{ allowed: boolean }>;
      if (!rows[0]?.allowed) {
        throw new ForbiddenError('Insufficient hierarchy authority to assign this follow-up');
      }
    }

    // The follow-up assignee must map to the lead's org (DB trigger). Default to the
    // actor when they belong to that org, else the lead's current assignee — lets a
    // cross-org super_admin schedule a follow-up for the rep who owns the lead.
    const assignedUserId = data.assigned_user_id ?? await effectiveInOrgActor(tx, ctx.user_id, scope);

    return insertFollowUpTx(tx, {
      orgId: leadOrgId,
      leadId,
      assignedUserId,
      scheduledAt: new Date(data.scheduled_at),
      notes: data.notes ?? null,
      createdBy: ctx.user_id,
    });
  });
}

export async function updateFollowUp(
  ctx: RoleTxContext,
  followUpId: string,
  data: {
    status_name?: string;
    completed_at?: string;
    scheduled_at?: string;
    notes?: string;
    next_scheduled_at?: string;
  },
) {
  return withRoleTx(ctx, async (tx) => {
    // Resolve the follow-up under the caller's RLS visibility WITHOUT pinning
    // ctx.org_id: a cross-org platform/tenant admin's home org differs from the
    // follow-up's org, so an org_id = ctx.org_id filter would silently miss the
    // row (a wrong 204/no-op). RLS still scopes app_user actors to their active
    // org; the follow-up's own org drives every write below. See Issue #3.
    const [prev] = await tx
      .select()
      .from(leadFollowUpsTable)
      .where(and(
        eq(leadFollowUpsTable.id, followUpId),
        eq(leadFollowUpsTable.isDeleted, false),
      ))
      .limit(1);
    if (!prev) return null;
    const followUpOrgId = prev.orgId;

    let statusId = prev.statusId;
    let isCompleted: boolean;
    if (data.status_name !== undefined) {
      const [status] = await tx
        .select({ id: followUpStatusesTable.id })
        .from(followUpStatusesTable)
        .where(eq(followUpStatusesTable.name, data.status_name))
        .limit(1);
      if (!status) throw new BadRequestError(`Invalid follow-up status: ${data.status_name}`);
      statusId = status.id;
      isCompleted = data.status_name === 'completed';
    } else {
      const [prevStatus] = await tx
        .select({ name: followUpStatusesTable.name })
        .from(followUpStatusesTable)
        .where(eq(followUpStatusesTable.id, prev.statusId))
        .limit(1);
      isCompleted = prevStatus?.name === 'completed';
    }

    const [lead] = await tx
      .select({ stageId: marketingLeadsTable.stageId, outcomeId: marketingLeadsTable.outcomeId })
      .from(marketingLeadsTable)
      .where(eq(marketingLeadsTable.id, prev.leadId))
      .limit(1);

    const scheduledAt = data.scheduled_at !== undefined ? new Date(data.scheduled_at) : prev.scheduledAt;
    const completedAt = data.status_name !== undefined
      ? (data.completed_at !== undefined ? new Date(data.completed_at) : null)
      : prev.completedAt;

    // Primary table first: keep marketing_leads.scheduled_at as the "current" pointer —
    // null once completed (no open follow-up), otherwise the (possibly rescheduled) due time.
    await tx
      .update(marketingLeadsTable)
      .set({ scheduledAt: isCompleted ? null : scheduledAt })
      .where(and(eq(marketingLeadsTable.id, prev.leadId), eq(marketingLeadsTable.orgId, followUpOrgId)));

    // lead_follow_ups is append-only: insert a new row for this action, never mutate prev.
    const [inserted] = await tx
      .insert(leadFollowUpsTable)
      .values({
        orgId: followUpOrgId,
        leadId: prev.leadId,
        assignedUserId: prev.assignedUserId,
        statusId,
        stageId: lead?.stageId ?? prev.stageId,
        outcomeId: lead?.outcomeId ?? prev.outcomeId,
        scheduledAt,
        completedAt,
        notes: data.notes !== undefined ? data.notes : prev.notes,
        createdBy: ctx.user_id,
      })
      .returning({ id: leadFollowUpsTable.id });

    // Completing the last open follow-up leaves scheduled_at NULL. If the lead is
    // still parked in a stage whose lead_stage.followup_required is set, that drops
    // it out of the notifications-service poller (which requires scheduled_at IS NOT
    // NULL) and out of every overdue count — the lead goes dark with nobody chasing
    // it. So the next due time has to be captured in the same request.
    if (isCompleted) {
      if (data.next_scheduled_at !== undefined) {
        await insertFollowUpTx(tx, {
          orgId: followUpOrgId,
          leadId: prev.leadId,
          assignedUserId: prev.assignedUserId,
          scheduledAt: new Date(data.next_scheduled_at),
          notes: data.notes ?? null,
          createdBy: ctx.user_id,
        });
      } else if (await stageRequiresFollowUp(tx, lead?.stageId ?? prev.stageId)) {
        throw new BadRequestError(
          'This lead is still in a stage that requires follow-up — schedule the next one before completing this.',
        );
      }
    }

    return inserted ?? null;
  });
}

/** Whether a stage carries lead_stage.followup_required. NULL stage → false. */
async function stageRequiresFollowUp(tx: Tx, stageId: string | null): Promise<boolean> {
  if (!stageId) return false;
  const rows = (await tx.execute(sql`
    SELECT followup_required FROM lms.lead_stage WHERE id = ${stageId}::uuid
  `)) as unknown as Array<{ followup_required: boolean | null }>;
  return Boolean(rows[0]?.followup_required);
}

export async function deleteFollowUp(ctx: RoleTxContext, followUpId: string) {
  return withRoleTx(ctx, async (tx) => {
    // Scope by id only and let RLS bound which rows are visible/writable: an
    // `org_id = ctx.org_id` filter would silently skip a cross-org platform/tenant
    // admin's target (their home org ≠ the follow-up's org). app_user actors are
    // still confined to their active org by the org_isolation policy. See Issue #3.
    const deleted = (await tx.execute(sql`
      UPDATE lms.lead_follow_ups
      SET is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = ${ctx.user_id}::uuid
      WHERE id = ${followUpId} AND NOT is_deleted
      RETURNING lead_id::text AS lead_id, org_id::text AS org_id
    `)) as unknown as Array<{ lead_id: string; org_id: string }>;

    const row = deleted[0];
    if (!row) return;

    // marketing_leads.scheduled_at may have been pointing at the row we just
    // deleted, which would leave the lead flagged as due against a follow-up that
    // no longer exists. Re-derive the pointer from whatever pending follow-up
    // actually survives (NULL when none does).
    await tx.execute(sql`
      UPDATE lms.marketing_leads ml
      SET scheduled_at = (
        SELECT lf.scheduled_at
        FROM lms.lead_follow_ups lf
        JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
        WHERE lf.lead_id = ml.id AND NOT lf.is_deleted AND fs.name = 'pending'
        ORDER BY lf.scheduled_at DESC
        LIMIT 1
      )
      WHERE ml.id = ${row.lead_id}::uuid AND ml.org_id = ${row.org_id}::uuid
    `);
  });
}
