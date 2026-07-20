import type { RoleTxContext } from '@crm/db';
import type { CreateAssignmentInput, UpdateAssignmentInput } from '@lms/validation';
import { LMS_RANKS, canAssignToUser, getRulesForTenant, getLeadsHistoryAssignedToScope } from '@lms/authz';
import type { LeadsHistoryFilters } from './assignments.repository.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../../../lib/errors.js';
import { logActivity } from '@crm/audit-log';
import { publishEvent } from '../../../events/publisher.js';
import * as repo from './assignments.repository.js';

export async function listAllAssignments(ctx: RoleTxContext, page: number, pageSize: number) {
  const MULTI_ORG_ROLES = new Set(['super_admin', 'tenant_admin']);
  const orgIds = MULTI_ORG_ROLES.has(ctx.role) ? null : [ctx.org_id];
  return repo.listAllAssignments(ctx, orgIds, page, pageSize);
}

export async function listMyAssignments(ctx: RoleTxContext, page: number, pageSize: number) {
  return repo.listMyAssignments(ctx, page, pageSize);
}

export async function getAssignmentById(ctx: RoleTxContext, id: string) {
  const assignment = await repo.getAssignmentById(ctx, id);
  if (!assignment) throw new NotFoundError('Assignment not found');
  return assignment;
}

export async function createAssignment(ctx: RoleTxContext, actorRank: number, data: CreateAssignmentInput) {
  if (actorRank < LMS_RANKS.SSE) throw new ForbiddenError('Insufficient permissions to create assignments');

  const targetUser = await repo.getUserForAssignment(ctx, data.assigned_to);
  if (!targetUser || !targetUser['is_active']) {
    throw new BadRequestError('Target user not found or inactive');
  }

  const targetRank = Number(targetUser['rank'] ?? 0);
  if (!canAssignToUser(actorRank, targetRank, ctx.user_id, String(targetUser['id']))) {
    const reason = targetRank >= LMS_RANKS.ADMIN
      ? 'Admin iam.users cannot be lead assignees'
      : ctx.user_id === String(targetUser['id'])
        ? 'You cannot assign a lead to yourself'
        : 'You cannot assign leads to a user with that role';

    await logActivity({
      action_type: 'privilege_denied_attempt',
      performed_by: ctx.user_id,
      lead_id: data.lead_id,
      org_id: ctx.org_id,
      new_value: { reason, target_id: targetUser['id'], target_role: targetUser['role_name'] },
    });

    throw new ForbiddenError(reason);
  }

  try {
    const result = await repo.assignLead(ctx, { lead_id: data.lead_id, assigned_to: data.assigned_to });

    await logActivity({
      action_type: 'assignment_created',
      performed_by: ctx.user_id,
      lead_id: data.lead_id,
      org_id: ctx.org_id,
      new_value: { assigned_to: data.assigned_to },
    });

    publishEvent('lead:updated', {
      lead_id: data.lead_id,
      org_id: result['org_id'],
      tenant_id: ctx.tenant_id,
      assigned_user_id: data.assigned_to,
      actor_id: ctx.user_id,
    });

    return result;
  } catch (err) {
    if ((err as Error & { code?: string }).code === '23505' || (err as Error).message.includes('already assigned')) {
      throw new ConflictError('This lead is already assigned. Use PATCH to reassign.');
    }
    throw err;
  }
}

export async function reassignLead(ctx: RoleTxContext, actorRank: number, leadId: string, data: UpdateAssignmentInput) {
  if (actorRank < LMS_RANKS.SSE) throw new ForbiddenError('Insufficient permissions to reassign');

  const targetUser = await repo.getUserForAssignment(ctx, data.assigned_to);
  if (!targetUser || !targetUser['is_active']) {
    throw new BadRequestError('Target user not found or inactive');
  }

  const targetRank = Number(targetUser['rank'] ?? 0);
  if (!canAssignToUser(actorRank, targetRank, ctx.user_id, String(targetUser['id']))) {
    throw new ForbiddenError('Insufficient permissions to assign to this user');
  }

  const { result, previous_assignee } = await repo.reassignLead(ctx, {
    lead_id: leadId,
    assigned_to: data.assigned_to,
  });

  if (!result) throw new NotFoundError('Assignment not found');

  await logActivity({
    action_type: 'assignment_reassigned',
    performed_by: ctx.user_id,
    lead_id: leadId,
    org_id: ctx.org_id,
    old_value: { assigned_to: previous_assignee },
    new_value: { assigned_to: data.assigned_to },
  });

  publishEvent('lead:updated', {
    lead_id: leadId,
    org_id: result['org_id'],
    tenant_id: ctx.tenant_id,
    assigned_user_id: data.assigned_to,
    actor_id: ctx.user_id,
  });
}

export async function unassignLead(ctx: RoleTxContext, actorRank: number, leadId: string) {
  if (actorRank < LMS_RANKS.ADMIN) throw new ForbiddenError('Only admins can remove assignments');
  const result = await repo.unassignLead(ctx, leadId);
  if (!result) throw new NotFoundError('Assignment not found');
  await logActivity({ action_type: 'assignment_removed', performed_by: ctx.user_id, lead_id: leadId, org_id: ctx.org_id });

  publishEvent('lead:updated', {
    lead_id: leadId,
    org_id: result['org_id'],
    tenant_id: ctx.tenant_id,
    assigned_user_id: null,
    actor_id: ctx.user_id,
  });
}

export interface LeadsHistoryParams {
  dateFrom?: string;
  dateTo?: string;
  stageIds?: string[];
  outcomeIds?: string[];
  orgIds?: string[];
  assignedTo?: string[];
  activeOnly: boolean;
  page: number;
  pageSize: number;
}

export async function listLeadsHistory(
  ctx: RoleTxContext,
  rank: number,
  params: LeadsHistoryParams,
) {
  const rules = getRulesForTenant(ctx.tenant_id);
  const scope = getLeadsHistoryAssignedToScope(rules, rank, ctx.role);

  const filters: LeadsHistoryFilters = {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    stageIds: params.stageIds,
    outcomeIds: params.outcomeIds,
    activeOnly: params.activeOnly,
    page: params.page,
    pageSize: params.pageSize,
    orgIds: null,
  };

  switch (scope) {
    case 'none':
      filters.userIds = [ctx.user_id];
      filters.orgIds = [ctx.org_id];
      break;
    case 'team': {
      if (params.assignedTo?.length) {
        filters.userIds = params.assignedTo;
      } else {
        const teamIds = await repo.getTeamMemberIds(ctx, ctx.user_id, ctx.org_id);
        filters.userIds = teamIds;
      }
      // Team scope never crosses orgs — force the actor's own org rather than
      // trusting a client-supplied org_ids param (RLS would collapse it to this
      // anyway, but don't rely on that as the only gate).
      filters.orgIds = [ctx.org_id];
      break;
    }
    case 'org':
      if (params.assignedTo?.length) filters.userIds = params.assignedTo;
      // Org scope never crosses orgs either — same reasoning as 'team'.
      filters.orgIds = [ctx.org_id];
      break;
    case 'tenant':
      if (params.assignedTo?.length) filters.userIds = params.assignedTo;
      filters.orgIds = params.orgIds?.length ? params.orgIds : null;
      break;
    case 'all':
      if (params.assignedTo?.length) filters.userIds = params.assignedTo;
      filters.orgIds = params.orgIds?.length ? params.orgIds : null;
      break;
  }

  const [result, options] = await Promise.all([
    repo.listAssignmentsFiltered(ctx, filters),
    repo.getStageAndOutcomeOptions(),
  ]);

  return { ...result, ...options };
}
