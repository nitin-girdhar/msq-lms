'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
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
import type { BranchReportRow, SourceBranchRow, UserReportRow } from '../../types/analytics';

interface Props {
  actorRank: number;
  orgId: string;
}

interface PipelineStage {
  stage: string;
  stageLabel: string;
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

export default function AnalyticsClient(_props: Props) {
  const { data: pipelineData, isLoading: pipelineLoading } = useSWR('analytics/pipeline', () => analytics.pipeline(), {
    revalidateOnFocus: false,
  });
  const { data: branchData, isLoading: branchLoading } = useSWR('analytics/report/branches', () => analytics.branchReport(), {
    revalidateOnFocus: false,
  });
  const { data: sourceData, isLoading: sourceLoading } = useSWR('analytics/report/sources', () => analytics.sourceReport(), {
    revalidateOnFocus: false,
  });
  // Not folded into the main `isLoading` gate below — it only backs the branch
  // drill-down, so the rest of the page shouldn't wait on it.
  const { data: userData } = useSWR('analytics/report/users', () => analytics.userReport(), {
    revalidateOnFocus: false,
  });

  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);

  const isLoading = pipelineLoading || branchLoading || sourceLoading;
  const pipeline = (pipelineData?.data ?? []) as PipelineStage[];
  const branches = (branchData?.data ?? []) as BranchReportRow[];
  const sourceBranches = (sourceData?.data?.branches ?? []) as SourceBranchRow[];
  const userRows = (userData?.data ?? []) as UserReportRow[];

  const isTenantWide = branches.length > 1 || branches.some((b) => b.is_total);
  const totalRow = branches.find((b) => b.is_total) ?? branches[0] ?? null;
  const branchRows = branches.filter((b) => !b.is_total);
  const sourceRows = sourceBranches.filter((s) => !s.is_total);

  // Per-branch user breakdown for the "By Branch" table's expand row. Keyed by
  // org_name (the id the branch SummaryTable rows use as their identity, since
  // BranchReportRow's org_id can be null on the rollup row branchRows already
  // excludes).
  const usersByBranch = useMemo(() => {
    const m = new Map<string, UserReportRow[]>();
    for (const u of userRows) {
      const list = m.get(u.org_name);
      if (list) list.push(u);
      else m.set(u.org_name, [u]);
    }
    return m;
  }, [userRows]);

  const sourceSummaryRows = useMemo(
    () => sourceRows.map((s) => ({
      key: s.source_id ?? s.source_label,
      label: s.source_label,
      total: s.total_leads,
      neew: s.new_count,
      unassigned: s.unassigned_count,
      overdue: s.followup_overdue,
      converted: s.converted_count,
      unqualified: s.unqualified_count,
      pendingPct: pendingActionPct(s),
    })),
    [sourceRows],
  );

  const branchSummaryRows = useMemo(
    () => branchRows.map((b) => ({
      key: b.org_name,
      label: b.org_name,
      total: b.total_leads,
      neew: b.new_count,
      unassigned: b.unassigned_count,
      overdue: b.followup_overdue,
      converted: b.converted_count,
      unqualified: b.unqualified_count,
      pendingPct: pendingActionPct(b),
    })),
    [branchRows],
  );

  return (
    <div className="space-y-8 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0F172A]">Analytics</h1>
        <p className="mt-1 text-xs text-[#64748B]">
          Lead performance {isTenantWide ? 'across every branch' : 'for your organisation'} — by source, by branch, and by status.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-[#64748B]">Loading…</div>
      ) : !totalRow ? (
        <p className="text-sm text-[#64748B]">No data available.</p>
      ) : (
        <>
          {/* ── KPI strip ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <StatCard label="Total Leads" value={totalRow.total_leads} />
            <StatCard label="New This Month" value={totalRow.new_leads_this_month} accent={STATUS.good} />
            <StatCard label="New Today" value={totalRow.new_leads_today} accent={STATUS.good} />
            <StatCard label="Unassigned" value={totalRow.unassigned_count} accent={STATUS.warning} />
            <StatCard label="Follow-up Overdue" value={totalRow.followup_overdue} accent={STATUS.critical} />
            <StatCard label="Converted" value={totalRow.converted_count} accent={STATUS.good} />
            <StatCard
              label="Conversion Rate"
              value={totalRow.total_leads ? `${((totalRow.converted_count / totalRow.total_leads) * 100).toFixed(1)}%` : '—'}
            />
          </div>

          {/* ── Charts ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard title="By Source" subtitle="Share of total leads">
              <SourcePieChart rows={sourceRows} />
            </ChartCard>
            <ChartCard title="Status Breakdown" subtitle="Where leads stand right now">
              <StatusBarChart row={totalRow} />
            </ChartCard>
          </div>

          {isTenantWide && branchRows.length > 1 && (
            <ChartCard title="By Branch" subtitle="Total leads per branch">
              <BranchBarChart rows={branchRows} />
            </ChartCard>
          )}

          {/* ── Detailed summary grid ────────────────────────────────── */}
          <div>
            <h2 className="mb-3 text-sm font-semibold text-[#0F172A]">Detailed Summary</h2>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <SummaryTable title="By Source" rows={sourceSummaryRows} />
              {isTenantWide && branchRows.length > 1 ? (
                <SummaryTable
                  title="By Branch"
                  rows={branchSummaryRows}
                  expandedKey={expandedBranch}
                  onToggleExpand={(key) => setExpandedBranch((cur) => (cur === key ? null : key))}
                  renderExpanded={(key) => <BranchUsersTable users={usersByBranch.get(key) ?? []} />}
                />
              ) : (
                <StatusSummaryTable row={totalRow} />
              )}
            </div>
          </div>

          <PipelineTable pipeline={pipeline} />
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

interface SummaryRow {
  key: string;
  label: string;
  total: number;
  neew: number;
  unassigned: number;
  overdue: number;
  converted: number;
  unqualified: number;
  pendingPct: number | null;
}

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

function SummaryTable({
  title, rows, expandedKey, onToggleExpand, renderExpanded,
}: {
  title: string;
  rows: SummaryRow[];
  expandedKey?: string | null;
  onToggleExpand?: (key: string) => void;
  renderExpanded?: (key: string) => ReactNode;
}) {
  if (!rows.length) return null;
  const expandable = !!onToggleExpand;
  return (
    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="border-b border-[#F1F5F9] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#F8FAFC] text-left text-[10px] font-semibold uppercase tracking-wide text-[#64748B]">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">New</th>
              <th className="px-3 py-2 text-right">Unassigned</th>
              <th className="px-3 py-2 text-right">Overdue</th>
              <th className="px-3 py-2 text-right">Converted</th>
              <th className="px-3 py-2 text-right">Unqualified</th>
              <th className="px-3 py-2 text-right">Pending Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1F5F9]">
            {rows.map((r) => {
              const isOpen = expandable && expandedKey === r.key;
              return (
                <Fragment key={r.key}>
                  <tr
                    className={`text-[#0F172A] ${expandable ? 'cursor-pointer hover:bg-[#F8FAFC]' : ''}`}
                    onClick={expandable ? () => onToggleExpand!(r.key) : undefined}
                  >
                    <td className="px-4 py-2 font-medium">
                      <span className="flex items-center gap-1.5">
                        {expandable && (
                          <svg
                            className={`h-3 w-3 shrink-0 text-[#94A3B8] transition-transform ${isOpen ? 'rotate-90' : ''}`}
                            viewBox="0 0 20 20" fill="currentColor"
                          >
                            <path fillRule="evenodd" d="M7.21 5.23a.75.75 0 011.06-.02l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.04-1.08L11.17 10 7.23 6.29a.75.75 0 01-.02-1.06z" clipRule="evenodd" />
                          </svg>
                        )}
                        {r.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.total}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{r.neew}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{r.unassigned}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{r.overdue}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{r.converted}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{r.unqualified}</td>
                    <td className="px-3 py-2 text-right"><PendingBadge pct={r.pendingPct} /></td>
                  </tr>
                  {isOpen && renderExpanded && (
                    <tr key={`${r.key}-expanded`}>
                      <td colSpan={8} className="bg-[#F8FAFC] p-0">
                        {renderExpanded(r.key)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BranchUsersTable({ users }: { users: UserReportRow[] }) {
  if (!users.length) {
    return <p className="px-4 py-3 text-xs text-[#94A3B8]">No leads assigned in this branch.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8]">
        <tr>
          <th className="px-4 py-1.5 pl-9">Assignee</th>
          <th className="px-3 py-1.5 text-right">Total</th>
          <th className="px-3 py-1.5 text-right">New</th>
          <th className="px-3 py-1.5 text-right">Overdue</th>
          <th className="px-3 py-1.5 text-right">Converted</th>
          <th className="px-3 py-1.5 text-right">Pending Action</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#E2E8F0]">
        {users.map((u) => (
          <tr key={u.assigned_user_id ?? 'unassigned'} className="text-[#0F172A]">
            <td className="px-4 py-1.5 pl-9 font-medium">
              {u.is_unassigned
                ? <span className="italic text-[#94A3B8]">Unassigned</span>
                : u.assignee}
            </td>
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{u.total_leads}</td>
            <td className="px-3 py-1.5 text-right tabular-nums text-[#64748B]">{u.new_count}</td>
            <td className="px-3 py-1.5 text-right tabular-nums text-[#64748B]">{u.followup_overdue}</td>
            <td className="px-3 py-1.5 text-right tabular-nums text-[#64748B]">{u.converted_count}</td>
            <td className="px-3 py-1.5 text-right"><PendingBadge pct={pendingActionPct(u)} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusSummaryTable({ row }: { row: BranchReportRow }) {
  const items: Array<{ label: string; value: number; accent: string }> = [
    { label: 'Total Leads', value: row.total_leads, accent: INK.primary },
    { label: 'New', value: row.new_count, accent: SERIES[0] },
    { label: 'New Today', value: row.new_leads_today, accent: SERIES[0] },
    { label: 'Unassigned', value: row.unassigned_count, accent: STATUS.warning },
    { label: 'Follow-up Scheduled', value: row.followup_scheduled, accent: SERIES[6] },
    { label: 'Follow-up Overdue', value: row.followup_overdue, accent: STATUS.serious },
    { label: 'Converted', value: row.converted_count, accent: STATUS.good },
    { label: 'Unqualified', value: row.unqualified_count, accent: STATUS.critical },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="border-b border-[#F1F5F9] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Status Breakdown</h3>
      </div>
      <div className="divide-y divide-[#F1F5F9]">
        {items.map((it) => (
          <div key={it.label} className="flex items-center justify-between px-4 py-2">
            <span className="flex items-center gap-2 text-sm text-[#0F172A]">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: it.accent }} />
              {it.label}
            </span>
            <span className="text-sm font-semibold tabular-nums text-[#0F172A]">{it.value}</span>
          </div>
        ))}
      </div>
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
              <td className="px-4 py-2.5">{s.stageLabel}</td>
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
