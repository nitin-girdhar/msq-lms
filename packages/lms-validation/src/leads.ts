import { z } from 'zod';

export const createLeadSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  middle_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number').optional(),
  email: z.string().email('Invalid email address').optional(),
  city: z.string().max(100).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  pincode: z.string().regex(/^\d{4,10}$/, 'Invalid pincode').optional(),
  // Target org for the lead. Optional — defaults to the actor's own org.
  // The DB enforces this via RLS WITH CHECK: app_user is pinned to its own org_id;
  // tenant_admin may target any org within its tenant. Never trusted blindly.
  org_id: z.string().uuid('Invalid org_id').optional(),
  source_id: z.string().uuid('Invalid source_id').optional(),
  campaign_id: z.string().uuid('Invalid campaign_id').optional(),
  stage_id: z.string().uuid('Invalid stage_id').optional(),
  assigned_user_id: z.string().uuid('Invalid assigned_user_id').optional(),
  city_id: z.number().int().positive().optional(),
  state_id: z.number().int().positive().optional(),
  country_id: z.number().int().positive().optional(),
  raw_webhook_data: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  source_lead_id: z.string().uuid().optional(),
}).refine(
  (d) => Boolean(d.phone ?? d.email),
  { message: 'At least one of phone or email is required' },
);

export const transferLeadSchema = z.object({
  target_org_id: z.string().uuid('Invalid target_org_id'),
  notes: z.string().max(1000).optional(),
});

export type TransferLeadInput = z.infer<typeof transferLeadSchema>;

export const updateLeadSchema = z.object({
  stage_id: z.string().uuid('Invalid stage_id').optional(),
  outcome_id: z.string().uuid('Invalid outcome_id').optional(),
  outcome_comment: z.string().max(2000).optional(),
  transition_note: z.string().max(1000).optional(),
  assigned_user_id: z.string().uuid('Invalid assigned_user_id').optional().nullable(),
  first_name: z.string().min(1).max(100).optional(),
  middle_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional(),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/).optional(),
  email: z.string().email().optional(),
  city: z.string().max(100).optional(),
  city_id: z.number().int().positive().optional().nullable(),
  state_id: z.number().int().positive().optional().nullable(),
  country_id: z.number().int().positive().optional().nullable(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional().nullable(),
  pincode: z.string().regex(/^\d{4,10}$/).optional(),
  source_id: z.string().uuid().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
  note: z.string().max(5000).optional(),
  // Optimistic concurrency token: the updated_at the client last read. When
  // present the UPDATE is guarded on it and a mismatch is a 409, so two people
  // editing the same lead no longer silently overwrite each other. Optional so
  // server-to-server callers that legitimately want last-writer-wins are
  // unaffected; the UI always sends it.
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided to update' },
);

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const createInteractionSchema = z.object({
  interaction_type: z.string().min(1).max(50).optional(),
  notes: z.string().max(5000).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
}).refine(
  (d) => Boolean(d.interaction_type ?? d.notes),
  { message: 'At least one of interaction_type or notes is required' },
);

export type CreateInteractionInput = z.infer<typeof createInteractionSchema>;

export const createFollowUpSchema = z.object({
  assigned_user_id: z.string().uuid('Invalid assigned_user_id').optional(),
  scheduled_at: z.string().datetime({ offset: true }),
  notes: z.string().max(5000).optional(),
});

export type CreateFollowUpInput = z.infer<typeof createFollowUpSchema>;

export const updateFollowUpSchema = z.object({
  action: z.enum(['complete', 'reschedule', 'add_note']).optional(),
  status_name: z.string().max(50).optional(),
  completed_at: z.string().datetime({ offset: true }).optional(),
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(5000).optional(),
});

export type UpdateFollowUpInput = z.infer<typeof updateFollowUpSchema>;

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  platform_name: z.string().min(1).max(100),
  status_name: z.string().max(50).optional(),
  budget: z.number().nonnegative().optional(),
  started_at: z.string().datetime({ offset: true }).optional(),
  ended_at: z.string().datetime({ offset: true }).optional(),
});

export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  platform_name: z.string().max(100).optional(),
  status_name: z.string().max(50).optional(),
  budget: z.number().nonnegative().optional(),
  started_at: z.string().datetime({ offset: true }).optional().nullable(),
  ended_at: z.string().datetime({ offset: true }).optional().nullable(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided to update' },
);

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
