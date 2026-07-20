import { toApiRow, toApiRows } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import { ConflictError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './lms-roles.repository.js';
import type { CreateLmsRoleInput, UpdateLmsRoleInput } from './lms-roles.schema.js';

export async function list(ctx: RoleTxContext) {
  return toApiRows(await repo.list(ctx));
}

export async function create(ctx: RoleTxContext, data: CreateLmsRoleInput) {
  try {
    const row = await repo.create(ctx, {
      name: data.name,
      label: data.label,
      rank: data.rank,
      sortOrder: data.sort_order,
      ...(data.description !== undefined ? { description: data.description } : {}),
    });
    return toApiRow(row);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('An LMS role with this name already exists.');
    throw err;
  }
}

export async function update(ctx: RoleTxContext, id: string, data: UpdateLmsRoleInput) {
  const fields: Parameters<typeof repo.update>[2] = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.label !== undefined) fields.label = data.label;
  if (data.description !== undefined) fields.description = data.description;
  if (data.rank !== undefined) fields.rank = data.rank;
  if (data.sort_order !== undefined) fields.sortOrder = data.sort_order;
  if (data.is_active !== undefined) fields.isActive = data.is_active;

  try {
    const row = await repo.update(ctx, id, fields);
    if (!row) throw new NotFoundError('LMS role not found');
    return toApiRow(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('An LMS role with this name already exists.');
    throw err;
  }
}
