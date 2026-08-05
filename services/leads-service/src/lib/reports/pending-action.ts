// ─────────────────────────────────────────────────────────────────────────────
// "Pending Action" — the share of a row's leads that still need attention:
// new or overdue for follow-up, as a percentage of its total. Unassigned is
// excluded here since new leads are also unassigned, and counting both would
// double-count the same leads.
//
// One shared module, used by both the email renderer (lead-report.render.ts)
// and the public webpage renderer (public-report.render.ts), so the formula
// and the four color bands can never drift apart between the two surfaces.
// ─────────────────────────────────────────────────────────────────────────────

import type { LeadReportMetrics } from './lead-report.types.js';

export interface PendingActionBand {
  label: 'Low' | 'Moderate' | 'High' | 'Critical';
  /** Background color for the cell/swatch. */
  bg: string;
  /** Text color to use against `bg`. */
  text: string;
}

// Ordered by ascending upper bound: pct < bound[i] -> BANDS[i].
// < 20% green, 20-<40% yellow, 40-<60% amber, >= 60% red.
const BANDS: ReadonlyArray<{ upperBound: number; band: PendingActionBand }> = [
  { upperBound: 20, band: { label: 'Low', bg: '#16a34a', text: '#ffffff' } },
  { upperBound: 40, band: { label: 'Moderate', bg: '#eab308', text: '#1f2937' } },
  { upperBound: 60, band: { label: 'High', bg: '#f97316', text: '#ffffff' } },
  { upperBound: Infinity, band: { label: 'Critical', bg: '#dc2626', text: '#ffffff' } },
];

/**
 * `null` for a row with zero leads — there is nothing pending to report, and a
 * literal 0% would misleadingly imply a fully "healthy" branch/assignee rather
 * than one with no data at all.
 */
export function computePendingActionPct(row: LeadReportMetrics): number | null {
  if (row.total_leads <= 0) return null;
  const pending = row.new_count + row.followup_overdue;
  return Math.round((100 * pending) / row.total_leads);
}

/** `null` in, `null` out — callers render that as an em dash, not a band. */
export function pendingActionBand(pct: number | null): PendingActionBand | null {
  if (pct === null) return null;
  const match = BANDS.find((b) => pct < b.upperBound);
  return (match ?? BANDS[BANDS.length - 1]!).band;
}

/** The four bands in display order, for rendering a legend key once per page/email. */
export const PENDING_ACTION_LEGEND: ReadonlyArray<{ range: string; band: PendingActionBand }> = [
  { range: '< 20%', band: BANDS[0]!.band },
  { range: '20% – 40%', band: BANDS[1]!.band },
  { range: '40% – 60%', band: BANDS[2]!.band },
  { range: '60%+', band: BANDS[3]!.band },
];
