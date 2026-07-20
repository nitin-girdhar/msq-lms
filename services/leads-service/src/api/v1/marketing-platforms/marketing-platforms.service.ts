import { toApiRow, toApiRows } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import { ConflictError, NotFoundError } from '../../../lib/errors.js';
import * as repo from './marketing-platforms.repository.js';
import type { CreateMarketingPlatformInput, UpdateMarketingPlatformInput } from './marketing-platforms.schema.js';

export async function list(ctx: RoleTxContext) {
  return toApiRows(await repo.list(ctx));
}

export async function create(ctx: RoleTxContext, data: CreateMarketingPlatformInput) {
  try {
    const row = await repo.create(ctx, {
      name: data.name,
      label: data.label,
      ...(data.description !== undefined ? { description: data.description } : {}),
    });
    return toApiRow(row);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A marketing platform with this name already exists.');
    throw err;
  }
}

export async function update(ctx: RoleTxContext, id: string, data: UpdateMarketingPlatformInput) {
  const fields: Parameters<typeof repo.update>[2] = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.label !== undefined) fields.label = data.label;
  if (data.description !== undefined) fields.description = data.description;
  if (data.is_active !== undefined) fields.isActive = data.is_active;

  try {
    const row = await repo.update(ctx, id, fields);
    if (!row) throw new NotFoundError('Marketing platform not found');
    return toApiRow(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    const msg = (err as Error).message ?? '';
    if (msg.includes('unique')) throw new ConflictError('A marketing platform with this name already exists.');
    throw err;
  }
}
