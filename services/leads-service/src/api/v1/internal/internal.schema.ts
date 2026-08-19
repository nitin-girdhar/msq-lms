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
