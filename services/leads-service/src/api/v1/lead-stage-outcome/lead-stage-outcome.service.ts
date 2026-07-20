import { toApiRow, toApiRows } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { ConflictError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './lead-stage-outcome.repository.js';
import * as stageRepo from '../lead-stage/lead-stage.repository.js';
import type { CreateLeadStageOutcomeInput, UpdateLeadStageOutcomeInput } from './lead-stage-outcome.schema.js';

export async function list(ctx: RoleTxContext) {
  return toApiRows(await repo.list(ctx));
}

export async function create(ctx: RoleTxContext, data: CreateLeadStageOutcomeInput) {
  const stage = await stageRepo.getById(ctx, data.stage_id);
  if (!stage) throw new NotFoundError('Stage not found');

  try {
    const row = await repo.create(ctx, {
      stageId: data.stage_id,
      name: data.name,
      label: data.label,
      requiresComment: data.requires_comment,
      sortOrder: data.sort_order,
      ...(data.description !== undefined ? { description: data.description } : {}),
    });
    return toApiRow(row);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A lead stage outcome with this name already exists for this stage.');
    throw err;
  }
}

export async function update(ctx: RoleTxContext, id: string, data: UpdateLeadStageOutcomeInput) {
  if (data.stage_id !== undefined) {
    const stage = await stageRepo.getById(ctx, data.stage_id);
    if (!stage) throw new NotFoundError('Stage not found');
  }

  const fields: Parameters<typeof repo.update>[2] = {};
  if (data.stage_id !== undefined) fields.stageId = data.stage_id;
  if (data.name !== undefined) fields.name = data.name;
  if (data.label !== undefined) fields.label = data.label;
  if (data.description !== undefined) fields.description = data.description;
  if (data.requires_comment !== undefined) fields.requiresComment = data.requires_comment;
  if (data.sort_order !== undefined) fields.sortOrder = data.sort_order;
  if (data.is_active !== undefined) fields.isActive = data.is_active;

  try {
    const row = await repo.update(ctx, id, fields);
    if (!row) throw new NotFoundError('Lead stage outcome not found');
    return toApiRow(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A lead stage outcome with this name already exists for this stage.');
    throw err;
  }
}
