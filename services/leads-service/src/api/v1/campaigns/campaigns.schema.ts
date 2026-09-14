import { z } from 'zod';

export const createCampaignBodySchema = z.object({
  name: z.string().min(1).max(200),
  platform_name: z.string().min(1),
  status_name: z.string().default('draft'),
  budget: z.number().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  // CRM campaigns only. Classifying a META campaign is NOT done here: that
  // mapping is per Meta campaign and TENANT-WIDE, so it lives in
  // meta-conversion-api, which owns ext.meta_campaigns. This endpoint edits one
  // BRANCH's campaign record.
  campaign_type_id: z.string().uuid().nullable().optional(),
});

export const updateCampaignBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  platform_name: z.string().optional(),
  status_name: z.string().optional(),
  budget: z.number().optional().nullable(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  campaign_type_id: z.string().uuid().nullable().optional(),
});

export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;
