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

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
