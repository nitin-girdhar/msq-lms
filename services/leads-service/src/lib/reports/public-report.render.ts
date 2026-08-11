// ─────────────────────────────────────────────────────────────────────────────
// Public daily lead report page. A real webpage (not an email), so unlike
// lead-report.render.ts this can use a <style> block and has no size budget —
// deliberately a separate renderer rather than an extension of the email one.
//
// Structure mirrors the in-app analytics page (see
// packages/lms-web/src/components/analytics/AnalyticsClient.tsx): a KPI card
// strip over one table, drilled Branch ▸ Source ▸ Assignee, instead of the three
// disjoint "By source" / "By branch" / "By assignee" grids this page used to
// carry. Three things this page has that the dashboard doesn't, all preserved:
//
//   - ?start=&end=, a lead-creation window, defaulting to month-to-date.
//   - ?compare=YYYY-MM-DD, which stacks that date's value under every number.
//     Mutually exclusive with the range — see filterBar.
//   - FollowUp Scheduled, kept in COLUMNS — the external audience reads a fuller
//     column set than the in-app table shows.
//
// Every row is present in the HTML; the inline script only *hides* descendants
// on load. With JS disabled (or in a printer, or a scraper) the page degrades to
// the fully-expanded tree rather than to three collapsed branch rows.
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
  /** The caller's API key, carried forward as a hidden field in the filter form. */
  key: string;
  /** ?branch_id= narrowing, likewise carried forward so Apply doesn't widen the scope. */
  branchId: string;
  /**
   * The active lead-creation window, or null in compare mode — the two filters
   * are mutually exclusive. Never both non-null.
   */
  range: { start: string; end: string } | null;
  /**
   * Lead-source segmented data. sourceBranches supplies the tree's middle level
   * (one row per branch × source); sourceUsers supplies the leaf level (one row
   * per branch × source × assignee, including the Unassigned bucket).
   * sourceCompareSnapshot is the same shape read back from
   * lms.lead_report_snapshot for opts.compareDate — null when no compareDate was
   * requested, or none was recorded yet.
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

const COL_COUNT = COLUMNS.length + 2; // name column + Pending Action

/** Palette lifted from AnalyticsClient's INK constants so both surfaces read as one product. */
const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    margin: 0; padding: 24px 16px 48px;
    color: #0F172A; background: #F1F5F9;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 2px; }
  .subtitle { color: #64748B; margin: 0 0 20px; font-size: 13px; }

  .card {
    background: #fff; border: 1px solid #E2E8F0; border-radius: 12px;
    box-shadow: 0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.04);
    overflow: hidden; margin-bottom: 16px;
  }
  .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid #F1F5F9;
  }
  .card-head h2 {
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: #64748B; margin: 0;
  }
  .controls { display: flex; gap: 6px; flex-shrink: 0; }
  .controls button {
    font: inherit; font-size: 11px; font-weight: 600; color: #475569;
    background: #fff; border: 1px solid #E2E8F0; border-radius: 6px;
    padding: 4px 9px; cursor: pointer;
  }
  .controls button:hover { border-color: #2a78d6; color: #2a78d6; }
  .controls button[disabled] { opacity: .4; cursor: default; border-color: #E2E8F0; color: #475569; }
  .controls button:focus-visible { outline: 2px solid #2a78d6; outline-offset: 1px; }

  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 860px; }
  thead th {
    background: #F8FAFC; color: #64748B;
    font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    padding: 8px 12px; text-align: right; white-space: nowrap;
    border-bottom: 1px solid #E2E8F0;
  }
  thead th:first-child { text-align: left; padding-left: 16px; min-width: 260px; }
  tbody td {
    padding: 7px 12px; text-align: right; white-space: nowrap;
    font-variant-numeric: tabular-nums; color: #64748B;
    border-bottom: 1px solid #F1F5F9;
  }
  tbody td:first-child { text-align: left; color: #0F172A; font-weight: 500; }
  tbody td.num-total { font-weight: 700; color: #0F172A; }

  /* Depth as indent + ground tint on one shared column grid. */
  tr[data-depth="0"] td { background: #fff; }
  tr[data-depth="1"] td { background: #F8FAFC; }
  tr[data-depth="2"] td { background: #F1F5F9; }
  tr[data-depth="0"] td:first-child { padding-left: 16px; font-weight: 600; }
  tr[data-depth="1"] td:first-child { padding-left: 40px; }
  tr[data-depth="2"] td:first-child { padding-left: 68px; font-weight: 400; }
  tr.grand td { border-top: 2px solid #CBD5E1; font-weight: 700; color: #0F172A; background: #fff; }
  tr.grand td:first-child { padding-left: 16px; }

  tr.toggle { cursor: pointer; }
  tr.toggle:hover td { filter: brightness(.975); }
  tr.toggle:focus-visible { outline: 2px solid #2a78d6; outline-offset: -2px; }
  .name { display: inline-flex; align-items: center; gap: 7px; }
  .chev { width: 11px; height: 11px; flex: none; color: #94A3B8; transition: transform .15s ease; }
  tr.open > td .chev { transform: rotate(90deg); }
  .chev.hidden { visibility: hidden; }
  .muted-row { font-style: italic; color: #94A3B8; font-weight: 400; }
  .dash { color: #CBD5E1; }
  .role { color: #94A3B8; font-weight: 400; }

  .band {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-weight: 700; font-size: 11px; min-width: 38px; text-align: center;
  }
  .cmp { color: #94A3B8; font-weight: 400; }

  .legend {
    display: flex; flex-wrap: wrap; gap: 8px 16px;
    font-size: 12px; color: #64748B; padding: 12px 16px;
  }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: middle; }
  .note { color: #64748B; font-size: 12px; margin: 0 0 16px; }
  footer { margin-top: 20px; color: #94A3B8; font-size: 11px; }

  /* ── Filter bar ─────────────────────────────────────────────────────────── */
  form.filters { margin: 0 0 16px; font-size: 13px; }
  /* One line while only the range row is visible. When the compare row is
     unhidden, add flex-basis:100% to .frow to put the two modes back on
     separate lines — see filterBar's TEMP note. */
  form.filters .card-body {
    padding: 10px 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  }
  form.filters .frow { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  form.filters fieldset {
    border: 0; margin: 0; padding: 0; min-width: 0;
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  }
  form.filters fieldset[disabled] { opacity: .45; }
  form.filters label { display: inline-flex; align-items: center; gap: 6px; }
  form.filters .mode { font-weight: 600; color: #0F172A; }
  form.filters input[type="date"] {
    font: inherit; padding: 4px 8px; color: inherit; background: #fff;
    border: 1px solid #E2E8F0; border-radius: 6px;
  }
  form.filters button {
    font: inherit; font-weight: 600; padding: 5px 14px; margin-left: auto;
    color: #fff; background: #2a78d6; border: 1px solid #2a78d6; border-radius: 6px; cursor: pointer;
  }
  form.filters button:hover { filter: brightness(1.08); }

  /* ── KPI strip ──────────────────────────────────────────────────────────── */
  .kpi { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px; margin: 0 0 16px; }
  .kpi-card {
    background: #fff; border: 1px solid #E2E8F0; border-radius: 12px;
    box-shadow: 0 1px 2px rgba(15,23,42,.06);
    padding: 12px; display: flex; flex-direction: column; gap: 4px;
  }
  .kpi-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 9px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #64748B;
  }
  .kpi-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; }
  .kpi-value { font-size: 20px; font-weight: 700; color: #0F172A; font-variant-numeric: tabular-nums; }
  @media (max-width: 900px) { .kpi { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 560px) { .kpi { grid-template-columns: repeat(2, 1fr); } }

  @media (prefers-color-scheme: dark) {
    body { background: #0B1220; color: #E2E8F0; }
    .subtitle, .note, footer { color: #94A3B8; }
    .card { background: #131C2B; border-color: #2A3648; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
    .card-head { border-bottom-color: #1F2A3A; }
    .card-head h2, .legend { color: #94A3B8; }
    .controls button { background: #131C2B; border-color: #2A3648; color: #B4C0D0; }
    .controls button[disabled] { border-color: #2A3648; color: #B4C0D0; }
    thead th { background: #182234; color: #94A3B8; border-bottom-color: #2A3648; }
    tbody td { color: #94A3B8; border-bottom-color: #1F2A3A; }
    tbody td:first-child, tbody td.num-total { color: #E2E8F0; }
    tr[data-depth="0"] td { background: #131C2B; }
    tr[data-depth="1"] td { background: #182234; }
    tr[data-depth="2"] td { background: #1E2A3E; }
    tr.grand td { background: #131C2B; border-top-color: #3A4A63; color: #E2E8F0; }
    tr.toggle:hover td { filter: brightness(1.25); }
    .cmp, .role, .muted-row { color: #6B7A8D; }
    .dash { color: #4A5A70; }
    form.filters .mode { color: #E2E8F0; }
    form.filters input[type="date"] { background: #182234; border-color: #2A3648; color: #E2E8F0; }
    .kpi-card { background: #131C2B; border-color: #2A3648; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
    .kpi-label { color: #94A3B8; }
    .kpi-value { color: #E2E8F0; }
  }

  @media print {
    body { background: #fff; padding: 0; }
    .card, .kpi-card { box-shadow: none; }
    .controls, form.filters { display: none; }
    tr[hidden] { display: table-row !important; }
  }
`;

// Collapse-on-load, so a no-JS reader keeps the whole tree.
//
// Row ids are structural ("b0", "b0s3"), not built from branch/source names:
// names would need escaping to survive an attribute selector, and concatenating
// two of them is ambiguous (org "AB" + source "C" collides with org "A" +
// source "BC"). The parent map is built once, so a toggle is O(rows × depth)
// object lookups rather than that many DOM queries.
const SCRIPT = `
(function () {
  var table = document.getElementById('drill');
  if (!table) return;
  var rows = Array.prototype.slice.call(table.tBodies[0].rows);
  var open = Object.create(null);
  var parentOf = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    var id = rows[i].getAttribute('data-id');
    if (id) parentOf[id] = rows[i].getAttribute('data-parent');
  }

  function apply() {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var p = r.getAttribute('data-parent');
      if (p === null) continue;
      var visible = true;
      while (p) {
        if (!open[p]) { visible = false; break; }
        p = parentOf[p] || null;
      }
      r.hidden = !visible;
    }
    for (var j = 0; j < rows.length; j++) {
      var t = rows[j];
      var tid = t.getAttribute('data-id');
      if (tid && t.classList.contains('toggle')) {
        var isOpen = !!open[tid];
        t.classList.toggle('open', isOpen);
        t.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      }
    }
    collapseBtn.disabled = Object.keys(open).length === 0;
  }

  function toggle(id) {
    if (open[id]) delete open[id]; else open[id] = true;
    apply();
  }

  table.addEventListener('click', function (e) {
    var tr = e.target.closest ? e.target.closest('tr.toggle') : null;
    if (tr) toggle(tr.getAttribute('data-id'));
  });
  table.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var tr = e.target.closest ? e.target.closest('tr.toggle') : null;
    if (!tr) return;
    e.preventDefault();
    toggle(tr.getAttribute('data-id'));
  });

  var expandBtn = document.getElementById('expand-all');
  var collapseBtn = document.getElementById('collapse-all');
  expandBtn.addEventListener('click', function () {
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-id');
      if (id && rows[i].classList.contains('toggle')) open[id] = true;
    }
    apply();
  });
  collapseBtn.addEventListener('click', function () {
    open = Object.create(null);
    apply();
  });

  document.getElementById('controls').hidden = false;
  apply();
})();
`;

// The visual half of the range/compare exclusion. The submitted-or-not half is
// the fieldset's `disabled` attribute, which the browser honours on its own —
// this only keeps it in sync as the radio changes, and greys the inactive row.
// Written as its own IIFE so the drill script's early return can't skip it.
const FILTER_SCRIPT = `
(function () {
  var range = document.getElementById('f-range');
  var compare = document.getElementById('f-compare');
  if (!range || !compare) return;
  var radios = document.querySelectorAll('form.filters input[name="mode"]');
  function sync() {
    var mode = 'range';
    for (var i = 0; i < radios.length; i++) if (radios[i].checked) mode = radios[i].value;
    range.disabled = mode !== 'range';
    compare.disabled = mode !== 'compare';
  }
  for (var i = 0; i < radios.length; i++) radios[i].addEventListener('change', sync);
  sync();
})();
`;

const CHEV = '<svg class="chev" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">'
  + '<path fill-rule="evenodd" d="M7.21 5.23a.75.75 0 011.06-.02l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.04-1.08L11.17 10 7.23 6.29a.75.75 0 01-.02-1.06z" clip-rule="evenodd"/></svg>';

/** The badge markup for one row's Pending Action, or an em dash for a zero-lead row. */
function pendingBadge(row: LeadReportMetrics): string {
  const pct = computePendingActionPct(row);
  const band = pendingActionBand(pct);
  return pct === null || !band ? '<span class="dash">—</span>' : `<span class="band" style="background:${band.bg};color:${band.text};">${pct}%</span>`;
}

/**
 * `skipUnassigned` blanks the Unassigned column at assignee depth: that metric
 * is degenerate once the group is already keyed by assigned_user_id (it just
 * restates total_leads on the Unassigned row and 0 on everyone else), so a
 * literal number would read as a real measurement.
 */
function metricCells(
  row: LeadReportMetrics,
  compareRow: LeadReportMetrics | undefined,
  hasCompare: boolean,
  skipUnassigned = false,
): string {
  const cells = COLUMNS.map((c) => {
    const cls = c.key === 'total_leads' ? ' class="num-total"' : '';
    if (skipUnassigned && c.key === 'unassigned_count') return `<td><span class="dash">—</span></td>`;
    const value = Number(row[c.key] ?? 0);
    if (!hasCompare) return `<td${cls}>${value}</td>`;
    const compareValue = compareRow ? Number(compareRow[c.key] ?? 0) : '—';
    return `<td${cls}>${value}<br><span class="cmp">${compareValue}</span></td>`;
  }).join('');

  if (!hasCompare) return `${cells}<td>${pendingBadge(row)}</td>`;
  const comparePending = compareRow ? pendingBadge(compareRow) : '—';
  return `${cells}<td>${pendingBadge(row)}<br><span class="cmp">${comparePending}</span></td>`;
}

/** Structural, collision-free row ids — see the note above SCRIPT. */
function branchId(i: number): string {
  return `b${i}`;
}

function srcId(parent: string | null, j: number): string {
  return `${parent ?? 'r'}s${j}`;
}

function nameCell(label: string, expandable: boolean, extra = ''): string {
  const chev = expandable ? CHEV : CHEV.replace('class="chev"', 'class="chev hidden"');
  return `<td><span class="name">${chev}<span${extra}>${label}</span></span></td>`;
}

function sourceKey(row: { source_id: string | null; source_label: string }): string {
  return row.source_id ?? row.source_label;
}

/**
 * The whole tree, flattened to depth-tagged <tr>s. Branch level is omitted when
 * the report is scoped to a single branch (an API key bound to one org, or
 * ?branch_id=), which mirrors the dashboard's non-tenant view: there is no
 * branch to pick, so the tree starts at Source.
 */
function drillRows(report: TenantReport, opts: PublicReportOptions, hasCompare: boolean): string {
  const branchRows = report.branches.filter((b) => !b.is_total);
  const totalRow = report.branches.find((b) => b.is_total);
  const branchRooted = branchRows.length > 1;

  // Level 2, grouped by org_name and sorted like the dashboard (total desc).
  const sourcesByBranch = new Map<string, SourceBranchRow[]>();
  for (const s of opts.sourceBranches.filter((s) => !s.is_total)) {
    const list = sourcesByBranch.get(s.org_name);
    if (list) list.push(s);
    else sourcesByBranch.set(s.org_name, [s]);
  }
  for (const list of sourcesByBranch.values()) list.sort((a, b) => b.total_leads - a.total_leads);

  // Level 3, keyed the same way the rows themselves derive their key.
  const usersByBranchSource = new Map<string, SourceUserRow[]>();
  for (const u of opts.sourceUsers) {
    const k = `${u.org_name}${sourceKey(u)}`;
    const list = usersByBranchSource.get(k);
    if (list) list.push(u);
    else usersByBranchSource.set(k, [u]);
  }
  for (const list of usersByBranchSource.values()) {
    list.sort((a, b) => (a.is_unassigned !== b.is_unassigned
      ? Number(b.is_unassigned) - Number(a.is_unassigned)
      : a.assignee.localeCompare(b.assignee)));
  }

  // Compare lookups, one per level.
  const cmpBranch = new Map((opts.compareSnapshot?.branches ?? []).filter((b) => !b.is_total).map((b) => [b.org_id, b]));
  const cmpBranchTotal = opts.compareSnapshot?.branches.find((b) => b.is_total);
  const cmpSource = new Map((opts.sourceCompareSnapshot?.branches ?? []).filter((s) => !s.is_total)
    .map((s) => [`${s.org_id}${sourceKey(s)}`, s]));
  const cmpUser = new Map((opts.sourceCompareSnapshot?.users ?? [])
    .map((u) => [`${u.org_id}${u.assigned_user_id ?? 'unassigned'}${sourceKey(u)}`, u]));

  const out: string[] = [];

  const pushSources = (sources: SourceBranchRow[], parentId: string | null, depth: 1 | 0) => {
    if (!sources.length) {
      out.push(`<tr data-depth="${depth}"${parentId === null ? '' : ` data-parent="${escapeHtml(parentId)}"`}>`
        + `<td colspan="${COL_COUNT}" class="muted-row">No source data.</td></tr>`);
      return;
    }
    for (let j = 0; j < sources.length; j++) {
      const s = sources[j]!;
      const id = srcId(parentId, j);
      const users = usersByBranchSource.get(`${s.org_name}${sourceKey(s)}`) ?? [];
      const parentAttr = parentId === null ? '' : ` data-parent="${escapeHtml(parentId)}"`;
      out.push(
        `<tr class="toggle" data-depth="${depth}" data-id="${escapeHtml(id)}"${parentAttr} tabindex="0" role="button" aria-expanded="true">`
        + nameCell(escapeHtml(s.source_label), true)
        + metricCells(s, cmpSource.get(`${s.org_id}${sourceKey(s)}`), hasCompare)
        + '</tr>',
      );

      const childDepth = depth + 1;
      if (!users.length) {
        out.push(`<tr data-depth="${childDepth}" data-parent="${escapeHtml(id)}">`
          + `<td colspan="${COL_COUNT}" class="muted-row">No assignee data.</td></tr>`);
        continue;
      }
      for (const u of users) {
        const label = u.is_unassigned
          ? '<span class="muted-row">Unassigned</span>'
          : escapeHtml(u.assignee) + (u.role_label ? ` <span class="role">(${escapeHtml(u.role_label)})</span>` : '');
        out.push(
          `<tr data-depth="${childDepth}" data-parent="${escapeHtml(id)}">`
          + nameCell(label, false)
          + metricCells(u, cmpUser.get(`${u.org_id}${u.assigned_user_id ?? 'unassigned'}${sourceKey(u)}`), hasCompare, true)
          + '</tr>',
        );
      }
    }
  };

  if (!branchRooted) {
    pushSources([...sourcesByBranch.values()].flat(), null, 0);
  } else {
    for (let i = 0; i < branchRows.length; i++) {
      const b = branchRows[i]!;
      const id = branchId(i);
      out.push(
        `<tr class="toggle" data-depth="0" data-id="${escapeHtml(id)}" tabindex="0" role="button" aria-expanded="true">`
        + nameCell(escapeHtml(b.org_name), true)
        + metricCells(b, b.org_id ? cmpBranch.get(b.org_id) : undefined, hasCompare)
        + '</tr>',
      );
      pushSources(sourcesByBranch.get(b.org_name) ?? [], id, 1);
    }
    if (totalRow) {
      out.push(`<tr class="grand"><td>${escapeHtml(totalRow.org_name)}</td>`
        + metricCells(totalRow, cmpBranchTotal, hasCompare) + '</tr>');
    }
  }

  if (!out.length) return `<tr><td colspan="${COL_COUNT}" class="muted-row">No data found.</td></tr>`;
  return out.join('');
}

function headerRow(hasCompare: boolean): string {
  const cells = COLUMNS.map((c) => `<th>${escapeHtml(c.label)}${hasCompare ? '<br><span class="cmp">vs.</span>' : ''}</th>`).join('');
  return `<tr><th>Branch / Source / Assignee</th>${cells}<th>Pending Action${hasCompare ? '<br><span class="cmp">vs.</span>' : ''}</th></tr>`;
}

function legend(): string {
  const swatches = PENDING_ACTION_LEGEND.map(
    (l) => `<span><span class="swatch" style="background:${l.band.bg};"></span>${escapeHtml(l.range)} (${l.band.label})</span>`,
  ).join('');
  return `<div class="legend"><strong>Pending Action:</strong> ${swatches}</div>`;
}

/**
 * Date range and "Compare with" are mutually exclusive, and the exclusion is
 * enforced by the browser rather than by script: controls inside a disabled
 * <fieldset> are never submitted, so whichever mode is not selected simply
 * doesn't appear in the query string. The inline script only moves that
 * `disabled` flag when the radio changes — with JS off, the server-rendered
 * mode is still internally consistent.
 *
 * TEMP: the Compare row is hidden from the UI (style="display:none") per
 * request, and with only one mode left to pick, BOTH mode radios are hidden too
 * — a lone radio you can't unselect is noise — which collapses the bar to a
 * single "From … To … [Apply]" line. The ?compare= query param and all its
 * rendering logic are untouched, so a URL built by hand still works, and the
 * row is rendered (just hidden) rather than omitted so the unhide stays small.
 *
 * To bring Compare back: drop the two `display:none` inline styles below, and
 * add `form.filters .frow { flex-basis: 100%; }` to STYLE so the two modes
 * stack instead of sharing one line.
 *
 * The radios live OUTSIDE the fieldsets deliberately — a radio inside the
 * fieldset it controls would be disabled by its own mode and could never be
 * selected. Hiding them does not change what is submitted: the controller never
 * reads `mode`, and the disabled fieldset is what actually gates the params.
 */
function filterBar(report: TenantReport, opts: PublicReportOptions): string {
  const compareMode = opts.compareDate !== null;
  const max = escapeHtml(report.report_date);
  const start = escapeHtml(opts.range?.start ?? '');
  const end = escapeHtml(opts.range?.end ?? '');

  return (
    `<form class="filters card" method="get">` +
    `<div class="card-body">` +
    `<input type="hidden" name="key" value="${escapeHtml(opts.key)}">` +
    (opts.branchId ? `<input type="hidden" name="branch_id" value="${escapeHtml(opts.branchId)}">` : '') +

    `<div class="frow">` +
    `<label class="mode" style="display:none;"><input type="radio" name="mode" value="range"${compareMode ? '' : ' checked'}> Date range</label>` +
    `<fieldset id="f-range"${compareMode ? ' disabled' : ''}>` +
    `<label>From <input type="date" name="start" value="${start}" max="${max}"></label>` +
    `<label>To <input type="date" name="end" value="${end}" max="${max}"></label>` +
    `</fieldset>` +
    `</div>` +

    `<div class="frow" style="display:none;">` +
    `<label class="mode"><input type="radio" name="mode" value="compare"${compareMode ? ' checked' : ''}> Compare with</label>` +
    `<fieldset id="f-compare"${compareMode ? '' : ' disabled'}>` +
    `<input type="date" name="compare" value="${escapeHtml(opts.compareDate ?? '')}" max="${max}">` +
    `</fieldset>` +
    `</div>` +

    `<button type="submit">Apply</button>` +
    `</div></form>`
  );
}

/**
 * The row the KPI cards read. Normally the "ALL BRANCHES" rollup, but
 * scopeReport drops that row when the report is narrowed to a single branch (a
 * key bound to one org, or ?branch_id=) — a common case — so fall back to
 * summing whatever branch rows are left.
 */
function totalsRow(report: TenantReport): LeadReportMetrics | null {
  const rollup = report.branches.find((b) => b.is_total);
  if (rollup) return rollup;
  if (!report.branches.length) return null;

  const sum: LeadReportMetrics = {
    total_leads: 0, new_count: 0, new_leads_today: 0, new_leads_this_month: 0,
    unassigned_count: 0, followup_scheduled: 0, followup_overdue: 0,
    converted_count: 0, unqualified_count: 0,
  };
  for (const b of report.branches) {
    for (const k of Object.keys(sum) as Array<keyof LeadReportMetrics>) sum[k] += Number(b[k] ?? 0);
  }
  return sum;
}

/** Accent dots, same three semantic colors AnalyticsClient's STATUS constants use. */
const STATUS = { good: '#16a34a', warning: '#f59e0b', critical: '#dc2626' };

function kpiCard(label: string, value: number | string, accent?: string): string {
  const dot = accent ? `<span class="kpi-dot" style="background:${accent};"></span>` : '';
  return `<div class="kpi-card"><span class="kpi-label">${dot}${escapeHtml(label)}</span>`
    + `<span class="kpi-value">${escapeHtml(String(value))}</span></div>`;
}

/** Mirrors the in-app analytics KPI strip (AnalyticsClient.tsx) card for card, in the same order. */
function kpiStrip(report: TenantReport): string {
  const t = totalsRow(report);
  if (!t) return '';
  const rate = t.total_leads ? `${((t.converted_count / t.total_leads) * 100).toFixed(1)}%` : '—';
  return `<div class="kpi">`
    + kpiCard('Total Leads', t.total_leads)
    + kpiCard('New This Month', t.new_leads_this_month, STATUS.good)
    + kpiCard('New Today', t.new_leads_today, STATUS.good)
    + kpiCard('Unassigned', t.unassigned_count, STATUS.warning)
    + kpiCard('Follow-up Overdue', t.followup_overdue, STATUS.critical)
    + kpiCard('Converted', t.converted_count, STATUS.good)
    + kpiCard('Conversion Rate', rate)
    + `</div>`;
}

export function renderPublicReportHtml(report: TenantReport, opts: PublicReportOptions): string {
  const hasCompare = opts.compareDate !== null;
  // Both snapshot reads come from the same table/date, written in the same
  // job run, so in practice either both are null or neither is — checking one
  // is enough for the "no history yet" note.
  const compareMissing = hasCompare && opts.compareSnapshot === null;

  // The window the numbers actually cover — the report_date alone would be
  // misleading now that the page defaults to month-to-date rather than "now".
  const period = opts.range
    ? `${escapeHtml(opts.range.start)} &rarr; ${escapeHtml(opts.range.end)}`
    : escapeHtml(report.report_date);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Lead Report — ${escapeHtml(report.tenant_name)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<h1>Daily Lead Report</h1>
<p class="subtitle">${escapeHtml(report.tenant_name)} &middot; ${period}</p>
${filterBar(report, opts)}
${compareMissing ? `<p class="note">No snapshot recorded for ${escapeHtml(opts.compareDate ?? '')} yet.</p>` : ''}
${kpiStrip(report)}
<div class="card">
  <div class="card-head">
    <h2>Detailed Summary</h2>
    <div class="controls" id="controls" hidden>
      <button type="button" id="expand-all">Expand all</button>
      <button type="button" id="collapse-all">Collapse all</button>
    </div>
  </div>
  <div class="table-wrap">
    <table id="drill">
      <thead>${headerRow(hasCompare)}</thead>
      <tbody>${drillRows(report, opts, hasCompare)}</tbody>
    </table>
  </div>
  ${legend()}
</div>
<footer>${opts.range
    ? `Covers leads created ${period}; status counts are evaluated at load time.`
    : 'Counts are a live snapshot at load time.'}${hasCompare ? ` Second value in each cell is ${escapeHtml(opts.compareDate ?? '')}.` : ''}</footer>
</div>
<script>${SCRIPT}${FILTER_SCRIPT}</script>
</body>
</html>`;
}
