// ── Request validation for the report routes ──────────────────────────────────
// The spec schema itself lives in @platform/reporting so the builder UI and the
// compiler validate against exactly one definition. This file only wraps it in
// the request bodies.

import { z } from 'zod';
import { reportSpecSchema } from '@platform/reporting';

export const runQueryBodySchema = z
  .object({
    spec: reportSpecSchema,
    // Read across every org in the tenant instead of the caller's own. Gated
    // twice downstream: the actor's role must permit it AND the dataset must
    // declare a tenant column (see tenancyPredicate).
    tenantWide: z.boolean().optional(),
  })
  .strict();

export const datasetKeyParamsSchema = z
  .object({
    key: z.string().min(1).max(64),
  })
  .strict();

export type RunQueryBody = z.infer<typeof runQueryBodySchema>;
