import type { RoleTxContext } from '@platform/db';
import { logActivity } from '@platform/audit-log';
import { BadRequestError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './campaign-type-rules.repository.js';
import type { CreateRuleBody, UpdateRuleBody, TestRulesBody } from './campaign-type-rules.schema.js';

// The ordered campaign-type rules (1.51.0). A rule is what decides, for an
// unconfirmed Meta campaign, whether its leads land in the Sales or the HR pool,
// so every write is audited like a campaign-type edit.

export async function listRules(ctx: RoleTxContext) {
  return repo.listRules(ctx);
}

export async function createRule(ctx: RoleTxContext, data: CreateRuleBody) {
  const result = await repo.createRule(ctx, data);
  if (result === 'bad_type') throw new BadRequestError('Unknown or inactive campaign type for this tenant');
  await logActivity({ action_type: 'campaign_type_rule_created', performed_by: ctx.user_id, org_id: ctx.org_id });
  return result;
}

export async function updateRule(ctx: RoleTxContext, id: string, data: UpdateRuleBody) {
  const result = await repo.updateRule(ctx, id, data);
  if (result === 'bad_type') throw new BadRequestError('Unknown or inactive campaign type for this tenant');
  if (result === 'not_found') throw new NotFoundError('Rule not found');
  await logActivity({ action_type: 'campaign_type_rule_updated', performed_by: ctx.user_id, org_id: ctx.org_id });
}

export async function deleteRule(ctx: RoleTxContext, id: string) {
  if (!(await repo.deleteRule(ctx, id))) throw new NotFoundError('Rule not found');
  await logActivity({ action_type: 'campaign_type_rule_deleted', performed_by: ctx.user_id, org_id: ctx.org_id });
}

export async function reorderRules(ctx: RoleTxContext, ruleIds: string[]) {
  const result = await repo.reorderRules(ctx, ruleIds);
  if (result === 'mismatch') {
    throw new BadRequestError('rule_ids must list every live rule of this tenant exactly once; reload and try again');
  }
  await logActivity({ action_type: 'campaign_type_rules_reordered', performed_by: ctx.user_id, org_id: ctx.org_id });
}

export async function testRules(ctx: RoleTxContext, names: TestRulesBody) {
  return repo.testRules(ctx, names);
}
