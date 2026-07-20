'use client';

import '@platform/ui-kit/ag-grid.css';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent, ICellRendererParams, RowClassParams } from 'ag-grid-community';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { SessionUser } from '@crm/types';
import type { LeadView } from '../types/leads';
import type { StageOutcome, UpdatePayload } from '../types/leads';
import type { CardFilter } from './dashboard/LeadDashboardShell';
import { applyLeadFilter } from '../lib/leads/filter';
import { LeadHistoryModal } from './LeadHistoryModal';
import { useIsMobile } from '@platform/ui-kit';
import { StatusBadge } from './leads/StatusBadge';
import { LeadAssigneeBadge } from './leads/LeadAssigneeBadge';
import { MobileLeadCard } from './leads/MobileLeadCard';
import { LeadEditModal } from './leads/LeadEditModal';


ModuleRegistry.registerModules([AllCommunityModule]);

interface Props {
  leads: LeadView[];
  loading: boolean;
  statusFilter?: CardFilter;
  onUpdate: (payload: UpdatePayload) => Promise<void>;
  newLeadRowKeys: Set<string>;
  statusOptions: string[];
  statusLabelMap?: Record<string, string>;
  actor: SessionUser;
  assignmentCandidates: SessionUser[];
  onAssignmentChanged: () => void;
  requiresFollowupStatuses?: Set<string> | string[];
  rejectionStatuses?: Set<string> | string[];
  stageOutcomes?: StageOutcome[];
  stageIdToName?: Record<string, string>;
}

export default function LeadsTable({
  leads, loading, statusFilter = 'all', onUpdate,
  newLeadRowKeys, statusOptions, statusLabelMap,
  actor, assignmentCandidates, onAssignmentChanged,
  requiresFollowupStatuses, rejectionStatuses,
  stageOutcomes, stageIdToName,
}: Props) {
  const gridRef = useRef<AgGridReact>(null);
  const isMobile = useIsMobile();
  const [editingLead,  setEditingLead]  = useState<LeadView | null>(null);
  const [historyLead,  setHistoryLead]  = useState<LeadView | null>(null);

  const followUpSet = useMemo(
    () => requiresFollowupStatuses instanceof Set ? requiresFollowupStatuses : new Set(requiresFollowupStatuses ?? []),
    [requiresFollowupStatuses],
  );
  const rejectionSet = useMemo(
    () => rejectionStatuses instanceof Set ? rejectionStatuses : new Set(rejectionStatuses ?? []),
    [rejectionStatuses],
  );

  const filtered = useMemo(
    () => applyLeadFilter(leads, statusFilter),
    [leads, statusFilter],
  );

  const assigneeCellRenderer = useCallback((params: ICellRendererParams<LeadView>) => {
    const lead = params.data;
    if (!lead) return null;
    const name = lead.assigned_rep_name ?? null;
    return (
      <span style={{ color: name ? '#0F172A' : '#94A3B8', fontStyle: name ? 'normal' : 'italic' }}>
        {name ?? 'Unassigned'}
      </span>
    );
  }, []);

  const actionsCellRenderer = useCallback((params: ICellRendererParams<LeadView>) => {
    const lead = params.data;
    if (!lead) return null;
    const ctx = params.context as { onEdit: (l: LeadView) => void; onHistory: (l: LeadView) => void };
    return (
      <div className="flex items-center gap-1.5">
        <button type="button" title="Edit" onClick={() => ctx.onEdit(lead)}
          className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-1.5 text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf]">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button type="button" title="History" onClick={() => ctx.onHistory(lead)}
          className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-1.5 text-[#475569] transition-colors hover:border-[#7C3AED] hover:text-[#7C3AED]">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </div>
    );
  }, []);

  const columnDefs = useMemo((): ColDef<LeadView>[] => [
    {
      colId: 'date', headerName: 'Date', width: 120, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.created_at ? new Date(p.data.created_at).toLocaleDateString('en-IN') : '',
    },
    {
      colId: 'name', headerName: 'Name', flex: 1, minWidth: 150, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.full_name ?? '',
    },
    {
      colId: 'phone', headerName: 'Phone', width: 140, sortable: false, filter: 'agTextColumnFilter', editable: false,
      valueGetter: (p) => p.data?.phone ?? '',
    },
    {
      colId: 'branch', headerName: 'Branch', width: 150, minWidth: 120, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.org_name ?? '',
    },
    {
      colId: '__assignee', headerName: 'Assigned To', width: 170, minWidth: 130, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.assigned_rep_name ?? 'Unassigned',
      cellRenderer: assigneeCellRenderer,
      cellStyle: { display: 'flex', alignItems: 'center', paddingLeft: '12px', paddingRight: '12px' },
    },
    {
      colId: 'status', headerName: 'Status', width: 165, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.stage ?? '',
      cellRenderer: (p: ICellRendererParams<LeadView>) => (
        <StatusBadge value={p.data?.stage ?? ''} labelMap={statusLabelMap ?? {}} />
      ),
      cellStyle: { display: 'flex', alignItems: 'center' } as Record<string, string>,
    },
    {
      colId: 'outcome', headerName: 'Outcome', width: 180, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.outcome_label ?? p.data?.outcome ?? '',
      cellRenderer: (p: ICellRendererParams<LeadView>) => {
        const val = p.data?.outcome_label ?? p.data?.outcome;
        return val
          ? <span style={{ background: '#F1F5F9', color: '#475569' }} className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium">{val}</span>
          : <span className="text-xs text-[#CBD5E1]">—</span>;
      },
      cellStyle: { display: 'flex', alignItems: 'center' } as Record<string, string>,
    },
    {
      colId: '__actions', headerName: '', width: 120, minWidth: 120, maxWidth: 120,
      pinned: 'right', sortable: false, filter: false, editable: false, resizable: false,
      cellRenderer: actionsCellRenderer,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible', gap: '6px' },
    },
  ], [statusLabelMap, assigneeCellRenderer, actionsCellRenderer]);

  const defaultColDef: ColDef = useMemo(() => ({
    resizable: true,
    suppressMovable: false,
    cellStyle: { fontSize: '13px', color: '#0F172A' },
  }), []);

  const gridContext = useMemo(() => ({
    actor,
    onEdit:    setEditingLead,
    onHistory: setHistoryLead,
  }), [actor]);

  const onGridReady = useCallback((_: GridReadyEvent) => {}, []);

  const getRowClass = useCallback((params: RowClassParams<LeadView>) => {
    if (!params.data) return '';
    return newLeadRowKeys.has(params.data.lead_id) ? 'new-lead-row' : '';
  }, [newLeadRowKeys]);

  const editModal = editingLead ? (
    <LeadEditModal
      lead={editingLead}
      statusOptions={statusOptions}
      statusLabelMap={statusLabelMap ?? {}}
      followUpSet={followUpSet}
      rejectionSet={rejectionSet}
      stageOutcomes={stageOutcomes ?? []}
      stageIdToName={stageIdToName ?? {}}
      candidates={assignmentCandidates}
      actor={actor}
      onUpdate={onUpdate}
      onAssignmentChanged={onAssignmentChanged}
      onClose={() => setEditingLead(null)}
    />
  ) : null;

  const historyModal = historyLead ? (
    <LeadHistoryModal
      lead={{ lead_id: historyLead.lead_id }}
      onClose={() => setHistoryLead(null)}
    />
  ) : null;

  if (loading) {
    return (
      <>
        {editModal}{historyModal}
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#94A3B8]">
          <svg className="w-6 h-6 animate-spin text-[#0A6BA8]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-sm">Loading leads…</span>
        </div>
      </>
    );
  }

  if (isMobile) {
    if (filtered.length === 0) {
      return (
        <>
          {editModal}{historyModal}
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-[#94A3B8]">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium">No leads found</span>
          </div>
        </>
      );
    }
    return (
      <>
        {editModal}{historyModal}
        <div className="flex flex-col gap-3 py-4 pb-8">
          <div className="px-4 flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64748B] uppercase tracking-wide">
              {filtered.length} lead{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
          {filtered.map((lead) => (
            <MobileLeadCard
              key={lead.lead_id}
              lead={lead}
              isNew={newLeadRowKeys.has(lead.lead_id)}
              statusLabelMap={statusLabelMap ?? {}}
              onEditClick={setEditingLead}
              onHistoryClick={setHistoryLead}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {editModal}{historyModal}
      <div
        className="ag-theme-alpine"
        style={{ flex: '1 1 0', minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <AgGridReact<LeadView>
          ref={gridRef}
          rowData={filtered}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          context={gridContext}
          onGridReady={onGridReady}
          pagination
          paginationPageSize={25}
          paginationPageSizeSelector={[25, 50, 100]}
          rowHeight={48}
          headerHeight={44}
          animateRows={false}
          suppressCellFocus={false}
          enableCellTextSelection
          alwaysShowHorizontalScroll
          alwaysShowVerticalScroll
          getRowId={(params) => params.data.lead_id}
          getRowClass={getRowClass}
        />
      </div>
    </>
  );
}
