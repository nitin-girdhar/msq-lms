// ─────────────────────────────────────────────────────────────────────────────
// Daily lead report -> email subject, HTML body and plain-text body.
//
// Pure functions, no I/O and no DB: the job's --dry-run prints exactly what
// would be sent, and the whole file is unit-testable without a database.
//
// HTML constraints (these are not style preferences):
//   * Inline styles only. Gmail strips <style> blocks and there is no <head> to
//     put one in — communication-service passes this string straight to
//     nodemailer as the html part.
//   * Tables, not flex/grid. Outlook renders through Word's engine.
//   * Every interpolated string is escaped. Branch names, tenant names and
//     iam.users.full_name are user-supplied free text landing in a mail client.
// ─────────────────────────────────────────────────────────────────────────────

import type { BranchReportRow, LeadReportMetrics, TenantReport, UserReportRow } from './lead-report.types.js';
import { computePendingActionPct, pendingActionBand, PENDING_ACTION_LEGEND } from './pending-action.js';

/**
 * communication-service caps html at 100_000 and body at 50_000
 * (sendCommunicationSchema in communication.schema.ts). Stay under with headroom
 * — going over is a 400 that loses the whole report rather than one section.
 */
const HTML_BUDGET = 95_000;
const TEXT_BUDGET = 48_000;

const OMITTED_NOTE = 'User breakdown omitted — too large for email. See the analytics dashboard for the full list.';

// Kept in sync with public-report.render.ts's column set/order by request —
// the email and the public page must show the same columns. Pending Action
// (computed, not a raw metric) is appended separately, below.
const COLUMNS = [
  { key: 'total_leads', label: 'Total Leads' },
  { key: 'new_count', label: 'New' },
  { key: 'unassigned_count', label: 'Unassigned' },
  { key: 'followup_scheduled', label: 'FollowUp Scheduled' },
  { key: 'followup_overdue', label: 'FollowUp Overdue' },
  { key: 'converted_count', label: 'Converted' },
  { key: 'unqualified_count', label: 'Unqualified' },
] as const satisfies ReadonlyArray<{ key: keyof LeadReportMetrics; label: string }>;

/** Columns worth drawing attention to when non-zero. */
const ALERT_KEYS = new Set<keyof LeadReportMetrics>(['followup_overdue', 'unassigned_count']);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The subject is interpolated into an SMTP header. communication-service rejects
 * any subject containing a control character with a 400 (HEADER_SAFE in
 * communication.schema.ts) — a bare CR/LF would otherwise end the header and let
 * the rest be parsed as extra headers. Tenant names are user-supplied, so
 * sanitise here rather than hope, and keep the whole thing ASCII so the header
 * stays readable in logs and mail filters.
 */
export function reportSubject(tenantName: string, reportDate: string): string {
  const safeName = tenantName
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Tenant';
  return `Daily Lead Report - ${safeName} - ${reportDate}`.slice(0, 500);
}

// ── HTML ────────────────────────────────────────────────────────────────────

const TH = 'padding:6px 10px;border:1px solid #d0d5dd;background:#f2f4f7;font:600 12px/1.4 Arial,sans-serif;text-align:right;';
const TH_LEFT = TH.replace('text-align:right', 'text-align:left');
const TD = 'padding:6px 10px;border:1px solid #d0d5dd;font:400 12px/1.4 Arial,sans-serif;text-align:right;';
const TD_LEFT = TD.replace('text-align:right', 'text-align:left');
const TD_ALERT = `${TD}background:#fdecea;font-weight:600;`;

function headerRow(firstLabel: string): string {
  const cells = COLUMNS.map((c) => `<th style="${TH}">${escapeHtml(c.label)}</th>`).join('');
  return `<tr><th style="${TH_LEFT}">${escapeHtml(firstLabel)}</th>${cells}<th style="${TH}">Pending Action</th></tr>`;
}

/** Same formula/bands as the public page (pending-action.ts); expressed as an inline style since Gmail strips <style> blocks. */
function pendingActionCell(row: LeadReportMetrics): string {
  const pct = computePendingActionPct(row);
  const band = pendingActionBand(pct);
  if (pct === null || !band) return `<td style="${TD}">—</td>`;
  return `<td style="${TD}background:${band.bg};color:${band.text};font-weight:600;">${pct}%</td>`;
}

function metricCells(row: LeadReportMetrics, emphasise: boolean): string {
  const cells = COLUMNS.map((c) => {
    const value = Number(row[c.key] ?? 0);
    const alert = ALERT_KEYS.has(c.key) && value > 0;
    const style = alert ? TD_ALERT : emphasise ? `${TD}font-weight:600;` : TD;
    return `<td style="${style}">${value}</td>`;
  }).join('');
  return `${cells}${pendingActionCell(row)}`;
}

function branchTable(branches: BranchReportRow[]): string {
  const rows = branches
    .filter((b) => !b.is_total)
    .map((b) => {
      const tz = b.org_timezone ? ` <span style="color:#667085;font-size:11px;">(${escapeHtml(b.org_timezone)})</span>` : '';
      return `<tr><td style="${TD_LEFT}">${escapeHtml(b.org_name)}${tz}</td>${metricCells(b, false)}</tr>`;
    });

  const total = branches.find((b) => b.is_total);
  if (total) {
    rows.push(
      `<tr><td style="${TD_LEFT}border-top:2px solid #333;font-weight:600;">${escapeHtml(total.org_name)}</td>` +
      metricCells(total, true).replace(/border:1px solid #d0d5dd;/g, 'border:1px solid #d0d5dd;border-top:2px solid #333;') +
      '</tr>',
    );
  }

  if (rows.length === 0) return '<p style="font:400 13px/1.5 Arial,sans-serif;">No branches found for this tenant.</p>';

  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:900px;">` +
    `<thead>${headerRow('Branch')}</thead><tbody>${rows.join('')}</tbody></table>`;
}

function userTable(users: UserReportRow[]): string {
  if (users.length === 0) {
    return '<p style="font:400 13px/1.5 Arial,sans-serif;">No leads assigned in any branch.</p>';
  }

  const byBranch = new Map<string, UserReportRow[]>();
  for (const u of users) {
    const list = byBranch.get(u.org_name);
    if (list) list.push(u);
    else byBranch.set(u.org_name, [u]);
  }

  const bandStyle = `padding:6px 10px;border:1px solid #d0d5dd;background:#e9eefb;font:600 12px/1.4 Arial,sans-serif;text-align:left;`;
  const body: string[] = [];
  for (const [orgName, rows] of byBranch) {
    body.push(`<tr><th colspan="${COLUMNS.length + 2}" style="${bandStyle}">${escapeHtml(orgName)}</th></tr>`);
    for (const u of rows) {
      const nameStyle = u.is_unassigned ? `${TD_LEFT}font-style:italic;` : TD_LEFT;
      body.push(`<tr><td style="${nameStyle}">${escapeHtml(u.assignee)}</td>${metricCells(u, false)}</tr>`);
    }
  }

  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:900px;">` +
    `<thead>${headerRow('Assignee')}</thead><tbody>${body.join('')}</tbody></table>`;
}

/**
 * Renders the report as an email-client-safe HTML fragment.
 *
 * If the user breakdown would push the payload past communication-service's html
 * cap, that section is dropped and replaced with a pointer to the dashboard —
 * losing the optional section beats a 400 that loses the whole email.
 */
export function renderReportHtml(report: TenantReport): { html: string; usersOmitted: boolean } {
  const h2 = 'font:600 15px/1.4 Arial,sans-serif;margin:24px 0 8px;';
  const head =
    `<div style="font:400 13px/1.5 Arial,sans-serif;color:#101828;">` +
    `<h1 style="font:600 18px/1.3 Arial,sans-serif;margin:0 0 4px;">Daily Lead Report</h1>` +
    `<p style="margin:0 0 20px;color:#475467;">${escapeHtml(report.tenant_name)} &middot; ${escapeHtml(report.report_date)}</p>` +
    `<h2 style="${h2}">By branch</h2>${branchTable(report.branches)}`;
  const legend = PENDING_ACTION_LEGEND
    .map((l) => `<span style="background:${l.band.bg};color:${l.band.text};padding:1px 6px;border-radius:8px;">${escapeHtml(l.range)}</span>`)
    .join(' ');
  const foot =
    `<p style="margin:24px 0 0;color:#667085;font:400 11px/1.5 Arial,sans-serif;">` +
    `Counts are a live snapshot at send time.` +
    `</p>` +
    `<p style="margin:6px 0 0;font:400 11px/1.5 Arial,sans-serif;">` +
    `Pending Action = (New + Unassigned + FollowUp Overdue) / Total Leads. ${legend}` +
    `</p></div>`;

  const withUsers = `${head}<h2 style="${h2}">By assignee</h2>${userTable(report.users)}${foot}`;
  if (withUsers.length <= HTML_BUDGET) return { html: withUsers, usersOmitted: false };

  const withoutUsers =
    `${head}<h2 style="${h2}">By assignee</h2>` +
    `<p style="font:400 13px/1.5 Arial,sans-serif;color:#b42318;">${escapeHtml(OMITTED_NOTE)}</p>${foot}`;
  return { html: withoutUsers, usersOmitted: true };
}

// ── Plain text ──────────────────────────────────────────────────────────────

// Wide enough to keep real branch names distinguishable: production names run
// like "MSquare Professionals - Gurgaon HQ", which a 24-column budget truncates
// to an identical "MSquare Professionals -…" on every row.
const NAME_WIDTH = 34;
// Must exceed the longest column label ('FollowUp Scheduled', 19) or
// right-aligned headers run into each other with no separating space.
const NUM_WIDTH = 20;
// Plain text can't carry the color bands, so this is a bare percentage.
const PENDING_LABEL = 'Pending%';

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function textRow(label: string, row: LeadReportMetrics): string {
  const cells = COLUMNS.map((c) => String(Number(row[c.key] ?? 0)).padStart(NUM_WIDTH));
  const pct = computePendingActionPct(row);
  cells.push((pct === null ? '—' : `${pct}%`).padStart(NUM_WIDTH));
  return `${truncate(label, NAME_WIDTH).padEnd(NAME_WIDTH)}${cells.join('')}`;
}

function textHeader(firstLabel: string): string[] {
  const head = `${firstLabel.padEnd(NAME_WIDTH)}${COLUMNS.map((c) => c.label.padStart(NUM_WIDTH)).join('')}${PENDING_LABEL.padStart(NUM_WIDTH)}`;
  return [head, '-'.repeat(head.length)];
}

/**
 * Plain-text body. Not optional: communication-service requires `body` whenever
 * `email_addresses` is present, and nodemailer sends it as the text/plain part —
 * so this is what a text-only or screen-reader client actually reads.
 */
export function renderReportText(report: TenantReport): { text: string; usersOmitted: boolean } {
  const lines: string[] = [
    `DAILY LEAD REPORT`,
    `${report.tenant_name} — ${report.report_date}`,
    '',
    'BY BRANCH',
    ...textHeader('Branch'),
  ];

  for (const b of report.branches.filter((r) => !r.is_total)) lines.push(textRow(b.org_name, b));
  const total = report.branches.find((b) => b.is_total);
  if (total) {
    lines.push('-'.repeat(NAME_WIDTH + NUM_WIDTH * (COLUMNS.length + 1)));
    lines.push(textRow(total.org_name, total));
  }

  const head = lines.join('\n');
  const userLines: string[] = ['', '', 'BY ASSIGNEE', ...textHeader('Assignee')];
  let currentOrg = '';
  for (const u of report.users) {
    if (u.org_name !== currentOrg) {
      currentOrg = u.org_name;
      userLines.push('', `[${currentOrg}]`);
    }
    userLines.push(textRow(u.assignee, u));
  }
  const foot = '\n\nCounts are a live snapshot at send time. '
    + 'Pending% = (New + Unassigned + FollowUp Overdue) / Total Leads: <20% low, 20-40% moderate, 40-60% high, 60%+ critical.';

  const withUsers = `${head}${userLines.join('\n')}${foot}`;
  if (withUsers.length <= TEXT_BUDGET) return { text: withUsers, usersOmitted: false };
  return { text: `${head}\n\nBY ASSIGNEE\n${OMITTED_NOTE}${foot}`, usersOmitted: true };
}
