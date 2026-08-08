// ─────────────────────────────────────────────────────────────────────────────
// Public daily lead report page. A real webpage (not an email), so unlike
// lead-report.render.ts this can use a <style> block and has no size budget —
// deliberately a separate renderer rather than an extension of the email one.
// ─────────────────────────────────────────────────────────────────────────────

import { escapeHtml } from './lead-report.render.js';
import { computePendingActionPct, pendingActionBand, PENDING_ACTION_LEGEND } from './pending-action.js';
import type { BranchReportRow, LeadReportMetrics, TenantReport, UserReportRow } from './lead-report.types.js';
import type { SourceBranchRow, SourceUserRow } from './source-report.types.js';

export interface CompareSnapshot {
  branches: BranchReportRow[];
  users: UserReportRow[];
}

export interface SourceCompareSnapshot {
  branches: SourceBranchRow[];
  users: SourceUserRow[];
}

export interface PublicReportOptions {
  compareDate: string | null;
  compareSnapshot: CompareSnapshot | null;
  /** The caller's API key, carried forward as a hidden field in the compare-date form. */
  key: string;
  /**
   * Lead-source segmented data. sourceBranches renders as one grid per source
   * at the top of the page; sourceUsers replaces the plain "By assignee"
   * table with a Source-first-column version. sourceCompareSnapshot is the
   * same shape read back from lms.lead_report_snapshot for opts.compareDate —
   * null when no compareDate was requested, or none was recorded yet.
   */
  sourceBranches: SourceBranchRow[];
  sourceUsers: SourceUserRow[];
  sourceCompareSnapshot: SourceCompareSnapshot | null;
}

const COLUMNS = [
  { key: 'total_leads', label: 'Total Leads' },
  { key: 'new_count', label: 'New' },
  { key: 'unassigned_count', label: 'Unassigned' },
  { key: 'followup_scheduled', label: 'FollowUp Scheduled' },
  { key: 'followup_overdue', label: 'FollowUp Overdue' },
  { key: 'converted_count', label: 'Converted' },
  { key: 'unqualified_count', label: 'Unqualified' },
] as const satisfies ReadonlyArray<{ key: keyof LeadReportMetrics; label: string }>;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Arial, sans-serif; margin: 0; padding: 16px; color: #101828; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #475467; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  h3 { font-size: 13px; margin: 16px 0 6px; color: #344054; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 8px 0 20px; font-size: 12px; color: #475467; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .table-wrap { overflow-x: auto; margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; min-width: 640px; }
  th, td { padding: 6px 10px; border: 1px solid #d0d5dd; font-size: 12px; text-align: right; white-space: nowrap; }
  th { background: #f2f4f7; font-weight: 600; }
  th:first-child, td:first-child { text-align: left; }
  tr.total td { border-top: 2px solid #333; font-weight: 600; }
  .cmp { color: #667085; font-weight: 400; }
  .band { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 600; min-width: 34px; }
  .note { color: #667085; font-size: 12px; margin: 4px 0 16px; }
  form.compare { margin: 4px 0 20px; font-size: 13px; }
  form.compare input[type="date"] { font: inherit; padding: 4px 6px; }
  form.compare button { font: inherit; padding: 4px 12px; margin-left: 6px; }
  footer { margin-top: 24px; color: #667085; font-size: 11px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0f19; color: #e5e7eb; }
    .subtitle, .note, footer, .cmp { color: #9aa4b2; }
    h3 { color: #cbd2e0; }
    th { background: #1a2233; }
    th, td { border-color: #2a3549; }
  }
`;

/** The badge markup for one row's Pending Action, or an em dash for a zero-lead row. */
function pendingBadge(row: LeadReportMetrics): string {
  const pct = computePendingActionPct(row);
  const band = pendingActionBand(pct);
  return pct === null || !band ? '—' : `<span class="band" style="background:${band.bg};color:${band.text};">${pct}%</span>`;
}

function metricCells(row: LeadReportMetrics, compareRow: LeadReportMetrics | undefined, hasCompare: boolean): string {
  const cells = COLUMNS.map((c) => {
    const value = Number(row[c.key] ?? 0);
    if (!hasCompare) return `<td>${value}</td>`;
    const compareValue = compareRow ? Number(compareRow[c.key] ?? 0) : '—';
    return `<td>${value}<br><span class="cmp">${compareValue}</span></td>`;
  }).join('');

  if (!hasCompare) return `${cells}<td>${pendingBadge(row)}</td>`;
  const comparePending = compareRow ? pendingBadge(compareRow) : '—';
  return `${cells}<td>${pendingBadge(row)}<br><span class="cmp">${comparePending}</span></td>`;
}

function branchTable(branches: BranchReportRow[], compare: BranchReportRow[] | null, hasCompare: boolean): string {
  const byOrg = new Map(compare?.filter((b) => !b.is_total).map((b) => [b.org_id, b]) ?? []);
  const compareTotal = compare?.find((b) => b.is_total);

  const rows = branches
    .filter((b) => !b.is_total)
    .map((b) => `<tr><td>${escapeHtml(b.org_name)}</td>${metricCells(b, b.org_id ? byOrg.get(b.org_id) : undefined, hasCompare)}</tr>`);

  const total = branches.find((b) => b.is_total);
  if (total) {
    rows.push(`<tr class="total"><td>${escapeHtml(total.org_name)}</td>${metricCells(total, compareTotal, hasCompare)}</tr>`);
  }

  if (rows.length === 0) return '<p class="note">No branches found.</p>';
  return `<div class="table-wrap"><table><thead>${headerRow('Branch', hasCompare)}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/**
 * "By assignee", with Source as the leading column (per product requirement —
 * always the label, never a raw source_id/name). Same branch-banded layout as
 * the plain version, just keyed by (branch, assignee, source) instead of
 * (branch, assignee), so one assignee can appear more than once per branch —
 * once per source their leads came from. Rows within a branch stay in the
 * order sourceUserQuery returned them (assignee, then source), so an
 * assignee's rows sit together instead of scattered by source, and the role
 * badge next to the name disambiguates two different users who share a
 * full_name.
 */
function sourceUserTable(users: SourceUserRow[], compare: SourceUserRow[] | null, hasCompare: boolean): string {
  if (users.length === 0) return '<p class="note">No leads assigned in any branch.</p>';

  const byKey = new Map((compare ?? []).map((u) => [`${u.org_id}:${u.assigned_user_id ?? 'unassigned'}:${u.source_id ?? 'unknown'}`, u]));

  const byBranch = new Map<string, SourceUserRow[]>();
  for (const u of users) {
    const list = byBranch.get(u.org_name);
    if (list) list.push(u);
    else byBranch.set(u.org_name, [u]);
  }

  const body: string[] = [];
  for (const [orgName, rows] of byBranch) {
    body.push(`<tr><th colspan="${COLUMNS.length + 3}" style="text-align:left;background:#e9eefb;">${escapeHtml(orgName)}</th></tr>`);
    for (const u of rows) {
      const compareRow = byKey.get(`${u.org_id}:${u.assigned_user_id ?? 'unassigned'}:${u.source_id ?? 'unknown'}`);
      const assigneeLabel = u.role_label ? `${escapeHtml(u.assignee)} <span class="cmp">(${escapeHtml(u.role_label)})</span>` : escapeHtml(u.assignee);
      body.push(`<tr><td>${escapeHtml(u.source_label)}</td><td>${assigneeLabel}</td>${metricCells(u, compareRow, hasCompare)}</tr>`);
    }
  }

  const cells = COLUMNS.map((c) => `<th>${escapeHtml(c.label)}${hasCompare ? '<br><span class="cmp">vs.</span>' : ''}</th>`).join('');
  const head = `<tr><th>Source</th><th>Assignee</th>${cells}<th>Pending Action${hasCompare ? '<br><span class="cmp">vs.</span>' : ''}</th></tr>`;
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body.join('')}</tbody></table></div>`;
}

/** One grid per lead source, each shaped like the "By branch" table, with the same compare support. */
function sourceBranchGrids(rows: SourceBranchRow[], compare: SourceBranchRow[] | null, hasCompare: boolean): string {
  const bySource = new Map<string, SourceBranchRow[]>();
  for (const r of rows) {
    const list = bySource.get(r.source_label);
    if (list) list.push(r);
    else bySource.set(r.source_label, [r]);
  }
  if (bySource.size === 0) return '';

  const compareBySource = new Map<string, SourceBranchRow[]>();
  for (const r of compare ?? []) {
    const list = compareBySource.get(r.source_label);
    if (list) list.push(r);
    else compareBySource.set(r.source_label, [r]);
  }

  return [...bySource.entries()].map(([label, sourceRows]) => {
    const compareRows = compareBySource.get(label) ?? [];
    const compareByOrg = new Map(compareRows.filter((r) => !r.is_total).map((r) => [r.org_id, r]));
    const compareTotal = compareRows.find((r) => r.is_total);

    const branchRows = sourceRows
      .filter((r) => !r.is_total)
      .map((r) => `<tr><td>${escapeHtml(r.org_name)}</td>${metricCells(r, r.org_id ? compareByOrg.get(r.org_id) : undefined, hasCompare)}</tr>`);
    const total = sourceRows.find((r) => r.is_total);
    if (total) branchRows.push(`<tr class="total"><td>${escapeHtml(total.org_name)}</td>${metricCells(total, compareTotal, hasCompare)}</tr>`);
    const body = branchRows.length ? branchRows.join('') : `<tr><td colspan="${COLUMNS.length + 2}">No branches found.</td></tr>`;
    return `<h3>${escapeHtml(label)}</h3><div class="table-wrap"><table><thead>${headerRow('Branch', hasCompare)}</thead><tbody>${body}</tbody></table></div>`;
  }).join('');
}

function headerRow(firstLabel: string, hasCompare: boolean): string {
  const cells = COLUMNS.map((c) => `<th>${escapeHtml(c.label)}${hasCompare ? '<br><span class="cmp">vs.</span>' : ''}</th>`).join('');
  return `<tr><th>${escapeHtml(firstLabel)}</th>${cells}<th>Pending Action${hasCompare ? '<br><span class="cmp">vs.</span>' : ''}</th></tr>`;
}

function legend(): string {
  const swatches = PENDING_ACTION_LEGEND.map(
    (l) => `<span><span class="swatch" style="background:${l.band.bg};"></span>${escapeHtml(l.range)} (${l.band.label})</span>`,
  ).join('');
  return `<div class="legend"><strong>Pending Action:</strong> ${swatches}</div>`;
}

// TEMP: hidden from the UI (style="display:none") per request — the ?compare=
// query param and all its rendering logic are untouched, so a URL built by
// hand still works. Remove the inline style to bring the form back.
function compareForm(report: TenantReport, opts: PublicReportOptions): string {
  return (
    `<form class="compare" method="get" style="display:none;">` +
    `<input type="hidden" name="key" value="${escapeHtml(opts.key)}">` +
    `<label>Compare with: <input type="date" name="compare" value="${escapeHtml(opts.compareDate ?? '')}" max="${escapeHtml(report.report_date)}"></label>` +
    `<button type="submit">Apply</button>` +
    `</form>`
  );
}

export function renderPublicReportHtml(report: TenantReport, opts: PublicReportOptions): string {
  const hasCompare = opts.compareDate !== null;
  // Both snapshot reads come from the same table/date, written in the same
  // job run, so in practice either both are null or neither is — checking one
  // is enough for the "no history yet" note.
  const compareMissing = hasCompare && opts.compareSnapshot === null;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Lead Report — ${escapeHtml(report.tenant_name)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Daily Lead Report</h1>
<p class="subtitle">${escapeHtml(report.tenant_name)} &middot; ${escapeHtml(report.report_date)}</p>
${compareForm(report, opts)}
${compareMissing ? `<p class="note">No snapshot recorded for ${escapeHtml(opts.compareDate ?? '')} yet.</p>` : ''}
<h2>By source</h2>
${sourceBranchGrids(opts.sourceBranches, opts.sourceCompareSnapshot?.branches ?? null, hasCompare)}
<h2>By branch</h2>
${branchTable(report.branches, opts.compareSnapshot?.branches ?? null, hasCompare)}
<h2>By assignee</h2>
${sourceUserTable(opts.sourceUsers, opts.sourceCompareSnapshot?.users ?? null, hasCompare)}
${legend()}
<footer>Counts are a live snapshot at load time.${hasCompare ? ` Second value in each cell is ${escapeHtml(opts.compareDate ?? '')}.` : ''}</footer>
</body>
</html>`;
}
