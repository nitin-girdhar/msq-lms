import type { LeadView } from '../../types/leads';
import type { CardFilter } from '../../components/dashboard/LeadDashboardShell';

export const FILTER_STATUSES: Record<CardFilter, string[] | null> = {
  all:            null,
  new:            ['new'],
  callAttempted:  ['contacting'],
  unqualified:    ['unqualified'],
  visitScheduled: ['qualified'],
  converted:      ['converted'],
  followUpDue:     null,
  followUpOverdue: null,
  unassigned:     null,
};

export function applyLeadFilter(
  leads: readonly LeadView[],
  filter: CardFilter,
): LeadView[] {
  if (filter === 'followUpDue' || filter === 'followUpOverdue') {
    // The Due / Overdue cards render the Follow-ups pipeline, not this grid; this
    // is the lead-row equivalent (followup_required stage + a scheduled time,
    // split at now) for any caller that filters lead rows by those cards.
    const now = Date.now();
    return leads.filter((l) => {
      if (!l.followup_required || !l.scheduled_at) return false;
      const overdue = new Date(l.scheduled_at).getTime() < now;
      return filter === 'followUpOverdue' ? overdue : !overdue;
    });
  }
  if (filter === 'unassigned') {
    return leads.filter((l) => !l.assigned_user_id);
  }
  const allowed = FILTER_STATUSES[filter];
  if (!allowed) return [...leads];
  const set = new Set(allowed);
  return leads.filter((l) => set.has(l.stage ?? ''));
}
