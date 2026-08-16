import { z } from 'zod';

export const listFollowUpsQuerySchema = z.object({
  assignedRepId: z.string().uuid().optional(),
  overdueOnly: z.string().optional().transform((v: string | undefined) => v === 'true'),
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
