'use client';

// Desktop-only (md and up). This module is the sole importer of ag-grid on the
// Follow-Up Pipeline screen, so FollowUpsShell can pull it in via next/dynamic
// and a phone below the md breakpoint never downloads the ag-grid chunk.

import '@platform/ui-kit/ag-grid.css';
import { useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { type FollowUpItem, formatDate, overdueDuration, timeUntil } from '../../lib/leads/followup-format';
import { GRID_DEFAULT_COL_DEF } from '@platform/ui-kit/grid';

ModuleRegistry.registerModules([AllCommunityModule]);

interface Props {
  items: FollowUpItem[];
  onEdit: (f: FollowUpItem) => void;
  onHistory: (f: FollowUpItem) => void;
  type: 'upcoming' | 'missed';
}

export default function FollowUpGrid({ items, onEdit, onHistory, type }: Props) {
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
      valueGetter: (p) => p.data?.leadStageLabel ?? p.data?.leadStage.replace(/_/g, ' ') ?? '',
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
      headerName: 'Notes', field: 'notes', flex: 1.5, minWidth: 120, filter: true, sortable: false,
      valueFormatter: (p) => p.value ?? '—',
      tooltipField: 'notes',
      cellClass: 'truncate',
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

  // Shared across every grid in the platform — case/accent-insensitive column
  // filtering lives in @platform/ui-kit/grid, not in a per-file literal.
  const defaultColDef: ColDef = GRID_DEFAULT_COL_DEF;

  const getRowClass = useCallback(() => isMissed ? 'bg-red-50/50' : '', [isMissed]);

  return (
    <div className="ag-theme-alpine min-w-0 w-full overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <AgGridReact<FollowUpItem>
        ref={gridRef}
        rowData={items}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        domLayout="autoHeight"
        pagination
        paginationPageSize={5}
        paginationPageSizeSelector={[5, 10, 25, 50]}
        rowHeight={52}
        headerHeight={40}
        animateRows={false}
        enableCellTextSelection
        getRowId={(p) => p.data.leadId}
        getRowClass={getRowClass}
      />
    </div>
  );
}
