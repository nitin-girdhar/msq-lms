import { z } from 'zod';

export const reassignOrgLeadsSchema = z.object({
  org_id: z.string().uuid(),
  from_user_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  actor_id: z.string().uuid(),
});
export type ReassignOrgLeadsInput = z.infer<typeof reassignOrgLeadsSchema>;

export const knownContactsSchema = z.object({
  tenant_id: z.string().uuid(),
  emails: z.array(z.string()).default([]),
  phone_keys: z.array(z.string()).default([]),
});
export type KnownContactsInput = z.infer<typeof knownContactsSchema>;
