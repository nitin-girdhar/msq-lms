import { z } from 'zod';

// The administered tenant, chosen in the lookup-admin navbar switcher and sent
// as ?tenant_id= on EVERY route here — the same shape the page-org-map and
// campaigns APIs use. Required, never defaulted to the caller's own tenant: a
// platform super_admin belongs to a different tenant than the one they are
// administering, so a silent fallback to ctx.tenant_id is precisely the bug the
// page-org-map API was fixed for two phases ago.
//
// Re-declared rather than imported from page-org-map.schema.ts so that removing
// or reshaping that screen cannot quietly change what this one requires.
export const tenantScopedQuerySchema = z.object({
  tenant_id: z.string().uuid(),
});

/**
 * A Meta object id: a STRING of digits, never a number. Page, form and campaign
 * ids run to 17 digits, past Number.MAX_SAFE_INTEGER, so parsing one into a JS
 * number corrupts its low digits — and here that would silently pull the wrong
 * page or filter on the wrong campaign.
 */
const metaObjectId = z.string().regex(/^\d+$/, 'must be a numeric Meta object id');

/** CSV of Meta ids in a query string, e.g. `?page_ids=123,456`. */
const metaObjectIdCsv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
  .pipe(z.array(metaObjectId).max(100));

export const listPullCampaignsQuerySchema = tenantScopedQuerySchema.extend({
  // Narrows the picker to campaigns already OBSERVED on these pages. It cannot
  // narrow the pull itself — see the note on campaign_ids below.
  page_ids: metaObjectIdCsv,
});

/**
 * An ISO-8601 date ("2026-07-28") or full timestamp, normalised to an instant.
 *
 * A bare date means 00:00 UTC on that day, matching the Python's
 * parse_since_arg. Rejecting anything Date cannot parse here means a typo is a
 * 422 naming the field rather than an `Invalid Date` that silently becomes
 * NaN and pulls either everything or nothing.
 */
const isoInstant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)), {
    message: 'must be an ISO-8601 date (2026-07-28) or timestamp',
  })
  .transform((v) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v).toISOString());

/**
 * THE SCOPE CONTRACT. Three of these default to "all", so each says so
 * explicitly rather than leaving a reader to infer it from an empty array.
 */
export const createRunBodySchema = z
  .object({
    /** Empty = every org in the tenant. */
    org_ids: z.array(z.string().uuid()).max(200).default([]),
    /** Empty = every page mapped to those orgs. Applied SERVER-SIDE, from ext.meta_page_form_org_map. */
    page_ids: z.array(metaObjectId).max(100).default([]),
    /**
     * Empty = every campaign, and selecting some CANNOT make the pull cheaper.
     *
     * There is no campaign-scoped lead edge in the Graph API: leads come
     * page → /{page-id}/leadgen_forms → /{form-id}/leads, and campaign_id is
     * only a FIELD on each lead. So this filter is applied POST-FETCH, after
     * every lead has already been paid for. The run reports that back so the
     * screen can say it out loud.
     */
    campaign_ids: z.array(metaObjectId).max(200).default([]),
    /**
     * REQUIRED, even though download_page_leads.py defaults it.
     *
     * An unbounded pull across every page of a large tenant is exactly the
     * operation that will hit Meta throttling from a button press, and the
     * person pressing it has no way to know that in advance. Applied
     * post-fetch, because Meta ignores the `time_created` filter it is also
     * sent as.
     */
    since: isoInstant,
    /** Optional upper bound; omitted = now. Also applied post-fetch. */
    until: isoInstant.nullable().optional(),
    /**
     * 1.51.0. 'pages' (default): walk every form of the pages in scope and keep
     * the selected campaigns post-fetch. 'campaign': walk ONLY the selected
     * campaigns' ads (GET /{campaign}/ads -> /{ad}/leads) — much less Graph work
     * for one campaign, and it finds leads on forms nobody mapped. Needs
     * `ads_read` on the shared token.
     */
    mode: z.enum(['pages', 'campaign']).default('pages'),
  })
  .refine((d) => !d.until || Date.parse(d.until) > Date.parse(d.since), {
    message: '`until` must be after `since`',
    path: ['until'],
  })
  .refine((d) => d.mode !== 'campaign' || (d.campaign_ids.length >= 1 && d.campaign_ids.length <= 20), {
    message: 'campaign mode needs between 1 and 20 campaign_ids',
    path: ['campaign_ids'],
  });

// 1.51.0: which run the screen reopens — the admin's own, or the latest
// scheduled catch-up run.
export const latestRunQuerySchema = tenantScopedQuerySchema.extend({
  trigger_kind: z.enum(['manual', 'scheduled']).default('manual'),
});

export const runParamsSchema = z.object({
  runId: z.string().uuid(),
});

export const listRunLeadsQuerySchema = tenantScopedQuerySchema.extend({
  // The staged rows behind one summary number. Omitted = every row.
  verdict: z
    .enum([
      'already_synced',
      'test_lead',
      'unmapped_form',
      'missing_contact',
      'phone_duplicate',
      'email_duplicate',
      'new',
    ])
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});

export type ListPullCampaignsQuery = z.infer<typeof listPullCampaignsQuerySchema>;
export type CreateRunBody = z.infer<typeof createRunBodySchema>;
export type RunParams = z.infer<typeof runParamsSchema>;
export type ListRunLeadsQuery = z.infer<typeof listRunLeadsQuerySchema>;
