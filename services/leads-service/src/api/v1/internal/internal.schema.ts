import { z } from 'zod';

export const reassignOrgLeadsSchema = z.object({
  org_id: z.string().uuid(),
  from_user_id: z.string().uuid(),
  to_user_id: z.string().uuid().nullable(),
  actor_id: z.string().uuid(),
  // Why the bulk move happened, so lead_assignment_log.note can say so instead
  // of leaving Lead History unable to tell this apart from a manual reassign.
  // Optional: an older identity-service that doesn't send it still works, and
  // falls back to a cause-neutral note.
  reason: z.enum(['branch_transfer', 'user_deactivated']).optional(),
});
export type ReassignOrgLeadsInput = z.infer<typeof reassignOrgLeadsSchema>;

export const knownContactsSchema = z.object({
  tenant_id: z.string().uuid(),
  emails: z.array(z.string()).default([]),
  phone_keys: z.array(z.string()).default([]),
});
export type KnownContactsInput = z.infer<typeof knownContactsSchema>;

// POST /internal/campaign-reclassify — called by meta-conversion-api right after
// it writes a confirmed campaign -> type mapping.
//
// meta_campaign_id is a STRING of digits, not z.number(): Meta campaign ids run
// to 17 digits, past Number.MAX_SAFE_INTEGER, so a JSON number would arrive with
// its low digits already corrupted and match the wrong campaign.
export const campaignReclassifySchema = z.object({
  meta_campaign_id: z.string().regex(/^\d+$/, 'must be a numeric Meta campaign id'),
  campaign_type_id: z.string().uuid(),
  // Defaults to a PREVIEW. A caller that forgets the flag gets the impact counts
  // rather than an unrequested fan-out across every branch.
  dry_run: z.boolean().default(true),
  // Who confirmed the mapping, when the caller knows — stamped on the
  // lead_assignment_log rows so the lead timeline attributes the move.
  actor_id: z.string().uuid().optional(),
});
export type CampaignReclassifyInput = z.infer<typeof campaignReclassifySchema>;
