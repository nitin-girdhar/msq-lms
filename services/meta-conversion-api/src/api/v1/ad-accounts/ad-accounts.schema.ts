import { z } from 'zod';

export const adAccountParamsSchema = z.object({
  adAccountId: z.string().regex(/^act_\d+$/, 'adAccountId must look like act_<digits>'),
});

export const updateAdAccountBodySchema = z.object({
  is_enabled: z.boolean(),
});
