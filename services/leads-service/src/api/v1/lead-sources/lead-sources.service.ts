import { toApiRow, toApiRows } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { ConflictError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './lead-sources.repository.js';
import type { CreateLeadSourceInput, UpdateLeadSourceInput } from './lead-sources.schema.js';

export async function list(ctx: RoleTxContext) {
  return toApiRows(await repo.list(ctx));
}

export async function create(ctx: RoleTxContext, data: CreateLeadSourceInput) {
  try {
    const row = await repo.create(ctx, {
      name: data.name,
      label: data.label,
    });
    return toApiRow(row);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A lead source with this name already exists.');
    throw err;
  }
}

export async function update(ctx: RoleTxContext, id: string, data: UpdateLeadSourceInput) {
  const fields: Parameters<typeof repo.update>[2] = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.label !== undefined) fields.label = data.label;
  if (data.is_active !== undefined) fields.isActive = data.is_active;

  try {
    const row = await repo.update(ctx, id, fields);
    if (!row) throw new NotFoundError('Lead source not found');
    return toApiRow(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A lead source with this name already exists.');
    throw err;
  }
}
