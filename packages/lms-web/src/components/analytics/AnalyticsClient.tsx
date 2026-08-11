'use client';

import { useMemo, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { analytics } from '../../lib/api/client';
import type {
  BranchReportRow,
  LeadReportMetrics,
  SourceBranchRow,
  SourceUserRow,
} from '../../types/analytics';

interface Props {
  actorRank: number;
  orgId: string;
}

interface PipelineStage {
  stage: string;
  stage_label: string;
  count: number;
}

// Validated categorical palette (dataviz skill reference palette) — fixed hue
// order, never cycled or reassigned per render.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const INK = { primary: '#0F172A', secondary: '#64748B', muted: '#898781', grid: '#E2E8F0', surface: '#FFFFFF' };

// Mirrors leads-service's lib/reports/pending-action.ts (computePendingActionPct
// + its 4 bands) so the live dashboard's badge matches the public report's
// exactly. Duplicated rather than shared because the two live in separate
// packages (frontend vs. backend service) with no shared code path today.
const PENDING_ACTION_BANDS = [
  { upperBound: 20, bg: '#16a34a', text: '#ffffff' },
  { upperBound: 40, bg: '#eab308', text: '#1f2937' },
  { upperBound: 60, bg: '#f97316', text: '#ffffff' },
  { upperBound: Infinity, bg: '#dc2626', text: '#ffffff' },
] as const;

function pendingActionPct(row: { total_leads: number; new_count: number; followup_overdue: number }): number | null {
  if (row.total_leads <= 0) return null;
  return Math.round((100 * (row.new_count + row.followup_overdue)) / row.total_leads);
}

function pendingActionBand(pct: number | null) {
  if (pct === null) return null;
  return PENDING_ACTION_BANDS.find((b) => pct < b.upperBound) ?? PENDING_ACTION_BANDS[PENDING_ACTION_BANDS.length - 1];
}

// Built from local date parts, NOT toISOString() — that serialises in UTC, so
// for an IST user between midnight and 05:30 local it reports yesterday, and
// "today" on the dashboard would silently disagree with the leads list.
function localDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function today(): string {
  return localDate(new Date());
}
function monthStart(): string {
  return `${today().slice(0, 7)}-01`;
}

export default function AnalyticsClient(_props: Props) {
  // Lead-creation window every section on this page is filtered by. Defaults to
  // the current calendar month to date.
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(today);

  // The range is part of every SWR key: without it a filter change would be
  // served the previous window's cached response.
  const range = { start, end };
  const { data: pipelineData, isLoading: pipelineLoading } = useSWR(
    ['analytics/pipeline', start, end], () => analytics.pipeline(range), { revalidateOnFocus: false },
  );
  const { data: branchData, isLoading: branchLoading } = useSWR(
    ['analytics/report/branches', start, end], () => analytics.branchReport(range), { revalidateOnFocus: false },
  );
  const { data: sourceData, isLoading: sourceLoading } = useSWR(
    ['analytics/report/sources', start, end], () => analytics.sourceReport(range), { revalidateOnFocus: false },
  );
  // `/report/users` is no longer fetched: its (branch, assignee) grain is a
  // strict subset of `/report/sources`.users, which carries the same metrics at
  // the finer (branch, assignee, source) grain the drill-down needs.

  const [openBranches, setOpenBranches] = useState<ReadonlySet<string>>(() => new Set());
  const [openSources, setOpenSources] = useState<ReadonlySet<string>>(() => new Set());

  const isLoading = pipelineLoading || branchLoading || sourceLoading;
  const pipeline = (pipelineData?.data ?? []) as PipelineStage[];
  const branches = (branchData?.data ?? []) as BranchReportRow[];
  const sourceBranches = (sourceData?.data?.branches ?? []) as SourceBranchRow[];
  const sourceUsers = (sourceData?.data?.users ?? []) as SourceUserRow[];

  const totalRow = branches.find((b) => b.is_total) ?? branches[0] ?? null;
  const branchRows = branches.filter((b) => !b.is_total);
  // Counted from the real branch rows, never from "an is_total row exists": the
  // ranged path derives its rollup in TS (rollupBranchesFromSources) and so
  // emits one even for a single-branch org admin, which the old test read as a
  // tenant-wide actor.
  const isTenantWide = branchRows.length > 1;
  const sourceRows = sourceBranches.filter((s) => !s.is_total);

  // Level 2 of the drill-down: a branch's sources. sourceRows is already one row
  // per (branch, source), so grouping by org_name splits it into per-branch
  // lists in which each source appears exactly once. org_name (not org_id) is
  // the join key throughout: BranchReportRow.org_id is nullable, org_name is
  // not, and it's the identity the branch rows already used.
  const sourcesByBranch = useMemo(() => {
    const m = new Map<string, SourceBranchRow[]>();
    for (const s of sourceRows) {
      const list = m.get(s.org_name);
      if (list) list.push(s);
      else m.set(s.org_name, [s]);
    }
    for (const list of m.values()) list.sort((a, b) => b.total_leads - a.total_leads);
    return m;
  }, [sourceRows]);

  // Level 3: the people working one branch's leads from one source. `?? label`
  // mirrors the SQL's COALESCE(src.label, 'Unknown') — a deleted source arrives
  // with a null source_id on both sides, so both sides must fall back the same
  // way or the child list silently comes back empty.
  const usersByBranchSource = useMemo(() => {
    const m = new Map<string, SourceUserRow[]>();
    for (const u of sourceUsers) {
      const key = `${u.org_name}::${u.source_id ?? u.source_label}`;
      const list = m.get(key);
      if (list) list.push(u);
      else m.set(key, [u]);
    }
    // Matches the backend's own ORDER BY is_unassigned DESC, assignee.
    for (const list of m.values()) {
      list.sort((a, b) =>
        a.is_unassigned !== b.is_unassigned
          ? Number(b.is_unassigned) - Number(a.is_unassigned)
          : a.assignee.localeCompare(b.assignee));
    }
    return m;
  }, [sourceUsers]);

  // Tenant actors drill Branch ▸ Source ▸ Assignee; a single-branch actor has no
  // branch to pick, so the same tree starts one level in, at Source. Same test
  // as isTenantWide today, kept as its own name because it answers a different
  // question — how the tree is rooted, not who the viewer is.
  const branchRooted = isTenantWide;

  // Only the rows currently visible, flattened to depth-tagged records. Walking
  // once per toggle (rather than per row) is what keeps "Expand all" cheap on a
  // tenant with many branches × sources × staff.
  const drillRows = useMemo(() => {
    const out: DrillRow[] = [];

    // Keys are always derived from the row's own org_name, never from a name
    // threaded in from the branch endpoint — the two payloads must agree for the
    // child lookup to hit, so there's no reason to give them a second chance to
    // disagree.
    const pushSources = (sources: SourceBranchRow[], emptyKey: string, depth: 0 | 1) => {
      if (!sources.length) {
        out.push({ key: `${emptyKey}::∅`, depth, label: 'No source data', placeholder: true });
        return;
      }
      for (const s of sources) {
        const key = `${s.org_name}::${s.source_id ?? s.source_label}`;
        const isOpen = openSources.has(key);
        out.push({ key, depth, label: s.source_label, metrics: s, expandable: true, isOpen });
        if (!isOpen) continue;

        const users = usersByBranchSource.get(key) ?? [];
        const childDepth = (depth + 1) as 1 | 2;
        if (!users.length) {
          out.push({ key: `${key}::∅`, depth: childDepth, label: 'No assignee data', placeholder: true });
          continue;
        }
        for (const u of users) {
          out.push({
            key: `${key}::${u.assigned_user_id ?? 'unassigned'}`,
            depth: childDepth,
            label: u.is_unassigned ? 'Unassigned' : u.assignee,
            muted: u.is_unassigned,
            metrics: u,
            // unassigned_count is degenerate at this grain — the group is
            // already keyed by assigned_user_id, so it only ever restates
            // total_leads or 0. A literal number would read as a measurement.
            hideUnassigned: true,
          });
        }
      }
    };

    if (!branchRooted) {
      // One branch, so there is at most one group — flatten rather than look it
      // up by name.
      pushSources([...sourcesByBranch.values()].flat(), 'root', 0);
      return out;
    }

    for (const b of branchRows) {
      const isOpen = openBranches.has(b.org_name);
      out.push({ key: b.org_name, depth: 0, label: b.org_name, metrics: b, expandable: true, isOpen });
      if (isOpen) pushSources(sourcesByBranch.get(b.org_name) ?? [], b.org_name, 1);
    }
    return out;
  }, [branchRooted, branchRows, sourcesByBranch, usersByBranchSource, openBranches, openSources]);

  const anyOpen = openBranches.size > 0 || openSources.size > 0;

  const expandAll = () => {
    setOpenBranches(new Set(branchRows.map((b) => b.org_name)));
    setOpenSources(new Set(
      [...sourcesByBranch.entries()].flatMap(([org, list]) =>
        list.map((s) => `${org}::${s.source_id ?? s.source_label}`)),
    ));
  };

  const collapseAll = () => {
    setOpenBranches(new Set());
    setOpenSources(new Set());
  };

  const toggleBranch = (key: string) => {
    setOpenBranches((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    // Prune the branch's source keys so reopening it starts collapsed.
    setOpenSources((cur) => {
      const next = new Set([...cur].filter((k) => !k.startsWith(`${key}::`)));
      return next.size === cur.size ? cur : next;
    });
  };

  const toggleSource = (key: string) => {
    setOpenSources((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-8 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0F172A]">Analytics</h1>
        <p className="mt-1 text-xs text-[#64748B]">
          Lead performance {isTenantWide ? 'across your branches' : 'for your organisation'} — by source, by branch, and by status.
          {' '}Covers leads <span className="font-medium text-[#475569]">created</span> in the selected window; status
          counts are as of now.
        </p>
      </div>

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="From">
            <input type="date" max={end} value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
          </FilterField>
          <FilterField label="To">
            <input type="date" min={start} max={today()} value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
          </FilterField>
          <button
            type="button"
            onClick={() => { setStart(monthStart()); setEnd(today()); }}
            className="rounded-lg border border-[#E2E8F0] px-2.5 py-1.5 text-xs font-semibold text-[#475569] hover:border-[#0b6cbf] hover:text-[#0b6cbf]"
          >
            This month
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-[#64748B]">Loading…</div>
      ) : !totalRow ? (
        <p className="text-sm text-[#64748B]">No data available.</p>
      ) : (
        <>
          {/* ── KPI strip ─────────────────────────────────────────────── */}
          {/* Every card is a plain count over the selected window. "New This
              Month" / "New Today" were dropped when the date filter landed:
              under the default month-to-date range the former just restates
              Total Leads, and under any other range both describe a period the
              user did not ask for. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <StatCard label="Total Leads" value={totalRow.total_leads} />
            <StatCard label="New" value={totalRow.new_count} accent={SERIES[0]} />
            <StatCard label="Unassigned" value={totalRow.unassigned_count} accent={STATUS.warning} />
            <StatCard label="Follow-up Scheduled" value={totalRow.followup_scheduled} accent={SERIES[6]} />
            <StatCard label="Follow-up Overdue" value={totalRow.followup_overdue} accent={STATUS.critical} />
            <StatCard label="Converted" value={totalRow.converted_count} accent={STATUS.good} />
            <StatCard
              label="Conversion Rate"
              value={totalRow.total_leads ? `${((totalRow.converted_count / totalRow.total_leads) * 100).toFixed(1)}%` : '—'}
            />
          </div>

          {/* ── Detailed summary ──────────────────────────────────────── */}
          {/* Always rendered, no disclosure: this is the table people work
              from. Branch rows show expanded by default and Source ▸ Assignee
              stay collapsed, which is just what an empty openBranches gives. */}
          <DrillDownTable
            rows={drillRows}
            branchRooted={branchRooted}
            totalRow={branchRooted ? totalRow : null}
            anyOpen={anyOpen}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
            onToggle={(key, depth) => (branchRooted && depth === 0 ? toggleBranch(key) : toggleSource(key))}
          />

          {/* ── Charts ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="By Source" subtitle="Share of total leads">
              <SourcePieChart rows={sourceRows} />
            </ChartCard>
            <ChartCard title="Status Breakdown" subtitle="Where leads stand right now">
              <StatusBarChart row={totalRow} />
            </ChartCard>
          </div>

          <PipelineTable pipeline={pipeline} />

          {isTenantWide && (
            <ChartCard title="By Branch" subtitle="Total leads per branch">
              <BranchBarChart rows={branchRows} />
            </ChartCard>
          )}
        </>
      )}
    </div>
  );
}

// ── Charts ─────────────────────────────────────────────────────────────────

function SourcePieChart({ rows }: { rows: SourceBranchRow[] }) {
  const bySource = new Map<string, number>();
  for (const r of rows) bySource.set(r.source_label, (bySource.get(r.source_label) ?? 0) + r.total_leads);
  const data = [...bySource.entries()]
    .map(([name, value]) => ({ name, value }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  if (!data.length) return <EmptyChart />;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={SERIES[i % SERIES.length]} stroke={INK.surface} strokeWidth={2} />
          ))}
        </Pie>
        <Legend wrapperStyle={{ fontSize: 11, color: INK.secondary }} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: INK.grid }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function StatusBarChart({ row }: { row: BranchReportRow }) {
  const data = [
    { name: 'New', value: row.new_count, fill: SERIES[0] },
    { name: 'Unassigned', value: row.unassigned_count, fill: STATUS.warning },
    { name: 'Follow-up Due', value: row.followup_scheduled, fill: SERIES[6] },
    { name: 'Follow-up Overdue', value: row.followup_overdue, fill: STATUS.serious },
    { name: 'Converted', value: row.converted_count, fill: STATUS.good },
    { name: 'Unqualified', value: row.unqualified_count, fill: STATUS.critical },
  ];

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={INK.grid} vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: INK.muted }} interval={0} angle={-20} textAnchor="end" height={50} />
        <YAxis tick={{ fontSize: 10, fill: INK.muted }} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: INK.grid }} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function BranchBarChart({ rows }: { rows: BranchReportRow[] }) {
  const data = rows.map((r) => ({ name: r.org_name, value: r.total_leads }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={INK.grid} horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10, fill: INK.muted }} allowDecimals={false} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: INK.secondary }} width={140} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: INK.grid }} />
        <Bar dataKey="value" fill={SERIES[0]} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function EmptyChart() {
  return <div className="flex h-[260px] items-center justify-center text-xs text-[#64748B]">No data yet.</div>;
}

// ── Cards & tables ───────────────────────────────────────────────────────────

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="border-b border-[#F1F5F9] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{title}</h3>
        <p className="text-[11px] text-[#94A3B8]">{subtitle}</p>
      </div>
      <div className="px-3 py-3">{children}</div>
    </div>
  );
}

/**
 * One rendered line of the Branch ▸ Source ▸ Assignee tree, already flattened.
 * `key` is the full path, so two different branches' "Facebook" rows are
 * distinct rows with distinct React keys and independent expand state.
 */
interface DrillRow {
  key: string;
  depth: 0 | 1 | 2;
  label: string;
  metrics?: LeadReportMetrics;
  expandable?: boolean;
  isOpen?: boolean;
  muted?: boolean;
  hideUnassigned?: boolean;
  placeholder?: boolean;
}

// Depth carried by indent + ground tint on one shared column grid, rather than
// nested tables with their own headers (which is why the old child tables'
// columns didn't line up with their parent's).
const DEPTH_PAD = ['pl-4', 'pl-9', 'pl-14'] as const;
const DEPTH_BG = ['bg-white', 'bg-[#F8FAFC]', 'bg-[#F1F5F9]'] as const;

function PendingBadge({ pct }: { pct: number | null }) {
  const band = pendingActionBand(pct);
  if (pct === null || !band) return <span className="text-[#CBD5E1]">—</span>;
  return (
    <span
      className="inline-flex min-w-[34px] items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: band.bg, color: band.text }}
    >
      {pct}%
    </span>
  );
}

function DrillDownTable({
  rows, branchRooted, totalRow, anyOpen, onExpandAll, onCollapseAll, onToggle,
}: {
  rows: DrillRow[];
  branchRooted: boolean;
  /** The ALL BRANCHES rollup, pinned below the tree. Null when there is no
   *  branch level to total (a single-branch actor), where it would just restate
   *  the one row above it. */
  totalRow: BranchReportRow | null;
  anyOpen: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onToggle: (key: string, depth: 0 | 1 | 2) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-[#F1F5F9] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">
          {branchRooted ? 'By Branch → Source → Assignee' : 'By Source → Assignee'}
        </h3>
        {rows.length > 0 && (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={onExpandAll}
              className="rounded-md border border-[#E2E8F0] px-2 py-1 text-[11px] font-semibold text-[#475569] hover:border-[#2a78d6] hover:text-[#2a78d6]"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={onCollapseAll}
              disabled={!anyOpen}
              className="rounded-md border border-[#E2E8F0] px-2 py-1 text-[11px] font-semibold text-[#475569] hover:border-[#2a78d6] hover:text-[#2a78d6] disabled:cursor-default disabled:opacity-40 disabled:hover:border-[#E2E8F0] disabled:hover:text-[#475569]"
            >
              Collapse all
            </button>
          </div>
        )}
      </div>
      {!rows.length ? (
        <p className="px-4 py-6 text-center text-xs text-[#94A3B8]">No data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] text-left text-[10px] font-semibold uppercase tracking-wide text-[#64748B]">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">New</th>
                <th className="px-3 py-2 text-right">Unassigned</th>
                <th className="px-3 py-2 text-right">FollowUp Scheduled</th>
                <th className="px-3 py-2 text-right">Overdue</th>
                <th className="px-3 py-2 text-right">Converted</th>
                <th className="px-3 py-2 text-right">Unqualified</th>
                <th className="px-3 py-2 text-right">Pending Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {rows.map((r) => {
                if (r.placeholder) {
                  return (
                    <tr key={r.key} className={DEPTH_BG[r.depth]}>
                      <td colSpan={9} className={`${DEPTH_PAD[r.depth]} py-2 text-xs italic text-[#94A3B8]`}>
                        {r.label}
                      </td>
                    </tr>
                  );
                }
                const m = r.metrics!;
                return (
                  <tr
                    key={r.key}
                    className={`text-[#0F172A] ${DEPTH_BG[r.depth]} ${r.expandable ? 'cursor-pointer hover:brightness-[0.97]' : ''}`}
                    onClick={r.expandable ? () => onToggle(r.key, r.depth) : undefined}
                    {...(r.expandable
                      ? { role: 'button', tabIndex: 0, 'aria-expanded': !!r.isOpen }
                      : {})}
                    onKeyDown={r.expandable
                      ? (e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        onToggle(r.key, r.depth);
                      }
                      : undefined}
                  >
                    <td className={`${DEPTH_PAD[r.depth]} py-2 pr-4 ${r.depth === 0 ? 'font-semibold' : 'font-medium'}`}>
                      <span className="flex items-center gap-1.5">
                        <svg
                          className={`h-3 w-3 shrink-0 text-[#94A3B8] transition-transform ${r.isOpen ? 'rotate-90' : ''} ${r.expandable ? '' : 'invisible'}`}
                          viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
                        >
                          <path fillRule="evenodd" d="M7.21 5.23a.75.75 0 011.06-.02l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.04-1.08L11.17 10 7.23 6.29a.75.75 0 01-.02-1.06z" clipRule="evenodd" />
                        </svg>
                        <span className={r.muted ? 'italic text-[#94A3B8]' : ''}>{r.label}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{m.total_leads}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{m.new_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">
                      {r.hideUnassigned ? <span className="text-[#CBD5E1]">—</span> : m.unassigned_count}
                    </td>
                    {/* No hideUnassigned equivalent: unlike unassigned_count,
                        followup_scheduled stays a real measurement per assignee. */}
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{m.followup_scheduled}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{m.followup_overdue}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{m.converted_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{m.unqualified_count}</td>
                    <td className="px-3 py-2 text-right"><PendingBadge pct={pendingActionPct(m)} /></td>
                  </tr>
                );
              })}
            </tbody>
            {/* Outside the tbody map, so expand/collapse never moves or hides
                it — the rollup is a property of the whole window, not of the
                tree's current state. */}
            {totalRow && (
              <tfoot>
                <tr className="border-t-2 border-[#CBD5E1] bg-white font-semibold text-[#0F172A]">
                  <td className="px-4 py-2.5">{totalRow.org_name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.total_leads}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.new_count}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.unassigned_count}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.followup_scheduled}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.followup_overdue}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.converted_count}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totalRow.unqualified_count}</td>
                  <td className="px-3 py-2.5 text-right"><PendingBadge pct={pendingActionPct(totalRow)} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

// StatusSummaryTable used to sit beside the drill-down for single-branch
// actors. It was the same numbers as the Status Breakdown chart, which now
// renders directly below the table for every actor, so it was dropped rather
// than shown twice.

// Mirrors the filter styling in leads-history/LeadsHistoryShell.tsx, where both
// are module-local. Restated rather than exported from there: this file already
// keeps its own copy of PENDING_ACTION_BANDS for the same reason, and a shared
// UI kit for two call sites isn't worth the coupling yet.
const inputCls =
  'rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-xs text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20';

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8]">{label}</span>
      {children}
    </div>
  );
}

function PipelineTable({ pipeline }: { pipeline: PipelineStage[] }) {
  if (!pipeline.length) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="border-b border-[#F1F5F9] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Pipeline by Stage</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-[#F8FAFC] text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
          <tr>
            <th className="px-4 py-2.5">Stage</th>
            <th className="px-4 py-2.5 text-right">Count</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#F1F5F9]">
          {pipeline.map((s) => (
            <tr key={s.stage} className="text-[#0F172A]">
              <td className="px-4 py-2.5">{s.stage_label}</td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{s.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-[#E2E8F0] bg-white px-3 py-3 shadow-sm">
      <span className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-widest text-[#64748B]">
        {accent && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />}
        {label}
      </span>
      <span className="text-xl font-bold tabular-nums text-[#0F172A]">{value}</span>
    </div>
  );
}
