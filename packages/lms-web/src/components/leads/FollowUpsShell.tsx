'use client';

import '@platform/ui-kit/ag-grid.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { SessionUser } from '@crm/types';
import type { LeadView } from '../../types/leads';
import { followUps as followUpsApi, leads as leadsApi } from '../../lib/api/client';
import { LeadHistoryModal } from '../LeadHistoryModal';
import { LeadEditModal } from './LeadEditModal';
import { useLeadEditData } from '../../hooks/useLeadEditData';
import {
  DownloadButton,
  buildFilename,
  exportRows,
  type ExportColumn,
  type ExportRowsFormat as ExportFormat,
} from '@platform/ui-kit';

ModuleRegistry.registerModules([AllCommunityModule]);

interface FollowUpItem {
  followUpId: string | null;
  leadId: string;
  leadFullName: string;
  leadPhone: string | null;
  leadStage: string;
  assignedRepName: string;
  assignedRepEmail: string;
  isOverdue: boolean | null;
  minutesOverdue: number | null;
  followUpStatus: string | null;
  scheduledAt: string | null;
  lastInteractionAt: string | null;
  lastInteractionType: string | null;
  notes: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function overdueDuration(mins: number): string {
  if (mins < 60) return `${mins}m overdue`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m overdue`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h overdue`;
}

const EXPORT_COLS: ExportColumn<FollowUpItem>[] = [
  { header: 'Lead', value: (f) => f.leadFullName },
  { header: 'Phone', value: (f) => f.leadPhone ?? '' },
  { header: 'Stage', value: (f) => f.leadStage.replace(/_/g, ' ') },
  { header: 'Assigned To', value: (f) => f.assignedRepName },
  { header: 'Email', value: (f) => f.assignedRepEmail },
  { header: 'Status', value: (f) => f.followUpStatus },
  { header: 'Scheduled', value: (f) => (f.scheduledAt ? formatDate(f.scheduledAt) : 'Not scheduled') },
  { header: 'Notes', value: (f) => f.notes ?? '' },
];

interface Props { actor: SessionUser; embedded?: boolean }

export default function FollowUpsShell({ actor, embedded }: Props) {
  const [all, setAll] = useState<FollowUpItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyItem, setHistoryItem] = useState<FollowUpItem | null>(null);
  const [editingLead, setEditingLead] = useState<LeadView | null>(null);

  const editData = useLeadEditData(actor);

  const isSalesRep = actor.role === 'sales_representative';

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: { assignedRepId?: string } = {};
    if (isSalesRep) params.assignedRepId = actor.id;
    followUpsApi.list(params)
      .then((body) => {
        const data = (body.data ?? body.pipeline ?? []) as FollowUpItem[];
        setAll(data);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [isSalesRep, actor.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleEdit = useCallback(async (item: FollowUpItem) => {
    try {
      const res = await leadsApi.get(item.leadId);
      setEditingLead(res.data);
    } catch {
      // Lead fetch failed — silently ignore
    }
  }, []);

  const upcoming = useMemo(
    () => all.filter((f) => f.isOverdue === false).sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()),
    [all],
  );
  const missed = useMemo(
    () => all.filter((f) => f.isOverdue === true).sort((a, b) => (b.minutesOverdue ?? 0) - (a.minutesOverdue ?? 0)),
    [all],
  );
  return (
    <div className={embedded ? 'w-full space-y-3' : 'w-full space-y-6 px-3 py-4 sm:px-4'}>
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A]">Follow-Up Pipeline</h1>
          <p className="mt-1 text-sm text-[#64748B]">
            {isSalesRep ? 'Your pending and missed follow-ups' : 'All pending and missed follow-ups across the org'}
          </p>
        </div>
      )}

      {loading && <div className="flex items-center justify-center py-16 text-sm text-[#94A3B8]">Loading…</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}

      {!loading && !error && (
        <>
          <section>
            <div className={`flex items-center justify-between ${embedded ? 'mb-1.5' : 'mb-3'}`}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#0b6cbf]">Upcoming ({upcoming.length})</h2>
              <DownloadButton onExport={(fmt) => exportRows(upcoming, EXPORT_COLS, buildFilename(['upcoming-followups']), fmt)} rowCount={upcoming.length} />
            </div>
            {upcoming.length > 0 ? (
              <FollowUpGrid items={upcoming} onEdit={handleEdit} onHistory={setHistoryItem} type="upcoming" />
            ) : (
              <p className="py-8 text-center text-sm text-[#94A3B8]">No upcoming follow-ups.</p>
            )}
          </section>

          <section>
            <div className={`flex items-center justify-between ${embedded ? 'mb-1.5' : 'mb-3'}`}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600">Missed / Overdue ({missed.length})</h2>
              <DownloadButton onExport={(fmt) => exportRows(missed, EXPORT_COLS, buildFilename(['missed-followups']), fmt)} rowCount={missed.length} />
            </div>
            {missed.length > 0 ? (
              <FollowUpGrid items={missed} onEdit={handleEdit} onHistory={setHistoryItem} type="missed" />
            ) : (
              <p className="py-8 text-center text-sm text-[#94A3B8]">No missed follow-ups.</p>
            )}
          </section>
        </>
      )}

      {historyItem && (
        <LeadHistoryModal lead={{ lead_id: historyItem.leadId }} onClose={() => setHistoryItem(null)} />
      )}

      {editingLead && (
        <LeadEditModal
          lead={editingLead}
          statusOptions={editData.statusOptions}
          statusLabelMap={editData.statusLabelMap}
          followUpSet={editData.followUpSet}
          rejectionSet={editData.rejectionSet}
          stageOutcomes={editData.stageOutcomes}
          stageIdToName={editData.stageIdToName}
          candidates={editData.candidates}
          actor={actor}
          onUpdate={async (payload) => { await editData.updateLead(payload); fetchData(); }}
          onAssignmentChanged={fetchData}
          onClose={() => setEditingLead(null)}
        />
      )}
    </div>
  );
}

function FollowUpGrid({ items, onEdit, onHistory, type }: { items: FollowUpItem[]; onEdit: (f: FollowUpItem) => void; onHistory: (f: FollowUpItem) => void; type: 'upcoming' | 'missed' }) {
  const gridRef = useRef<AgGridReact>(null);
  const isMissed = type === 'missed';

  const columnDefs = useMemo((): ColDef<FollowUpItem>[] => [
    {
      headerName: 'Lead', field: 'leadFullName', flex: 2, minWidth: 150, filter: true, sortable: true,
      cellRenderer: (p: ICellRendererParams<FollowUpItem>) => {
        if (!p.data) return null;
        return (
          <div>
            <p className="text-sm font-semibold">{p.data.leadFullName}</p>
            {p.data.leadPhone && <p className="text-[11px] text-[#64748B]">{p.data.leadPhone}</p>}
          </div>
        );
      },
    },
    {
      headerName: 'Stage', field: 'leadStage', flex: 1, minWidth: 100, filter: true, sortable: true,
      valueFormatter: (p) => p.value?.replace(/_/g, ' ') ?? '',
    },
    {
      headerName: 'Assigned To', field: 'assignedRepName', flex: 2, minWidth: 140, filter: true, sortable: true,
      cellRenderer: (p: ICellRendererParams<FollowUpItem>) => {
        if (!p.data) return null;
        return (
          <div>
            <p className="text-sm">{p.data.assignedRepName}</p>
            <p className="text-[11px] text-[#64748B]">{p.data.assignedRepEmail}</p>
          </div>
        );
      },
    },
    {
      headerName: isMissed ? 'Overdue' : 'Due In', flex: 1, minWidth: 120, filter: false, sortable: true,
      valueGetter: (p) => p.data?.minutesOverdue ?? 0,
      cellRenderer: (p: ICellRendererParams<FollowUpItem>) => {
        if (!p.data) return null;
        return isMissed
          ? <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">{overdueDuration(p.data.minutesOverdue ?? 0)}</span>
          : <span className="inline-block rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-[#0b6cbf]">{timeUntil(p.data.scheduledAt!)}</span>;
      },
    },
    {
      headerName: 'Scheduled', flex: 1, minWidth: 150, filter: true, sortable: true,
      valueGetter: (p) => p.data?.scheduledAt ? new Date(p.data.scheduledAt) : null,
      valueFormatter: (p) => p.value ? formatDate(p.value) : '—',
    },
    {
      headerName: 'Notes', field: 'notes', flex: 2, minWidth: 120, filter: true, sortable: false,
      valueFormatter: (p) => p.value ?? '—',
    },
    {
      headerName: '', width: 100, minWidth: 100, maxWidth: 100, sortable: false, filter: false, resizable: false, pinned: 'right',
      cellRenderer: (p: ICellRendererParams<FollowUpItem>) => {
        if (!p.data) return null;
        return (
          <div className="flex items-center gap-1.5">
            <button type="button" title="Edit" onClick={() => onEdit(p.data!)}
              className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-1.5 text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf]">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button type="button" title="View History" onClick={() => onHistory(p.data!)}
              className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-1.5 text-[#475569] transition-colors hover:border-[#7C3AED] hover:text-[#7C3AED]">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </div>
        );
      },
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
    },
  ], [isMissed, onEdit, onHistory]);

  const defaultColDef: ColDef = useMemo(() => ({
    resizable: true,
    cellStyle: { fontSize: '13px', color: '#0F172A' },
  }), []);

  const getRowClass = useCallback(() => isMissed ? 'bg-red-50/50' : '', [isMissed]);

  return (
    <div className="ag-theme-alpine min-w-0 w-full overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <AgGridReact<FollowUpItem>
        ref={gridRef}
        rowData={items}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        domLayout="autoHeight"
        autoSizeStrategy={{ type: 'fitGridWidth' }}
        pagination
        paginationPageSize={5}
        paginationPageSizeSelector={[5, 10, 25, 50]}
        rowHeight={52}
        headerHeight={40}
        animateRows={false}
        enableCellTextSelection
        alwaysShowHorizontalScroll
        getRowId={(p) => p.data.leadId}
        getRowClass={getRowClass}
      />
    </div>
  );
}
