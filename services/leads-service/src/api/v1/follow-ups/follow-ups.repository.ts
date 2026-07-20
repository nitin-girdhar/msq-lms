import { sql, eq, and } from 'drizzle-orm';
import { withRoleTx } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { leadFollowUpsTable, followUpStatusesTable, marketingLeadsTable } from '@platform/db/schema';
import { BadRequestError, ForbiddenError } from '../../../lib/errors.js';

export async function createFollowUp(
  ctx: RoleTxContext,
  leadId: string,
  data: { assigned_user_id?: string; scheduled_at: string; notes?: string },
) {
  return withRoleTx(ctx, async (tx) => {
    if (data.assigned_user_id !== undefined && data.assigned_user_id !== ctx.user_id) {
      const rows = (await tx.execute(sql`
        SELECT iam.can_assign_to(${ctx.org_id}::uuid, ${ctx.user_id}::uuid, ${data.assigned_user_id}::uuid) AS allowed
      `)) as Array<{ allowed: boolean }>;
      if (!rows[0]?.allowed) {
        throw new ForbiddenError('Insufficient hierarchy authority to assign this follow-up');
      }
    }

    const [pendingStatus] = await tx
      .select({ id: followUpStatusesTable.id })
      .from(followUpStatusesTable)
      .where(eq(followUpStatusesTable.name, 'pending'))
      .limit(1);
    if (!pendingStatus) throw new BadRequestError('Follow-up status "pending" not found');

    const [lead] = await tx
      .select({ stageId: marketingLeadsTable.stageId, outcomeId: marketingLeadsTable.outcomeId })
      .from(marketingLeadsTable)
      .where(eq(marketingLeadsTable.id, leadId))
      .limit(1);

    const scheduledAt = new Date(data.scheduled_at);

    // Primary table first: marketing_leads.scheduled_at is the source of truth for
    // "when is this lead's next follow-up due" (drives overdue/upcoming everywhere).
    await tx
      .update(marketingLeadsTable)
      .set({ scheduledAt })
      .where(and(eq(marketingLeadsTable.id, leadId), eq(marketingLeadsTable.orgId, ctx.org_id)));

    // lead_follow_ups is append-only: every follow-up action is a new row, never an UPDATE.
    const [inserted] = await tx
      .insert(leadFollowUpsTable)
      .values({
        orgId: ctx.org_id,
        leadId,
        assignedUserId: data.assigned_user_id ?? ctx.user_id,
        statusId: pendingStatus.id,
        stageId: lead?.stageId ?? null,
        outcomeId: lead?.outcomeId ?? null,
        scheduledAt,
        notes: data.notes ?? null,
        createdBy: ctx.user_id,
      })
      .returning({ id: leadFollowUpsTable.id });

    return inserted!;
  });
}

export async function updateFollowUp(
  ctx: RoleTxContext,
  followUpId: string,
  data: { status_name?: string; completed_at?: string; scheduled_at?: string; notes?: string },
) {
  return withRoleTx(ctx, async (tx) => {
    const [prev] = await tx
      .select()
      .from(leadFollowUpsTable)
      .where(and(
        eq(leadFollowUpsTable.id, followUpId),
        eq(leadFollowUpsTable.orgId, ctx.org_id),
        eq(leadFollowUpsTable.isDeleted, false),
      ))
      .limit(1);
    if (!prev) return null;

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
      .where(and(eq(marketingLeadsTable.id, prev.leadId), eq(marketingLeadsTable.orgId, ctx.org_id)));

    // lead_follow_ups is append-only: insert a new row for this action, never mutate prev.
    const [inserted] = await tx
      .insert(leadFollowUpsTable)
      .values({
        orgId: ctx.org_id,
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

    return inserted ?? null;
  });
}

export async function deleteFollowUp(ctx: RoleTxContext, followUpId: string) {
  return withRoleTx(ctx, async (tx) => {
    await tx.execute(sql`
      UPDATE lms.lead_follow_ups
      SET is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = ${ctx.user_id}::uuid
      WHERE id = ${followUpId} AND org_id = ${ctx.org_id}
    `);
  });
}
