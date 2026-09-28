import type { LeadView } from '../../types/leads';
import type { FollowUpItem } from './followup-format';
import type { CardFilter } from '../../components/dashboard/LeadDashboardShell';
import { hashSourceColor } from '../../components/leads/SourceBadge';

export interface SourceRow {
  label: string;
  count: number;
  dot: string;
}

export interface StatGroup {
  count: number;
  sources: SourceRow[];
}

export function sourceRows(list: readonly LeadView[]): SourceRow[] {
  const counts = new Map<string, number>();
  for (const lead of list) {
    const key = lead.source_label ?? lead.source ?? 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count, dot: hashSourceColor(label).dot }))
    .sort((a, b) => b.count - a.count);
}

/** The follow-up pipeline split the Due / Overdue cards count. */
export interface FollowUpSplit {
  upcoming: readonly FollowUpItem[];
  missed: readonly FollowUpItem[];
}

// A follow-up card's COUNT is the pipeline list itself — the exact rows the
// embedded Follow-ups section renders when the card is clicked. Its source
// breakdown comes from the matching lead rows (pipeline items carry no source).
function followUpGroup(leads: readonly LeadView[], items: readonly FollowUpItem[]): StatGroup {
  const ids = new Set(items.map((f) => f.leadId));
  return { count: items.length, sources: sourceRows(leads.filter((l) => ids.has(l.lead_id))) };
}

/**
 * One entry per stat card, keyed by the card's filter id, so the cards render the
 * counts and the toolbar renders the source breakdown of whichever card is active.
 */
export function buildStatGroups(
  leads: readonly LeadView[],
  followUps: FollowUpSplit,
): Record<CardFilter, StatGroup> {
  const byFilter: Record<Exclude<CardFilter, 'followUpDue' | 'followUpOverdue'>, LeadView[]> = {
    all:            [...leads],
    new:            leads.filter((l) => l.stage === 'new'),
    callAttempted:  leads.filter((l) => l.stage === 'contacting'),
    unqualified:    leads.filter((l) => l.stage === 'unqualified'),
    visitScheduled: leads.filter((l) => l.stage === 'qualified'),
    converted:      leads.filter((l) => l.stage === 'converted'),
    unassigned: leads.filter((l) => !l.assigned_user_id),
  };

  return {
    ...(Object.fromEntries(
      Object.entries(byFilter).map(([key, list]) => [key, { count: list.length, sources: sourceRows(list) }]),
    ) as Record<keyof typeof byFilter, StatGroup>),
    followUpDue:     followUpGroup(leads, followUps.upcoming),
    followUpOverdue: followUpGroup(leads, followUps.missed),
  };
}
