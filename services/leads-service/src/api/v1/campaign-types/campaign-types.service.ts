import type { RoleTxContext } from '@platform/db';
import { logActivity } from '@platform/audit-log';
import { BadRequestError, ConflictError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './campaign-types.repository.js';
import type { CreateCampaignTypeBody, UpdateCampaignTypeBody } from './campaign-types.schema.js';

export async function listCampaignTypes(ctx: RoleTxContext) {
  return repo.listCampaignTypes(ctx);
}

export async function getCampaignTypeById(ctx: RoleTxContext, id: string) {
  const row = await repo.getCampaignTypeById(ctx, id);
  if (!row) throw new NotFoundError('Campaign type not found');
  return row;
}

export async function createCampaignType(ctx: RoleTxContext, data: CreateCampaignTypeBody) {
  const result = await repo.createCampaignType(ctx, data);
  await logActivity({
    action_type: 'campaign_type_created',
    performed_by: ctx.user_id,
    org_id: ctx.org_id,
  });
  return result;
}

/**
 * A pool that inbound Meta leads still route through cannot be switched off in
 * one click.
 *
 * Deactivating a type used to fail intake outright for every new lead on a
 * campaign still mapped to it. The live path now falls back to the form/tenant
 * default instead of failing, but that is a silent mis-route: hiring leads would
 * start landing in the sales rotation with nothing on screen saying why. So the
 * references are surfaced as a 409 naming what to re-point first.
 *
 * Deliberately NOT blocked by leads already carrying the type or by weighted
 * users: historical labels stay correct, and weights on a retired pool simply
 * stop being picked. Only what ROUTES NEW LEADS is a reason to refuse.
 */
async function assertCanDeactivate(ctx: RoleTxContext, id: string): Promise<void> {
  const usage = await repo.getCampaignTypeUsage(ctx, id);
  if (!usage) throw new NotFoundError('Campaign type not found');
  if (usage.is_default) {
    throw new BadRequestError('The default campaign type cannot be deactivated');
  }
  if (usage.meta_campaign_count > 0 || usage.form_default_count > 0) {
    throw new ConflictError(
      `This campaign type still routes inbound leads: ${usage.meta_campaign_count} Meta campaign(s) are mapped to it `
      + `and ${usage.form_default_count} page/form mapping(s) use it as their default. Re-point those first.`,
    );
  }
}

export async function updateCampaignType(ctx: RoleTxContext, id: string, data: UpdateCampaignTypeBody) {
  if (data.is_active === false) await assertCanDeactivate(ctx, id);
  const result = await repo.updateCampaignType(ctx, id, data);
  if (!result) throw new NotFoundError('Campaign type not found');
  await logActivity({
    action_type: 'campaign_type_updated',
    performed_by: ctx.user_id,
    org_id: ctx.org_id,
  });
  return result;
}

export async function deleteCampaignType(ctx: RoleTxContext, id: string) {
  const usage = await repo.getCampaignTypeUsage(ctx, id);
  if (!usage) throw new NotFoundError('Campaign type not found');

  // The catch-all pool. Every unmatched campaign, every walk-in and every
  // manually created lead resolves to it, and lms.fn_user_sees_campaign_type
  // treats it as unconditionally visible — removing it would leave a tenant with
  // no fallback and no universally readable pool at all.
  if (usage.is_default) {
    throw new BadRequestError('The default campaign type cannot be deleted');
  }

  // Refuse rather than orphan. The FKs are ON DELETE RESTRICT but this is a soft
  // delete, which they do not police; a type still carrying leads, campaigns or
  // rotation members has to be emptied first.
  if (
    usage.lead_count > 0 || usage.campaign_count > 0 || usage.weighted_user_count > 0
    || usage.meta_campaign_count > 0 || usage.form_default_count > 0
  ) {
    throw new ConflictError(
      'This campaign type is still in use. Reassign its leads and campaigns, clear its assignment weights, '
      + 'and re-point any Meta campaign mappings or page/form defaults that use it, before deleting it.',
    );
  }

  const deleted = await repo.deleteCampaignType(ctx, id);
  if (!deleted) throw new NotFoundError('Campaign type not found');

  await logActivity({
    action_type: 'campaign_type_deleted',
    performed_by: ctx.user_id,
    org_id: ctx.org_id,
  });
}
