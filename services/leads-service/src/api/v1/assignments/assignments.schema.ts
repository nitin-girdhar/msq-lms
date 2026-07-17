import { z } from 'zod';

export const listAssignmentsQuerySchema = z.object({
  page:        z.coerce.number().int().positive().default(1),
  page_size:   z.coerce.number().int().positive().max(5000).default(5000),
});

export const leadsHistoryQuerySchema = z.object({
  page:        z.coerce.number().int().positive().default(1),
  page_size:   z.coerce.number().int().positive().max(100).default(25),
  date_from:   z.string().optional(),
  date_to:     z.string().optional(),
  stage_ids:   z.string().optional(),
  outcome_ids: z.string().optional(),
  org_ids:     z.string().optional(),
  assigned_to: z.string().optional(),
  active_only: z.coerce.boolean().optional().default(true),
});

export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;
export type LeadsHistoryQuery = z.infer<typeof leadsHistoryQuerySchema>;
