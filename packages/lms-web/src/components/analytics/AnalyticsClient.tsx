'use client';

import useSWR from 'swr';
import { analytics } from '../../lib/api/client';

interface Props {
  actorRank: number;
  orgId: string;
}

interface OrgSnapshot {
  orgId: string;
  orgName: string;
  totalLeads: number;
  activeLeads: number;
  convertedLeads: number;
  conversionRate: number | null;
  assignedLeads: number;
  unassignedLeads: number;
}

interface TenantRow {
  tenantId: string;
  tenantName: string;
  totalOrgs: number;
  totalLeads: number;
  convertedLeads: number;
  conversionRate: number | null;
}

interface PipelineStage {
  stage: string;
  stageLabel: string;
  count: number;
}

export default function AnalyticsClient({ actorRank, orgId }: Props) {
  const { data, isLoading } = useSWR('analytics/dashboard', () => analytics.dashboard(), {
    revalidateOnFocus: false,
  });

  const { data: pipelineData } = useSWR('analytics/pipeline', () => analytics.pipeline(), {
    revalidateOnFocus: false,
  });

  const isTenantAdmin = actorRank >= 90;
  const pipeline = (pipelineData?.data ?? []) as PipelineStage[];
  const dashboardData = data?.data;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0F172A]">Analytics</h1>
        <p className="mt-1 text-xs text-[#64748B]">Performance overview for your organisation</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-[#64748B]">
          Loading…
        </div>
      ) : isTenantAdmin ? (
        <TenantView rows={(dashboardData ?? []) as TenantRow[]} pipeline={pipeline} />
      ) : (
        <OrgView snapshot={dashboardData as OrgSnapshot | null} pipeline={pipeline} />
      )}
    </div>
  );
}

function OrgView({
  snapshot,
  pipeline,
}: {
  snapshot: OrgSnapshot | null;
  pipeline: PipelineStage[];
}) {
  if (!snapshot) return <p className="text-sm text-[#64748B]">No data available.</p>;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-[#0F172A]">{snapshot.orgName} Overview</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total Leads" value={snapshot.totalLeads} />
        <StatCard label="Active" value={snapshot.activeLeads} />
        <StatCard label="Converted" value={snapshot.convertedLeads} />
        <StatCard
          label="Conversion Rate"
          value={snapshot.conversionRate !== null ? `${(snapshot.conversionRate * 100).toFixed(1)}%` : '—'}
        />
        <StatCard label="Assigned" value={snapshot.assignedLeads} />
        <StatCard label="Unassigned" value={snapshot.unassignedLeads} />
      </div>
      <PipelineTable pipeline={pipeline} />
    </div>
  );
}

function TenantView({
  rows,
  pipeline,
}: {
  rows: TenantRow[];
  pipeline: PipelineStage[];
}) {
  const first = rows[0];
  if (!first) return <p className="text-sm text-[#64748B]">No tenant data available.</p>;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-[#0F172A]">{first.tenantName} — Tenant Overview</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Organisations" value={first.totalOrgs} />
        <StatCard label="Total Leads" value={first.totalLeads} />
        <StatCard label="Converted" value={first.convertedLeads} />
        <StatCard
          label="Conversion Rate"
          value={first.conversionRate !== null ? `${(first.conversionRate * 100).toFixed(1)}%` : '—'}
        />
      </div>
      <PipelineTable pipeline={pipeline} />
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

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-[#E2E8F0] bg-white px-3 py-3 shadow-sm">
      <span className="text-[9px] font-semibold uppercase tracking-widest text-[#64748B]">{label}</span>
      <span className="text-xl font-bold tabular-nums text-[#0F172A]">{value}</span>
    </div>
  );
}
