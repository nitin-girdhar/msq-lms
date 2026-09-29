import { z } from 'zod';

// The administered tenant, chosen in the lookup-admin navbar switcher and sent
// as ?tenant_id=. Required on EVERY route here, never defaulted to the caller's
// own tenant: a platform super_admin belongs to a different tenant than the one
// they are administering, so a silent fallback to ctx.tenant_id is precisely the
// bug the page-org-map API was fixed for one phase ago.
//
// Re-declared rather than imported from page-org-map.schema.ts so that removing
// or reshaping that screen cannot quietly change what this one requires.
export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});

export const mappingStatusSchema = z.enum(['unmapped', 'suggested', 'confirmed']);

export const listCampaignsQuerySchema = tenantScopedQuerySchema.extend({
  // Omitted = every campaign. The three admin grids each pass one value.
  mapping_status: mappingStatusSchema.optional(),
  // 1.51.0: only campaigns promoting this page (the grid's Page filter).
  page_id: z.string().regex(/^\d+$/).optional(),
});

// 1.51.0: optional -- see campaigns.controller.ts::syncCampaigns.
export const syncCampaignsQuerySchema = z.object({
  tenant_id: z.string().uuid().optional(),
});

/**
 * `?dry_run=true` / `?dry_run=false`, parsed HONESTLY.
 *
 * Not `z.coerce.boolean()`: that is `Boolean(value)`, and every non-empty string
 * is truthy — so the literal string "false" arrives as `true`. On this route
 * that failure is invisible in the direction that matters least (a write silently
 * becomes a preview, and the admin's Confirm appears to do nothing) but it is
 * still a lie about what the caller asked for, and the same mistake on a route
 * where true means "write" would be the other way round.
 */
const booleanQueryParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const confirmCampaignQuerySchema = tenantScopedQuerySchema.extend({
  // Defaulting to a preview would be safer still, but this route IS the Confirm
  // button and a default no-op would make it silently do nothing. The dry run is
  // opt-in from the UI's "preview impact" affordance, and the leads-service call
  // downstream always receives the flag explicitly rather than relying on ITS
  // default (which is the opposite, and deliberately so).
  dry_run: booleanQueryParam.default(false),
});

export const ruleMatchFieldSchema = z.enum(['campaign_name', 'form_name', 'adset_name', 'ad_name']);

export const confirmCampaignBodySchema = z.object({
  campaign_type_id: z.string().uuid(),
  // 1.51.0: optionally add an ORDERED RULE for the confirmed type in the same
  // action. The pattern is TYPED by the admin -- never guessed from the name the
  // way the retired learn_keyword did ('HIR_Gurugram_Trainer_Sep26' offered
  // 'gurugram'). Appended at the end of the tenant's rule list.
  add_rule: z
    .object({
      pattern: z.string().trim().min(2).max(100),
      match_field: ruleMatchFieldSchema.default('campaign_name'),
    })
    .optional(),
});

export const campaignParamsSchema = z.object({
  // A STRING of digits, not a number: Meta campaign ids run to 17 digits, past
  // Number.MAX_SAFE_INTEGER, so parsing one into a JS number corrupts its low
  // digits and would confirm the mapping on the wrong campaign.
  metaCampaignId: z.string().regex(/^\d+$/, 'metaCampaignId must be a numeric Meta campaign id'),
});

export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
export type SyncCampaignsQuery = z.infer<typeof syncCampaignsQuerySchema>;
export type ConfirmCampaignQuery = z.infer<typeof confirmCampaignQuerySchema>;
export type ConfirmCampaignBody = z.infer<typeof confirmCampaignBodySchema>;
export type CampaignParams = z.infer<typeof campaignParamsSchema>;
