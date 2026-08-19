import { z } from 'zod';

export const listLeadsQuerySchema = z.object({
  status: z.string().optional(),
  assigned_to: z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  platforms: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(5000).default(5000),
  org_ids: z.string().optional(),
  // Exclude leads in a terminal stage (converted / unqualified). Applied in SQL
  // so pagination counts the rows the caller actually gets — the Bulk Assign
  // screen used to pull 5000 rows and drop the terminal ones in the browser,
  // which silently truncated any branch past that limit before filtering.
  // NOT z.coerce.boolean(): that maps the string 'false' to true.
  active_only: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
