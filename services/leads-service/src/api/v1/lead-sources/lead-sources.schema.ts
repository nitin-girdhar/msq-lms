import { z } from 'zod';

export const createLeadSourceSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  label: z.string().min(1).max(200).trim(),
});

export const updateLeadSourceSchema = createLeadSourceSchema.partial().extend({
  is_active: z.boolean().optional(),
});

// tenant_id is routing/scoping context (which tenant's catalog a super_admin is
// editing), not a stored field on the entity — carried as a query param.
export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});
export type TenantScopedQuery = z.infer<typeof tenantScopedQuerySchema>;


export type CreateLeadSourceInput = z.infer<typeof createLeadSourceSchema>;
export type UpdateLeadSourceInput = z.infer<typeof updateLeadSourceSchema>;
