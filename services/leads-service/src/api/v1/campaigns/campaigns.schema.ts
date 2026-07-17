import { z } from 'zod';

export const createCampaignBodySchema = z.object({
  name: z.string().min(1).max(200),
  platform_name: z.string().min(1),
  status_name: z.string().default('draft'),
  budget: z.number().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
});

export const updateCampaignBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  platform_name: z.string().optional(),
  status_name: z.string().optional(),
  budget: z.number().optional().nullable(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
});

export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;
