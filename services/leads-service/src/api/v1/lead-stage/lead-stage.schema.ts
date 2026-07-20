import { z } from 'zod';

export const createLeadStageSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  label: z.string().min(1).max(200).trim(),
  description: z.string().trim().optional(),
  sort_order: z.number().int().default(0),
  followup_required: z.boolean().default(false),
  is_rejected: z.boolean().default(false),
  is_terminated: z.boolean().default(false),
});

export const updateLeadStageSchema = createLeadStageSchema.partial().extend({
  is_active: z.boolean().optional(),
});

// tenant_id is routing/scoping context (which tenant's catalog a super_admin is
// editing), not a stored field on the entity — carried as a query param.
export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});
export type TenantScopedQuery = z.infer<typeof tenantScopedQuerySchema>;


export type CreateLeadStageInput = z.infer<typeof createLeadStageSchema>;
export type UpdateLeadStageInput = z.infer<typeof updateLeadStageSchema>;
