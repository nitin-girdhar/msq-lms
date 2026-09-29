import { z } from 'zod';

// Keywords are matched case-insensitively ON WORD BOUNDARIES against the Meta
// campaign name by marketing.fn_match_campaign_type(). Trimmed and de-duped
// here so a stray blank cannot become a keyword that matches nothing (or, worse,
// reads as if it should).
const matchKeywords = z
  .array(z.string().trim().min(1).max(100))
  .max(50)
  .transform((kws) => [...new Set(kws)]);

export const createCampaignTypeBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
  department_id: z.string().uuid().nullable().optional(),
  match_keywords: matchKeywords.optional(),
  // Lower wins when a campaign name matches two types.
  match_priority: z.number().int().min(0).max(10000).optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

export const updateCampaignTypeBodySchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  match_keywords: matchKeywords.optional(),
  match_priority: z.number().int().min(0).max(10000).optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
  is_active: z.boolean().optional(),
});

// `name` is deliberately absent from the update schema and `is_default` from
// both. The name is what lms.lead_assignment_weights rows, the Python sync and
// every saved report refer to a pool by; and moving is_default makes that type
// unconditionally visible to everyone (see lms.fn_user_sees_campaign_type), so
// it is a tenant-provisioning decision, not a CRUD field.

export type CreateCampaignTypeBody = z.infer<typeof createCampaignTypeBodySchema>;
export type UpdateCampaignTypeBody = z.infer<typeof updateCampaignTypeBodySchema>;

// The tenant a PLATFORM super_admin is administering from the lookup-admin
// console, which picks it in a navbar switcher and sends it on every call —
// the same ?tenant_id= contract as /lookups/lead-sources and /meta/campaigns*.
// Absent for every ordinary caller, whose tenant is their own session's.
// Presence switches the route onto the super-admin gate (campaign-types.router.ts),
// so a non-super-admin who sends it is refused rather than silently scoped.
export const campaignTypesScopeQuerySchema = z.object({
  tenant_id: z.string().uuid().optional(),
});
export type CampaignTypesScopeQuery = z.infer<typeof campaignTypesScopeQuerySchema>;
