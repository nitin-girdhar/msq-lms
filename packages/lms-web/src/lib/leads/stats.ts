import type { SessionUser } from '@platform/types';
import { LMS_RANKS as RANKS } from '@lms/authz';
import type { LeadView } from '../../types/leads';
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

/**
 * One entry per stat card, keyed by the card's filter id, so the cards render the
 * counts and the toolbar renders the source breakdown of whichever card is active.
 */
export function buildStatGroups(
  leads: readonly LeadView[],
  actor: SessionUser,
): Record<CardFilter, StatGroup> {
  const isSalesTier = actor.rank < RANKS.SSE;
  const byFilter: Record<CardFilter, LeadView[]> = {
    all:            [...leads],
    new:            leads.filter((l) => l.stage === 'new'),
    callAttempted:  leads.filter((l) => l.stage === 'contacting'),
    unqualified:    leads.filter((l) => l.stage === 'unqualified'),
    visitScheduled: leads.filter((l) => l.stage === 'qualified'),
    converted:      leads.filter((l) => l.stage === 'converted'),
    // Sourced from marketing_leads → lead_stage.followup_required (per lead's current stage),
    // not a separately-fetched stage-name list.
    followUp: leads.filter((l) =>
      l.followup_required && (!isSalesTier || l.assigned_user_id === actor.id),
    ),
    unassigned: leads.filter((l) => !l.assigned_user_id),
  };

  return Object.fromEntries(
    Object.entries(byFilter).map(([key, list]) => [key, { count: list.length, sources: sourceRows(list) }]),
  ) as Record<CardFilter, StatGroup>;
}
