import { z } from 'zod';

// tenant_id is the tenant a platform super_admin is administering from the
// lookup-admin console — routing context, the same contract as
// /lookups/lead-sources. dry_run defaults to TRUE: a caller that forgets the flag
// gets a preview, never an unrequested batch of assignments.
export const rerunQuerySchema = z.object({
  tenant_id: z.string().uuid(),
  dry_run: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

// Both filters optional; empty = every branch / every campaign type in the
// tenant. `cursor` continues a previous run past the leads it already looked at
// (opaque `<created_at>|<lead id>` from next_cursor), so "Run next batch" does not
// re-pick the same still-unassignable leads first.
export const rerunBodySchema = z
  .object({
    org_ids: z.array(z.string().uuid()).max(500).default([]),
    campaign_type_ids: z.array(z.string().uuid()).max(100).default([]),
    cursor: z.string().max(100).regex(/^[^|]+\|[0-9a-fA-F-]{36}$/).optional(),
  })
  .default({});

export type RerunQuery = z.infer<typeof rerunQuerySchema>;
export type RerunBody = z.infer<typeof rerunBodySchema>;
