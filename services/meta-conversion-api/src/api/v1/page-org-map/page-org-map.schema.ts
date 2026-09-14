import { z } from 'zod';

// The administered tenant, chosen in the lookup-admin navbar switcher and sent
// as ?tenant_id= — the same "advisory selector, backend enforces" shape every
// other lookup-admin screen uses. Required, never defaulted to the caller's own
// tenant: a platform super_admin belongs to a different tenant than the one they
// are administering, so a silent fallback is precisely the bug this replaces.
export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});

export const createMappingSchema = z.object({
  org_id: z.string().uuid(),
  page_id: z.string().regex(/^\d+$/, 'page_id must be a numeric Meta Page ID'),
  // Nullable and optional, matching the DB column (db_scripts/02_tables_core.sql
  // — `form_id BIGINT`, no NOT NULL). Omitting it creates the PAGE-LEVEL
  // catch-all row that routes every form on the page, which is the main thing
  // the admin screen creates and which this schema previously made impossible.
  form_id: z.string().regex(/^\d+$/, 'form_id must be a numeric Meta Form ID').nullable().optional(),
  platform: z.enum(['fb', 'ig', 'wa']),
});

export const updateMappingSchema = z.object({
  org_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

export const mappingParamsSchema = z.object({
  mappingId: z.string().uuid(),
});

export type TenantScopedQuery = z.infer<typeof tenantScopedQuerySchema>;
export type CreateMappingInput = z.infer<typeof createMappingSchema>;
export type UpdateMappingInput = z.infer<typeof updateMappingSchema>;
export type MappingParams = z.infer<typeof mappingParamsSchema>;
