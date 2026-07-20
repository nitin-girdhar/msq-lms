import { z } from 'zod';

export const createLeadStageOutcomeSchema = z.object({
  stage_id: z.string().uuid(),
  name: z.string().min(1).max(200).trim(),
  label: z.string().min(1).max(200).trim(),
  description: z.string().trim().optional(),
  requires_comment: z.boolean().default(false),
  sort_order: z.number().int().default(0),
});

export const updateLeadStageOutcomeSchema = createLeadStageOutcomeSchema.partial().extend({
  is_active: z.boolean().optional(),
});

// tenant_id is routing/scoping context (which tenant's catalog a super_admin is
// editing), not a stored field on the entity — carried as a query param.
export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});
export type TenantScopedQuery = z.infer<typeof tenantScopedQuerySchema>;


export type CreateLeadStageOutcomeInput = z.infer<typeof createLeadStageOutcomeSchema>;
export type UpdateLeadStageOutcomeInput = z.infer<typeof updateLeadStageOutcomeSchema>;
