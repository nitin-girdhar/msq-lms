import { z } from 'zod';

export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});

// One row per stage the admin touched; a null capi_event_type_id means "this
// stage should fire nothing" and prunes any existing mapping row rather than
// storing a null FK — ext.lead_stage_capi_event_map.capi_event_type_id is
// NOT NULL (db_scripts/02_tables_core.sql), so "no event" is modeled as "no
// row", not as a nullable column.
export const putMappingsSchema = z.object({
  mappings: z.array(z.object({
    stage_id: z.string().uuid(),
    capi_event_type_id: z.number().int().nullable(),
  })),
});

export type TenantScopedQuery = z.infer<typeof tenantScopedQuerySchema>;
export type PutMappingsInput = z.infer<typeof putMappingsSchema>;
