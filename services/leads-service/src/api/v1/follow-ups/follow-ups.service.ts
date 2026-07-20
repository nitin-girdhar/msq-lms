import type { RoleTxContext } from '@crm/db';
import type { CreateFollowUpInput } from '@lms/validation';
import { NotFoundError } from '../../../lib/errors.js';
import { logActivity } from '@crm/audit-log';
import { publishEvent } from '../../../events/publisher.js';
import * as repo from './follow-ups.repository.js';
import type { UpdateFollowUpBody } from './follow-ups.schema.js';

export async function createFollowUp(ctx: RoleTxContext, leadId: string, data: CreateFollowUpInput) {
  const result = await repo.createFollowUp(ctx, leadId, {
    ...(data.assigned_user_id !== undefined ? { assigned_user_id: data.assigned_user_id } : {}),
    scheduled_at: data.scheduled_at,
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
  });
  await logActivity({ action_type: 'follow_up_created', performed_by: ctx.user_id, lead_id: leadId, org_id: ctx.org_id });
  publishEvent('followup:created', {
    lead_id: leadId, org_id: ctx.org_id, tenant_id: ctx.tenant_id,
    assigned_user_id: data.assigned_user_id ?? ctx.user_id,
    actor_id: ctx.user_id,
  });
  return result;
}

export async function updateFollowUp(ctx: RoleTxContext, followUpId: string, leadId: string, body: UpdateFollowUpBody) {
  let status_name = body.status_name;
  let completed_at = body.completed_at;
  const scheduled_at = body.scheduledAt;

  if (body.action === 'complete')   { status_name = 'completed'; completed_at = new Date().toISOString(); }
  if (body.action === 'reschedule') { status_name = 'pending'; }
  if (body.action === 'add_note')   { status_name = undefined; }

  const result = await repo.updateFollowUp(ctx, followUpId, {
    ...(status_name !== undefined ? { status_name } : {}),
    ...(completed_at !== undefined ? { completed_at } : {}),
    ...(scheduled_at !== undefined ? { scheduled_at } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
  });

  if (!result) throw new NotFoundError('Follow-up not found');
  await logActivity({ action_type: 'follow_up_updated', performed_by: ctx.user_id, lead_id: leadId, org_id: ctx.org_id });
  return result;
}

export async function deleteFollowUp(ctx: RoleTxContext, followUpId: string, leadId: string) {
  await repo.deleteFollowUp(ctx, followUpId);
  await logActivity({ action_type: 'follow_up_deleted', performed_by: ctx.user_id, lead_id: leadId, org_id: ctx.org_id });
}
