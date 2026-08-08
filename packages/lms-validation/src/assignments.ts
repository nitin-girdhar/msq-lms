import { z } from 'zod';

export const createAssignmentSchema = z.object({
  lead_id: z.string().uuid(),
  assigned_to: z.string().uuid(),
  branch: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export const updateAssignmentSchema = z.object({
  assigned_to: z.string().uuid(),
  notes: z.string().max(1000).optional(),
});

export const bulkAssignSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(500),
  assigned_to: z.string().uuid(),
});

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;
