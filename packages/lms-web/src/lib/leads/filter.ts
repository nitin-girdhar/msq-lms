import type { LeadView } from '../../types/leads';
import type { CardFilter } from '../../components/dashboard/LeadDashboardShell';

export const FILTER_STATUSES: Record<CardFilter, string[] | null> = {
  all:            null,
  new:            ['new'],
  callAttempted:  ['contacting'],
  unqualified:    ['unqualified'],
  visitScheduled: ['qualified'],
  converted:      ['converted'],
  followUp:       null,
  unassigned:     null,
};

export function applyLeadFilter(
  leads: readonly LeadView[],
  filter: CardFilter,
): LeadView[] {
  if (filter === 'followUp') {
    // Sourced straight from marketing_leads → lead_stage.followup_required (per-row), not a
    // separately-fetched stage-name list — the lead's own current stage is the single source.
    return leads.filter((l) => l.followup_required);
  }
  if (filter === 'unassigned') {
    return leads.filter((l) => !l.assigned_user_id);
  }
  const allowed = FILTER_STATUSES[filter];
  if (!allowed) return [...leads];
  const set = new Set(allowed);
  return leads.filter((l) => set.has(l.stage ?? ''));
}
