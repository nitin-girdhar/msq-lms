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
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
