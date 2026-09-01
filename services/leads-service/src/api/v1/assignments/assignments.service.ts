import { randomUUID } from 'node:crypto';
import type { RoleTxContext } from '@platform/db';
import type { CapabilityHolder } from '@platform/rbac';
import type { CreateAssignmentInput, UpdateAssignmentInput, BulkAssignInput } from '@lms/validation';
import {
  LMS_RANKS,
  canAssignToUser,
  getRulesForTenant,
  getLeadsHistoryAssignedToScope,
  canViewUnassignedLeads,
  UNASSIGNED_ASSIGNEE,
} from '@lms/authz';
import type { LeadsHistoryFilters, UnassignedMode, LeadsHistorySortKey, SortDirection } from './assignments.repository.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../../../lib/errors.js';
import { logActivity } from '@platform/audit-log';
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

/**
 * The transaction context an assignment write in `orgId` must run under, plus
 * the assertion that the actor may write there at all.
 *
 * RLS pins app_user to the branch the actor is switched INTO, but an actor
 * mapped to several branches manages all of them — Bulk Assign and the
 * Assignments grid both let them pick another one. Every statement of the write
 * therefore has to run with the reach their mappings prove, or the reads return
 * nothing and the UPDATE matches nothing. Elevating only for tenant_admin-shaped
 * roles (which is what this used to do) left exactly the multi-branch org and
 * senior-org roles broken.
 *
 * Coverage — the actor's own active iam.user_org_mapping rows, the same rows the
 * branch picker is built from — is what bounds the elevated context. It is
 * checked BEFORE any write, so an org the actor does not cover is a 403 rather
 * than a silent no-op, and a forged org id reaches nothing. Tenancy is still
 * asserted in SQL, and iam.can_assign_to / fn_actor_can_act_in_org remain the
 * database's own last word on the write.
 */
async function writeCtxForOrg(ctx: RoleTxContext, orgId: string): Promise<RoleTxContext> {
  if (orgId === ctx.org_id) return ctx;
  const covered = await repo.getCoveredOrgIds(ctx);
  if (!covered.includes(orgId)) {
    throw new ForbiddenError('You cannot assign leads in that branch');
  }
  return { ...ctx, tenantWide: true };
}

export async function createAssignment(ctx: RoleTxContext, actor: CapabilityHolder, actorRank: number, data: CreateAssignmentInput) {
  // The lead's branch, not ctx.org_id: it decides both who is assignable (the
  // picker asks the same question of /users/assignable) and which rank the
  // target holds for the authority check below.
  const leadOrgId = await repo.getLeadOrgId(ctx, data.lead_id);
  if (!leadOrgId) throw new NotFoundError('Lead not found');
  const txCtx = await writeCtxForOrg(ctx, leadOrgId);

  const targetUser = await repo.getUserForAssignment(txCtx, data.assigned_to, leadOrgId);
  if (!targetUser || !targetUser['is_active']) {
    throw new BadRequestError('Target user is not an active member of the branch this lead belongs to');
  }

  const targetRank = Number(targetUser['rank'] ?? 0);
  if (!canAssignToUser(actor, actorRank, targetRank, ctx.user_id, String(targetUser['id']))) {
    const reason = targetRank >= LMS_RANKS.ADMIN
      ? 'Admin iam.users cannot be lead assignees'
      : ctx.user_id === String(targetUser['id'])
        ? 'You cannot assign a lead to yourself'
        : 'You cannot assign leads to a user with that role';

    await logActivity({
      action_type: 'privilege_denied_attempt',
      performed_by: ctx.user_id,
      lead_id: data.lead_id,
      org_id: leadOrgId,
      new_value: { reason, target_id: targetUser['id'], target_role: targetUser['role_name'] },
    });

    throw new ForbiddenError(reason);
  }

  try {
    const result = await repo.assignLead(txCtx, { lead_id: data.lead_id, assigned_to: data.assigned_to });

    await logActivity({
      action_type: 'assignment_created',
      performed_by: ctx.user_id,
      lead_id: data.lead_id,
      org_id: leadOrgId,
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

export async function reassignLead(ctx: RoleTxContext, actor: CapabilityHolder, actorRank: number, leadId: string, data: UpdateAssignmentInput) {
  const leadOrgId = await repo.getLeadOrgId(ctx, leadId);
  if (!leadOrgId) throw new NotFoundError('Assignment not found');
  const txCtx = await writeCtxForOrg(ctx, leadOrgId);

  const targetUser = await repo.getUserForAssignment(txCtx, data.assigned_to, leadOrgId);
  if (!targetUser || !targetUser['is_active']) {
    throw new BadRequestError('Target user is not an active member of the branch this lead belongs to');
  }

  const targetRank = Number(targetUser['rank'] ?? 0);
  if (!canAssignToUser(actor, actorRank, targetRank, ctx.user_id, String(targetUser['id']))) {
    throw new ForbiddenError('Insufficient permissions to assign to this user');
  }

  const { result, previous_assignee } = await repo.reassignLead(txCtx, {
    lead_id: leadId,
    assigned_to: data.assigned_to,
  });

  if (!result) throw new NotFoundError('Assignment not found');

  await logActivity({
    action_type: 'assignment_reassigned',
    performed_by: ctx.user_id,
    lead_id: leadId,
    org_id: leadOrgId,
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

export async function unassignLead(ctx: RoleTxContext, leadId: string) {
  // Same branch reach as the two assign paths: unassigning a lead in another
  // branch the actor covers is the same authority as reassigning it.
  const leadOrgId = await repo.getLeadOrgId(ctx, leadId);
  if (!leadOrgId) throw new NotFoundError('Assignment not found');
  const txCtx = await writeCtxForOrg(ctx, leadOrgId);

  const result = await repo.unassignLead(txCtx, leadId);
  if (!result) throw new NotFoundError('Assignment not found');
  await logActivity({ action_type: 'assignment_removed', performed_by: ctx.user_id, lead_id: leadId, org_id: leadOrgId });

  publishEvent('lead:updated', {
    lead_id: leadId,
    org_id: result['org_id'],
    tenant_id: ctx.tenant_id,
    assigned_user_id: null,
    actor_id: ctx.user_id,
  });
}

export async function bulkAssignLeads(ctx: RoleTxContext, actor: CapabilityHolder, actorRank: number, data: BulkAssignInput) {
  // Bulk Assign lets a multi-branch actor pick a branch and hand its leads to
  // someone in THAT branch, so every statement below — reading the leads,
  // reading the assignee, and the UPDATE — has to run under the reach the
  // actor's own branch mappings prove. Reading the leads therefore comes FIRST
  // and under an elevated read-only context: which branch the selection lives in
  // is the question everything else is checked against, and RLS would have
  // answered "no such leads" for any branch other than the one the actor is
  // switched into.
  //
  // This used to elevate only when lms.leads.view resolved to tenant/all, which
  // is not a rung the multi-branch org and senior-org roles sit on: picking any
  // other covered branch read back zero leads and failed as "One or more leads
  // were not found" — the reported Bulk Assign error.
  const readCtx: RoleTxContext = { ...ctx, tenantWide: true, readOnly: true };

  const leadIds = [...new Set(data.lead_ids)];
  const leads = await repo.getLeadsForBulkAssignment(readCtx, leadIds);
  if (leads.length !== leadIds.length) {
    throw new NotFoundError('One or more leads were not found');
  }

  const firstLead = leads[0];
  if (!firstLead) throw new BadRequestError('No leads selected');
  const leadsOrgId = firstLead.org_id;
  if (leads.some((l) => l.org_id !== leadsOrgId)) {
    throw new BadRequestError('All selected leads must belong to the same org');
  }

  // Coverage is the bound on everything the elevated read just made visible: an
  // org the actor is not mapped to is refused here, before any write.
  const txCtx = await writeCtxForOrg(ctx, leadsOrgId);

  // Scoped to the leads' branch, so a null row means "not an active member of
  // that branch" — the assignee's HOME org is no longer part of the question.
  const targetUser = await repo.getUserForAssignment(txCtx, data.assigned_to, leadsOrgId);
  if (!targetUser || !targetUser['is_active']) {
    throw new BadRequestError('The assignee must be an active member of the branch the leads live in');
  }

  const targetRank = Number(targetUser['rank'] ?? 0);
  if (!canAssignToUser(actor, actorRank, targetRank, ctx.user_id, String(targetUser['id']))) {
    throw new ForbiddenError('You cannot assign leads to this user');
  }

  const previousAssigneeByLead = new Map(leads.map((l) => [l.id, l.assigned_user_id]));
  const updated = await repo.bulkAssignLeads(txCtx, { leadIds, assignedTo: data.assigned_to });
  const batchId = randomUUID();

  await Promise.all(updated.map((row) => {
    const leadId = String(row['id']);
    const previousAssignee = previousAssigneeByLead.get(leadId) ?? null;
    return logActivity({
      action_type: previousAssignee ? 'assignment_reassigned' : 'assignment_created',
      performed_by: ctx.user_id,
      lead_id: leadId,
      org_id: leadsOrgId,
      old_value: { assigned_to: previousAssignee },
      new_value: { assigned_to: data.assigned_to, bulk: true, batch_id: batchId },
    });
  }));

  for (const row of updated) {
    publishEvent('lead:updated', {
      lead_id: String(row['id']),
      org_id: row['org_id'],
      tenant_id: ctx.tenant_id,
      assigned_user_id: data.assigned_to,
      actor_id: ctx.user_id,
    });
  }

  const updatedIds = new Set(updated.map((row) => String(row['id'])));
  const skipped = leadIds.filter((id) => !updatedIds.has(id));

  return { updated: updated.length, skipped };
}

export interface LeadsHistoryParams {
  dateFrom?: string;
  dateTo?: string;
  stageIds?: string[];
  outcomeIds?: string[];
  sourceIds?: string[];
  orgIds?: string[];
  assignedTo?: string[];
  activeOnly: boolean;
  sortBy?: LeadsHistorySortKey;
  sortDir?: SortDirection;
  page: number;
  pageSize: number;
}

/**
 * Splits the `assigned_to` filter into real user ids and the "unassigned"
 * sentinel, dropping the sentinel entirely for callers who may not see
 * unassigned leads.
 *
 * Dropping rather than rejecting is deliberate: the sentinel can only reach us
 * from a stale or hand-rolled client, and the fallback — the caller's normal
 * scoped view — leaks nothing. A 403 here would break any client that kept
 * filter state across a role change.
 */
export function parseAssignedTo(assignedTo: string[] | undefined, canSeeUnassigned: boolean) {
  const raw = assignedTo ?? [];
  return {
    userIds: raw.filter((v) => v !== UNASSIGNED_ASSIGNEE),
    unassignedRequested: canSeeUnassigned && raw.includes(UNASSIGNED_ASSIGNEE),
  };
}

export async function listLeadsHistory(
  ctx: RoleTxContext,
  rank: number,
  params: LeadsHistoryParams,
) {
  const rules = getRulesForTenant(ctx.tenant_id);
  const scope = getLeadsHistoryAssignedToScope(rules, rank, ctx.role);

  const canSeeUnassigned = canViewUnassignedLeads(rules, rank);
  const sel = parseAssignedTo(params.assignedTo, canSeeUnassigned);

  // Explicitly ticking "Unassigned" narrows to unassigned-only when no user is
  // also ticked, and unions with the ticked users when one is.
  const modeFor = (dflt: UnassignedMode): UnassignedMode =>
    sel.unassignedRequested
      ? (sel.userIds.length ? 'include' : 'only')
      : (sel.userIds.length ? 'exclude' : dflt);

  const filters: LeadsHistoryFilters = {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    stageIds: params.stageIds,
    outcomeIds: params.outcomeIds,
    sourceIds: params.sourceIds,
    activeOnly: params.activeOnly,
    sortBy: params.sortBy,
    sortDir: params.sortDir,
    page: params.page,
    pageSize: params.pageSize,
    orgIds: null,
    unassignedMode: 'exclude',
  };

  switch (scope) {
    case 'none':
      // Below the team-scope rank: sales_representative, fitness_trainer,
      // read_only. "None" scope means *your own* leads, and an unassigned lead
      // is by definition nobody's.
      //
      // 'exclude' is hardcoded rather than derived from canSeeUnassigned on
      // purpose. minRankToViewUnassignedLeads and minRankForLeadsHistoryTeamScope
      // are both SSE (40) today, so this branch is unreachable for a caller who
      // can see unassigned leads — but they are two independently tunable
      // per-tenant knobs. A tenant dropping minRankToViewUnassignedLeads to SE
      // must not thereby open unassigned rows to every rank-20 user.
      filters.userIds = [ctx.user_id];
      filters.unassignedMode = 'exclude';
      filters.orgIds = [ctx.org_id];
      break;
    // getLeadsHistoryAssignedToScope no longer returns 'team' — it was merged
    // into 'org' when 'org' came to mean "the branches I cover". Kept as a
    // fallthrough so the switch stays exhaustive over LeadsHistoryScope, whose
    // 'team' member still serves the leads-page view_scope.
    case 'team':
    case 'org': {
      filters.unassignedMode = modeFor(canSeeUnassigned ? 'include' : 'exclude');
      if (filters.unassignedMode !== 'only' && sel.userIds.length) filters.userIds = sel.userIds;
      // Every branch this actor covers, not the single one they are switched
      // into. A Wingman mapped to six branches manages six; pinning the report
      // to ctx.org_id made it useless to exactly the people running the
      // branches, and left the Assigned-To filter offering names the grid would
      // then refuse to show.
      //
      // A client-supplied org list NARROWS this and can never widen it: ids the
      // actor does not cover are dropped, so a forged org_id returns fewer rows
      // rather than another branch's leads. An empty intersection is a real
      // answer — do not fall back to full coverage.
      const covered = await repo.getCoveredOrgIds(ctx);
      filters.orgIds = params.orgIds?.length
        ? params.orgIds.filter((id) => covered.includes(id))
        : covered;
      break;
    }
    case 'tenant':
      filters.unassignedMode = modeFor(canSeeUnassigned ? 'include' : 'exclude');
      if (filters.unassignedMode !== 'only' && sel.userIds.length) filters.userIds = sel.userIds;
      filters.orgIds = params.orgIds?.length ? params.orgIds : null;
      break;
    case 'all':
      filters.unassignedMode = modeFor(canSeeUnassigned ? 'include' : 'exclude');
      if (filters.unassignedMode !== 'only' && sel.userIds.length) filters.userIds = sel.userIds;
      filters.orgIds = params.orgIds?.length ? params.orgIds : null;
      break;
  }

  const [result, options] = await Promise.all([
    repo.listAssignmentsFiltered(ctx, filters),
    repo.getStageAndOutcomeOptions(ctx),
  ]);

  return { ...result, ...options };
}
