import { toApiRow, toApiRows } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { ConflictError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './lead-stage.repository.js';
import type { CreateLeadStageInput, UpdateLeadStageInput } from './lead-stage.schema.js';

export async function list(ctx: RoleTxContext) {
  return toApiRows(await repo.list(ctx));
}

export async function create(ctx: RoleTxContext, data: CreateLeadStageInput) {
  try {
    const row = await repo.create(ctx, {
      name: data.name,
      label: data.label,
      sortOrder: data.sort_order,
      followupRequired: data.followup_required,
      isRejected: data.is_rejected,
      isTerminated: data.is_terminated,
      ...(data.description !== undefined ? { description: data.description } : {}),
    });
    return toApiRow(row);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A lead stage with this name already exists.');
    throw err;
  }
}

export async function update(ctx: RoleTxContext, id: string, data: UpdateLeadStageInput) {
  const fields: Parameters<typeof repo.update>[2] = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.label !== undefined) fields.label = data.label;
  if (data.description !== undefined) fields.description = data.description;
  if (data.sort_order !== undefined) fields.sortOrder = data.sort_order;
  if (data.followup_required !== undefined) fields.followupRequired = data.followup_required;
  if (data.is_rejected !== undefined) fields.isRejected = data.is_rejected;
  if (data.is_terminated !== undefined) fields.isTerminated = data.is_terminated;
  if (data.is_active !== undefined) fields.isActive = data.is_active;

  try {
    const row = await repo.update(ctx, id, fields);
    if (!row) throw new NotFoundError('Lead stage not found');
    return toApiRow(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A lead stage with this name already exists.');
    throw err;
  }
}
