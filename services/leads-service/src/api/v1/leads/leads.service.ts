import type { RoleTxContext } from '@crm/db';
import type { CreateLeadInput, UpdateLeadInput, CreateInteractionInput, CreateFollowUpInput } from '@lms/validation';
import { AppError, NotFoundError, ForbiddenError } from '../../../lib/errors.js';
import { logActivity } from '@crm/audit-log';
import { publishEvent } from '../../../events/publisher.js';
import { fireCapiAutoTrigger } from '../../../lib/meta-capi-trigger.js';
import * as repo from './leads.repository.js';
import type { ListLeadsFilters, ListFollowUpsFilters } from './leads.repository.js';

export async function listLeads(ctx: RoleTxContext, filters: ListLeadsFilters) {
  return repo.listLeads(ctx, filters);
}

export async function getLeadById(ctx: RoleTxContext, leadId: string) {
  const lead = await repo.getLeadById(ctx, leadId);
  if (!lead) throw new NotFoundError('Lead not found');
  return lead;
}

export async function getLeadTimeline(ctx: RoleTxContext, leadId: string) {
  return repo.getLeadTimeline(ctx, leadId);
}

export interface LeadFormDataField {
  key: string;
  label: string;
  value: string;
}

function prettifyFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Normalizes raw_webhook_data into displayable question/answer pairs. Meta lead-gen
// webhooks store `field_data: [{ name, values[] }]`; other intake sources may store a
// flat key→value object — both shapes are supported so this stays source-agnostic.
function normalizeFormFields(raw: Record<string, unknown> | null): LeadFormDataField[] {
  if (!raw) return [];

  const fieldData = raw['field_data'];
  if (Array.isArray(fieldData)) {
    return fieldData
      .filter(
        (f): f is { name: string; values: unknown[] } =>
          !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string' && Array.isArray((f as { values?: unknown }).values),
      )
      .map((f) => ({
        key: f.name,
        label: prettifyFieldKey(f.name),
        value: f.values.filter((v) => v != null && String(v).trim() !== '').map(String).join(', '),
      }))
      .filter((f) => f.value !== '');
  }

  return Object.entries(raw)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v).trim() !== '')
    .map(([k, v]) => ({ key: k, label: prettifyFieldKey(k), value: String(v) }));
}

export async function getLeadFormData(ctx: RoleTxContext, leadId: string) {
  const row = await repo.getLeadFormData(ctx, leadId);
  if (!row) throw new NotFoundError('Lead not found');
  return {
    submitted_at: row.created_at,
    fields: normalizeFormFields(row.raw_webhook_data),
  };
}

export async function getLeadInteractions(ctx: RoleTxContext, leadId: string) {
  return repo.getLeadInteractions(ctx, leadId);
}

export async function getLeadAssignmentHistory(ctx: RoleTxContext, leadId: string) {
  return repo.getLeadAssignmentHistory(ctx, leadId);
}

export async function getLeadFollowUps(ctx: RoleTxContext, leadId: string) {
  return repo.getLeadFollowUps(ctx, leadId);
}

export async function listFollowUps(ctx: RoleTxContext, filters: ListFollowUpsFilters) {
  return repo.listFollowUps(ctx, filters);
}

export async function getStageOptions() {
  return repo.getStageOptions();
}

export async function getStageOutcomes(stageId?: string) {
  return repo.getStageOutcomes(stageId);
}

export async function createLead(ctx: RoleTxContext, data: CreateLeadInput) {
  const result = await repo.createLead(ctx, data);
  await logActivity({ action_type: 'lead_created', performed_by: ctx.user_id, lead_id: result.id, org_id: ctx.org_id });
  publishEvent('lead:created', {
    lead_id: result.id, org_id: ctx.org_id, tenant_id: ctx.tenant_id,
    assigned_user_id: data.assigned_user_id ?? null,
    actor_id: ctx.user_id,
  });
  return result;
}

export async function updateLead(ctx: RoleTxContext, leadId: string, data: UpdateLeadInput) {
  try {
    const result = await repo.updateLead(ctx, leadId, data);
    if (!result) throw new NotFoundError('Lead not found');

    if (data.stage_id) {
      await logActivity({
        action_type: 'status_change',
        performed_by: ctx.user_id,
        lead_id: leadId,
        org_id: ctx.org_id,
        new_value: { stage_id: data.stage_id, outcome_id: data.outcome_id },
      });

      fireCapiAutoTrigger(leadId, ctx.org_id, data.stage_id);
    }

    publishEvent('lead:updated', {
      lead_id: leadId, org_id: ctx.org_id, tenant_id: ctx.tenant_id,
      assigned_user_id: result.assignedUserId ?? null,
      actor_id: ctx.user_id,
      changes: data,
    });

    return result;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as Error).message.includes('hierarchy authority')) throw new ForbiddenError((err as Error).message);
    throw err;
  }
}

export async function transferLead(
  ctx: RoleTxContext,
  leadId: string,
  targetOrgId: string,
  notes: string | undefined,
) {
  if (ctx.org_id === targetOrgId) {
    throw new AppError('Cannot transfer a lead to the same org', 400);
  }

  const result = await repo.transferLead(ctx, leadId, targetOrgId, notes);

  await logActivity({
    action_type: 'lead_transferred',
    performed_by: ctx.user_id,
    lead_id: leadId,
    org_id: ctx.org_id,
    new_value: { source_lead_id: result.sourceLeadId, new_lead_id: result.newLeadId, target_org_id: targetOrgId },
  });

  publishEvent('lead:updated', {
    lead_id: result.sourceLeadId,
    org_id: ctx.org_id,
    tenant_id: ctx.tenant_id,
    assigned_user_id: null,
    actor_id: ctx.user_id,
  });

  publishEvent('lead:created', {
    lead_id: result.newLeadId,
    org_id: targetOrgId,
    tenant_id: ctx.tenant_id,
    assigned_user_id: result.assignedUserId,
    actor_id: ctx.user_id,
  });

  return result;
}

export async function deleteLead(ctx: RoleTxContext, leadId: string, comment: string) {
  await repo.deleteLead(ctx, leadId, comment);
  await logActivity({ action_type: 'lead_deleted', performed_by: ctx.user_id, lead_id: leadId, org_id: ctx.org_id });
  publishEvent('lead:deleted', {
    lead_id: leadId, org_id: ctx.org_id, tenant_id: ctx.tenant_id,
    assigned_user_id: null,
    actor_id: ctx.user_id,
  });
}

export async function createInteraction(
  ctx: RoleTxContext,
  leadId: string,
  data: CreateInteractionInput,
) {
  const result = await repo.createInteraction(ctx, leadId, {
    ...(data.interaction_type !== undefined ? { interaction_type_name: data.interaction_type } : {}),
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
    ...(data.occurred_at !== undefined ? { occurred_at: data.occurred_at } : {}),
  });
  await logActivity({ action_type: 'interaction_created', performed_by: ctx.user_id, lead_id: leadId, org_id: ctx.org_id });
  return result;
}
