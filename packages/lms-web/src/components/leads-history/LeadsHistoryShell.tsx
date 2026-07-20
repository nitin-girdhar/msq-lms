'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { SessionUser } from '@platform/types';
import { getRulesForTenant, canSeeAssignedToFilter, getLeadsHistoryAssignedToScope } from '@lms/authz';
import { canSeeOrgFilter } from '@platform/authz';
import type { AssignmentView, StageOption, StageOutcome, LeadView } from '../../types/leads';
import { useLeadsHistory } from '../../hooks/useLeadsHistory';
import type { LeadsHistoryFilters } from '../../hooks/useLeadsHistory';
import { Pagination, DownloadButton, users as usersApi, orgs as orgsApi } from '@platform/ui-kit';
import AssigneeBadge from '../assignments/AssigneeBadge';
import { StatusBadge } from '../leads/StatusBadge';
import { LeadHistoryModal } from '../LeadHistoryModal';
import { buildFilename, exportRows, type ExportColumn, type ExportRowsFormat as ExportFormat } from '@platform/ui-kit';
import '@platform/ui-kit/ag-grid.css';

ModuleRegistry.registerModules([AllCommunityModule]);

interface Props {
  actor: SessionUser;
}

interface UserOption { id: string; label: string }
interface OrgOption { id: string; name: string }

function defaultDateFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}
function today(): string {
  return new Date().toISOString().split('T')[0];
}
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EXPORT_COLUMNS: ExportColumn<AssignmentView>[] = [
  { header: 'Name', value: (a) => a.lead_full_name ?? '' },
  { header: 'Phone', value: (a) => a.lead_phone ?? '' },
  { header: 'Branch', value: (a) => a.branch },
  { header: 'Stage', value: (a) => a.lead_stage_label ?? a.lead_stage ?? '' },
  { header: 'Outcome', value: (a) => a.lead_stage_outcome_label ?? '' },
  { header: 'Assigned To', value: (a) => a.assigned_rep_name ?? '' },
  { header: 'Created', value: (a) => formatDate(a.lead_created_at) },
];

const ACTIVE_STAGE_NAMES = new Set(['new', 'contacting', 'qualified']);


export default function LeadsHistoryShell({ actor }: Props) {
  const rules = useMemo(() => getRulesForTenant(actor.tenant_id), [actor.tenant_id]);
  const showAssignedTo = canSeeAssignedToFilter(rules, actor.rank);
  const showOrgFilter = canSeeOrgFilter(actor.role);
  const scope = getLeadsHistoryAssignedToScope(rules, actor.rank, actor.role);

  const [historyLead, setHistoryLead] = useState<AssignmentView | null>(null);
  const gridRef = useRef<AgGridReact<AssignmentView>>(null);

  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(today);
  const [selectedStages, setSelectedStages] = useState<string[]>([]);
  const [selectedOutcomes, setSelectedOutcomes] = useState<string[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);

  const [assignableUsers, setAssignableUsers] = useState<UserOption[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const {
    data, total, page, pageSize, loading, error,
    stageOptions, stageOutcomes,
    fetchData, goToPage, changePageSize,
  } = useLeadsHistory();

  // By default send active stage IDs (non-terminated)
  const activeStageIds = useMemo(
    () => stageOptions.filter((s) => ACTIVE_STAGE_NAMES.has(s.name)).map((s) => s.id),
    [stageOptions],
  );

  const buildFilters = useCallback((pg = 1, ps = 25): LeadsHistoryFilters => {
    const stageIds = selectedStages.length ? selectedStages : activeStageIds;
    return {
      page: pg,
      page_size: ps,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      stage_ids: stageIds.length ? stageIds.join(',') : undefined,
      outcome_ids: selectedOutcomes.length ? selectedOutcomes.join(',') : undefined,
      org_ids: selectedOrgs.length ? selectedOrgs.join(',') : undefined,
      assigned_to: selectedAssignees.length ? selectedAssignees.join(',') : undefined,
      active_only: false,
    };
  }, [dateFrom, dateTo, selectedStages, selectedOutcomes, selectedOrgs, selectedAssignees, activeStageIds]);

  // Initial fetch — needs stageOptions to know active stage IDs
  const initialFetched = useRef(false);
  useEffect(() => {
    if (initialFetched.current) return;
    // First fetch without stage filter (backend defaults to active_only=true)
    fetchData({ page: 1, page_size: 25, date_from: defaultDateFrom(), date_to: today(), active_only: true });
    initialFetched.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Below tenant scope the org is forced server-side — don't even fetch the
    // tenant's org list for an actor who has no business seeing other org names.
    if (!showOrgFilter) return;
    let cancelled = false;
    (async () => {
      try {
        const json = await orgsApi.all();
        if (!cancelled) setOrgs(Array.isArray(json.data) ? json.data as OrgOption[] : []);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [showOrgFilter]);

  // "Relevant users" for the picked org — still capped by the actor's own scope
  // (team scope never asks the backend for another org's users at all; org/tenant/all
  // scope narrow to the selected org, or fall back to the actor's own org when no
  // org is picked, same as before this feature existed).
  const selectedOrgId = showOrgFilter && selectedOrgs.length === 1 ? selectedOrgs[0] : undefined;

  useEffect(() => {
    if (!showAssignedTo) return;
    let cancelled = false;
    setLoadingUsers(true);
    (async () => {
      try {
        if (scope === 'team') {
          const res = await usersApi.team();
          if (cancelled) return;
          const members = (res.data as Array<Record<string, unknown>>).map((m) => ({
            id: m['memberId'] as string,
            label: (m['memberFullName'] as string) ?? (m['memberEmail'] as string) ?? '',
          }));
          members.unshift({ id: actor.id, label: `${actor.name} (me)` });
          setAssignableUsers(members);
        } else {
          const json = await usersApi.list(selectedOrgId ? { org_id: selectedOrgId } : undefined);
          if (cancelled) return;
          const list = (json.data as Array<Record<string, unknown>> ?? []).map((u) => ({
            id: u['id'] as string,
            label: (u['full_name'] as string) ?? (u['email'] as string) ?? '',
          }));
          setAssignableUsers(list);
        }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoadingUsers(false); }
    })();
    return () => { cancelled = true; };
  }, [showAssignedTo, scope, actor, selectedOrgId]);

  // Previously-picked assignee may not belong to the newly-selected org — clear it
  // rather than silently keep filtering by a user who's no longer in the visible list.
  useEffect(() => {
    setSelectedAssignees([]);
  }, [selectedOrgId]);

  const statusLabelMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of stageOptions) m[s.name] = s.label;
    return m;
  }, [stageOptions]);

  const filteredOutcomes = useMemo(() => {
    if (!selectedStages.length) return stageOutcomes;
    return stageOutcomes.filter((o) => selectedStages.includes(o.stage_id));
  }, [stageOutcomes, selectedStages]);

  const handleApply = () => fetchData(buildFilters(1, pageSize));

  const handleReset = () => {
    setDateFrom(defaultDateFrom());
    setDateTo(today());
    setSelectedStages([]);
    setSelectedOutcomes([]);
    setSelectedOrgs([]);
    setSelectedAssignees([]);
    // Also clear any per-column filter/sort applied directly in the grid, so Reset
    // fully returns to the same state as when this page was first loaded.
    gridRef.current?.api.setFilterModel(null);
    gridRef.current?.api.applyColumnState({ defaultState: { sort: null } });
    fetchData({ page: 1, page_size: 25, date_from: defaultDateFrom(), date_to: today(), active_only: true });
  };

  const handleExport = (format: ExportFormat) => {
    exportRows(data, EXPORT_COLUMNS, buildFilename(['leads-history']), format);
  };

  const columnDefs = useMemo((): ColDef<AssignmentView>[] => [
    {
      headerName: 'Lead', field: 'lead_full_name', width: 180, minWidth: 160, filter: true, sortable: true,
      cellRenderer: (p: ICellRendererParams<AssignmentView>) => {
        if (!p.data) return null;
        return (
          <div className="flex flex-col justify-center leading-tight">
            <p className="text-sm font-semibold leading-tight text-[#0F172A]">{p.data.lead_full_name ?? '—'}</p>
            {p.data.lead_phone && <p className="text-[11px] leading-tight text-[#64748B]">{p.data.lead_phone}</p>}
          </div>
        );
      },
    },
    {
      // Only flexible column — branch/org names vary in length, so leftover
      // width goes here instead of being spread thinly across every column.
      headerName: 'Branch', field: 'branch', flex: 1, minWidth: 140, filter: true, sortable: true,
    },
    {
      // Same StatusBadge + labelMap as the main leads grid — colors come from
      // STATUS_CONFIG keyed by stage name, not a locally-invented palette.
      headerName: 'Stage', width: 150, filter: true, sortable: true,
      valueGetter: (p) => p.data?.lead_stage_label ?? p.data?.lead_stage ?? '',
      cellRenderer: (p: ICellRendererParams<AssignmentView>) => (
        <StatusBadge value={p.data?.lead_stage ?? ''} labelMap={statusLabelMap} />
      ),
      cellStyle: { display: 'flex', alignItems: 'center' },
    },
    {
      // Matches the main leads grid's Outcome cell exactly (same gray pill, same fallback dash).
      headerName: 'Outcome', width: 180, filter: true, sortable: true,
      valueGetter: (p) => p.data?.lead_stage_outcome_label ?? '',
      cellRenderer: (p: ICellRendererParams<AssignmentView>) => {
        const val = p.data?.lead_stage_outcome_label;
        return val
          ? <span style={{ background: '#F1F5F9', color: '#475569' }} className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium">{val}</span>
          : <span className="text-xs text-[#CBD5E1]">—</span>;
      },
      cellStyle: { display: 'flex', alignItems: 'center' },
    },
    {
      // Matches the main leads grid's Assigned To cell exactly (plain text, no pill/avatar).
      headerName: 'Assigned To', width: 170, minWidth: 130, filter: true, sortable: true,
      valueGetter: (p) => p.data?.assigned_rep_name ?? 'Unassigned',
      cellRenderer: (p: ICellRendererParams<AssignmentView>) => {
        const name = p.data?.assigned_rep_name ?? null;
        return (
          <span style={{ color: name ? '#0F172A' : '#94A3B8', fontStyle: name ? 'normal' : 'italic' }}>
            {name ?? 'Unassigned'}
          </span>
        );
      },
      cellStyle: { display: 'flex', alignItems: 'center' },
    },
    {
      headerName: 'Created', width: 130, filter: true, sortable: true,
      valueGetter: (p) => p.data?.lead_created_at ?? '',
      valueFormatter: (p) => formatDate(p.value),
    },
    {
      headerName: '', width: 80, minWidth: 80, maxWidth: 80, sortable: false, filter: false, resizable: false, pinned: 'right',
      cellRenderer: (p: ICellRendererParams<AssignmentView>) => {
        if (!p.data) return null;
        return (
          <ActionBtn title="History" onClick={() => setHistoryLead(p.data!)}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </ActionBtn>
        );
      },
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
    },
  ], [statusLabelMap]);

  const defaultColDef = useMemo((): ColDef => ({
    resizable: true,
    cellStyle: { fontSize: '13px', color: '#0F172A' },
  }), []);

  return (
    <div className="w-full space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A]">Leads History</h1>
          <p className="mt-1 text-xs text-[#64748B]">
            {loading ? 'Loading…' : `${total} lead${total !== 1 ? 's' : ''} found`}
          </p>
        </div>
        <DownloadButton onExport={handleExport} rowCount={data.length} disabled={loading} />
      </div>

      {/* ── Filters ── */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="From">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} />
          </FilterField>
          <FilterField label="To">
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} />
          </FilterField>

          <FilterField label="Stage">
            <MultiCheckDropdown
              placeholder="All active"
              options={stageOptions.map((s) => ({ value: s.id, label: s.label }))}
              selected={selectedStages}
              onChange={(v) => { setSelectedStages(v); setSelectedOutcomes([]); }}
            />
          </FilterField>

          <FilterField label="Outcome">
            <MultiCheckDropdown
              placeholder="All"
              options={filteredOutcomes.map((o) => ({ value: o.id, label: o.label }))}
              selected={selectedOutcomes}
              onChange={setSelectedOutcomes}
              disabled={selectedStages.length === 0}
              disabledHint="Pick a stage first"
            />
          </FilterField>

          {showOrgFilter && orgs.length > 1 && (
            <FilterField label="Org">
              <select
                value={selectedOrgs[0] ?? ''}
                onChange={(e) => setSelectedOrgs(e.target.value ? [e.target.value] : [])}
                className={inputCls}
              >
                <option value="">All orgs</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </FilterField>
          )}

          {showAssignedTo && (
            <FilterField label="Assigned To">
              <MultiCheckDropdown
                placeholder="All"
                options={assignableUsers.map((u) => ({ value: u.id, label: u.label }))}
                selected={selectedAssignees}
                onChange={setSelectedAssignees}
                disabled={loadingUsers}
                disabledHint="Loading users…"
              />
            </FilterField>
          )}

          <div className="flex items-center gap-2">
            <button type="button" onClick={handleApply} disabled={loading}
              className="rounded-lg bg-[#0b6cbf] px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#095699] disabled:opacity-60">
              Apply
            </button>
            <button type="button" onClick={handleReset}
              className="rounded-lg border border-[#E2E8F0] bg-white px-4 py-1.5 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC]">
              Reset
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>
      )}

      {/* ── Table ── */}
      <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
        {loading && data.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-[#94A3B8]">Loading…</div>
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-[#94A3B8]">No leads match the filters.</div>
        ) : (
          <>
            <div className="ag-theme-alpine hidden w-full overflow-hidden md:block">
              <AgGridReact<AssignmentView>
                ref={gridRef}
                rowData={data}
                columnDefs={columnDefs}
                defaultColDef={defaultColDef}
                domLayout="autoHeight"
                rowHeight={44}
                headerHeight={40}
                animateRows={false}
                enableCellTextSelection
                alwaysShowHorizontalScroll
                getRowId={(p) => p.data.id}
              />
            </div>

            <ul className="divide-y divide-[#F1F5F9] md:hidden">
              {data.map((a) => (
                <li key={a.id} className="space-y-1.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#0F172A]">{a.lead_full_name ?? '—'}</p>
                      {a.lead_phone && <p className="text-xs text-[#64748B]">{a.lead_phone}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StageBadge stage={a.lead_stage_label ?? a.lead_stage} terminated={a.is_terminated} />
                      <ActionBtn title="History" onClick={() => setHistoryLead(a)}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </ActionBtn>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#64748B]">
                    <span>{a.branch}</span>
                    <span>·</span>
                    <AssigneeBadge user={a.assigned_rep_name || a.assigned_rep_email ? { name: a.assigned_rep_name, email: a.assigned_rep_email ?? '' } : null} />
                    <span>·</span>
                    <span>{formatDate(a.lead_created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>

            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={goToPage} onPageSizeChange={changePageSize} />
          </>
        )}
      </div>

      {historyLead && (
        <LeadHistoryModal lead={{ lead_id: historyLead.lead_id }} onClose={() => setHistoryLead(null)} />
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const inputCls =
  'rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-xs text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20';

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8]">{label}</span>}
      {children}
    </div>
  );
}

function ActionBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-1.5 text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf]">
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">{children}</svg>
    </button>
  );
}

function StageBadge({ stage, terminated }: { stage: string | null; terminated: boolean }) {
  if (!stage) return <span className="text-xs text-[#CBD5E1]">—</span>;
  const color = terminated ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}>{stage}</span>;
}

// ── Multi-check dropdown ──────────────────────────────────────────────────

interface DropdownOption { value: string; label: string }

function MultiCheckDropdown({
  placeholder, options, selected, onChange, disabled, disabledHint,
}: {
  placeholder: string;
  options: DropdownOption[];
  selected: string[];
  onChange: (val: string[]) => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  };

  const label = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (options.find((o) => o.value === selected[0])?.label ?? '1 selected')
      : `${selected.length} selected`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={`${inputCls} flex min-w-[140px] items-center justify-between gap-2 whitespace-nowrap ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <span className="truncate">{label}</span>
        <svg className="h-3 w-3 shrink-0 text-[#94A3B8]" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && !disabled && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-52 min-w-[180px] overflow-y-auto rounded-lg border border-[#E2E8F0] bg-white py-1 shadow-lg">
          {options.length === 0 && (
            <p className="px-3 py-2 text-xs text-[#94A3B8]">No options</p>
          )}
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-[#0F172A] hover:bg-[#F8FAFC]">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
                className="rounded border-[#CBD5E1]"
              />
              {o.label}
            </label>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full border-t border-[#F1F5F9] px-3 py-1.5 text-left text-[10px] font-semibold text-[#0b6cbf] hover:bg-[#F8FAFC]"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
