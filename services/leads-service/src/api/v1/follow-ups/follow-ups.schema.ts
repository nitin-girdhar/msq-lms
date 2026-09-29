import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const csvOfUuids = z.string().max(20_000).refine(
  (s) => s.split(',').filter(Boolean).every((t) => UUID_RE.test(t)),
  { message: 'must be a comma-separated list of UUIDs' },
);

export const listFollowUpsQuerySchema = z.object({
  assignedRepId: z.string().uuid().optional(),
  overdueOnly: z.string().optional().transform((v: string | undefined) => v === 'true'),
  // Branch narrowing, same contract as GET /leads: honoured only for a
  // tenant/all lms.leads.view scope — the controller pins everyone else to
  // their session org whatever they send.
  org_ids: csvOfUuids.optional(),
  // A filter only; which campaign types are visible at all is the row
  // policy's answer (lms.fn_user_sees_campaign_type).
  campaign_type_ids: csvOfUuids.optional(),
});

export const updateFollowUpBodySchema = z.object({
  action: z.enum(['complete', 'reschedule', 'add_note']).optional(),
  status_name: z.string().optional(),
  completed_at: z.string().optional(),
  scheduledAt: z.string().optional(),
  notes: z.string().max(5000).optional(),
  // Completing a follow-up nulls marketing_leads.scheduled_at. When the lead is
  // still in a stage with lead_stage.followup_required that would drop it out of
  // the reminder poller entirely, so the next due time rides along on the same
  // request and the repository opens the next follow-up in the same transaction.
  nextScheduledAt: z.string().optional(),
});

export type ListFollowUpsQuery = z.infer<typeof listFollowUpsQuerySchema>;
export type UpdateFollowUpBody = z.infer<typeof updateFollowUpBodySchema>;
