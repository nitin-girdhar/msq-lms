'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionUser } from '@crm/types';
import type { AssignmentView } from '../../types/leads';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import AssigneeBadge from './AssigneeBadge';
import AssignLeadModal from './AssignLeadModal';
import {
  DownloadButton,
  buildFilename,
  exportRows,
  type ExportColumn,
  type ExportRowsFormat as ExportFormat,
} from '@platform/ui-kit';

const ASSIGNMENT_EXPORT_COLUMNS: ExportColumn<AssignmentView>[] = [
  { header: 'Lead ID', value: (a) => a.lead_id },
  { header: 'Name', value: (a) => a.lead_full_name ?? '' },
  { header: 'Phone', value: (a) => a.lead_phone ?? '' },
  { header: 'Branch', value: (a) => a.branch },
  { header: 'Stage', value: (a) => a.lead_stage ?? '' },
  { header: 'Assigned To', value: (a) => a.assigned_rep_name ?? a.assigned_rep_email ?? '' },
  { header: 'Assignee Email', value: (a) => a.assigned_rep_email ?? '' },
  { header: 'Assigned At', value: (a) => formatDate(a.assigned_at) },
];

interface Props {
  actor: SessionUser;
  assignments: AssignmentView[];
  candidates: SessionUser[];
  title?: string;
  subtitle?: string;
  hideCreate?: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const [date, time] = d.toISOString().split('T');
  return `${date} ${time.slice(0, 5)}`;
}

export default function AssignmentsClient({ actor, assignments, candidates, title = 'Assignments', subtitle, hideCreate }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AssignmentView | null>(null);
  const [search, setSearch] = useState('');

  useRealtimeEvents(actor.id, {
    onLeadCreated: () => router.refresh(),
    onLeadUpdated: () => router.refresh(),
    onLeadDeleted: () => router.refresh(),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assignments;
    return assignments.filter((a) => {
      const hay = `${a.lead_full_name ?? ''} ${a.lead_phone ?? ''} ${a.branch} ${a.assigned_rep_email ?? ''} ${a.assigned_rep_name ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [assignments, search]);

  const exportAssignments = (format: ExportFormat) => {
    exportRows(filtered, ASSIGNMENT_EXPORT_COLUMNS, buildFilename(['assignments']), format);
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A]">{title}</h1>
          <p className="mt-1 text-xs text-[#64748B]">
            {subtitle ?? `${assignments.length} active · server-side branch + role enforcement`}
          </p>
        </div>
        {!hideCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#095699]"
          >
            New assignment
          </button>
        )}
      </div>

      <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-[#F1F5F9] p-3 sm:p-4">
          <input
            type="search"
            placeholder="Search name, phone, branch, or assigned to…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-[200px] flex-1 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
          />
          <span className="ml-auto text-xs text-[#64748B]">
            {filtered.length} of {assignments.length}
          </span>
          <DownloadButton onExport={exportAssignments} rowCount={filtered.length} />
        </div>

        {/* Desktop table */}
        <div className="hidden md:block">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
              <tr>
                <th className="px-4 py-2.5">Lead</th>
                <th className="px-4 py-2.5">Branch</th>
                <th className="px-4 py-2.5">Assigned To</th>
                <th className="px-4 py-2.5">Assigned at</th>
                <th className="px-4 py-2.5">Duplicate Lead</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {filtered.map((a) => (
                <tr key={a.id} className="text-[#0F172A]">
                  <td className="px-4 py-2.5">
                    <p className="text-sm font-semibold">{a.lead_full_name ?? '—'}</p>
                    {a.lead_phone && <p className="text-[11px] text-[#64748B]">{a.lead_phone}</p>}
                  </td>
                  <td className="px-4 py-2.5 text-[#475569]">{a.branch}</td>
                  <td className="px-4 py-2.5">
                    <AssigneeBadge
                      user={
                        a.assigned_rep_name || a.assigned_rep_email
                          ? { name: a.assigned_rep_name, email: a.assigned_rep_email ?? '' }
                          : null
                      }
                    />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[#64748B]">
                    {formatDate(a.assigned_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    {a.superseded_by ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
                        Superseded
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(a)}
                      className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC]"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-[#64748B]">
                    No assignments match the search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <ul className="divide-y divide-[#F1F5F9] md:hidden">
          {filtered.map((a) => (
            <li key={a.id} className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#0F172A]">{a.lead_full_name ?? '—'}</p>
                  {a.lead_phone && <p className="text-xs text-[#64748B]">{a.lead_phone}</p>}
                  <p className="text-xs text-[#475569]">Branch: {a.branch}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(a)}
                  className="shrink-0 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1 text-xs font-semibold text-[#475569]"
                >
                  Edit
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <AssigneeBadge
                  user={
                    a.assigned_rep_name || a.assigned_rep_email
                      ? { name: a.assigned_rep_name, email: a.assigned_rep_email ?? '' }
                      : null
                  }
                />
                <span className="text-[11px] text-[#94A3B8]">
                  {formatDate(a.assigned_at)}
                </span>
              </div>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-[#64748B]">
              No assignments match the search.
            </li>
          )}
        </ul>
      </div>

      <AssignLeadModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        actor={actor}
        candidates={candidates}
      />

      {editing && (
        <AssignLeadModal
          open={editing !== null}
          onClose={() => setEditing(null)}
          actor={actor}
          candidates={candidates}
          existing={editing}
        />
      )}
    </div>
  );
}
