import type { RoleTxContext } from '@platform/db';
import * as repo from './lead-stage-capi-events.repository.js';
import type { PutMappingsInput } from './lead-stage-capi-events.schema.js';

export async function list(ctx: RoleTxContext) {
  const rows = await repo.listWithStages(ctx);
  return rows.map((r) => ({
    stage_id: r.stageId,
    stage_name: r.stageName,
    stage_label: r.stageLabel,
    capi_event_type_id: r.capiEventTypeId,
  }));
}

// Idempotent upsert-and-prune: every mapping in the payload is applied in its
// own statement rather than one bulk write, since a null capi_event_type_id
// and a non-null one take different SQL shapes (delete vs. upsert) — see
// the schema's note on why "no event" has no row rather than a null FK.
export async function putMappings(ctx: RoleTxContext, data: PutMappingsInput) {
  for (const m of data.mappings) {
    if (m.capi_event_type_id === null) {
      await repo.remove(ctx, m.stage_id);
    } else {
      await repo.upsert(ctx, m.stage_id, m.capi_event_type_id);
    }
  }
  return list(ctx);
}
