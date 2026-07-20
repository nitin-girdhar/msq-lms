'use client';

import '@platform/ui-kit/ag-grid.css';
import { useCallback, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent, GridSizeChangedEvent, ICellRendererParams } from 'ag-grid-community';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { SessionUser } from '@platform/types';
import { ROLES, ROLE_LABELS, ROLE_RANK } from '@platform/auth-constants';
import { RANKS } from '@platform/authz';
import { canCreateUser } from '@/src/lib/permissions';
import {
  useIsMobile,
  DownloadButton,
  MultiSelect,
  type SelectOption,
  buildFilename,
  exportRows,
  type ExportColumn,
  type ExportRowsFormat as ExportFormat,
} from '@platform/ui-kit';

import UserStatusBadge from './UserStatusBadge';

ModuleRegistry.registerModules([AllCommunityModule]);

const USER_EXPORT_COLUMNS: ExportColumn<SessionUser>[] = [
  { header: 'Name', value: (u) => u.name ?? '' },
  { header: 'Role', value: (u) => u.role_label ?? ROLE_LABELS[u.role] ?? '' },
  { header: 'Email', value: (u) => u.email },
  { header: 'Org', value: (u) => u.org_name ?? '' },
  { header: 'Manager', value: (u) => u.manager_name ?? '' },
  { header: 'Status', value: (u) => (u.is_active ? 'Active' : 'Inactive') },
  { header: 'Last Login', value: (u) => u.last_login_at ?? '' },
];

interface Props {
  users: SessionUser[];
  currentUserId: string;
  actorRank: number;
  onEdit: (user: SessionUser) => void;
}

const STATUS_OPTIONS: SelectOption[] = [
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
];

export default function UsersTable({ users, currentUserId, actorRank, onEdit }: Props) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [roleSelected, setRoleSelected] = useState<SelectOption[]>([]);
  const [statusSelected, setStatusSelected] = useState<SelectOption[]>([]);
  const [orgSelected, setOrgSelected] = useState<SelectOption[]>([]);
  const [managerSelected, setManagerSelected] = useState<SelectOption[]>([]);

  // Org/manager filters only make sense for actors who actually see users across
  // more than one branch — tenant admin+ (users.service.ts's tenantWide listing).
  // Everyone else's roster is already a single org, so the pickers would be dead UI.
  const showCrossOrgFilters = actorRank >= RANKS.TENANT_ADMIN;

  const roleOptions = useMemo(
    () => ROLES.filter((r) => canCreateUser(actorRank, ROLE_RANK[r] ?? 0)).map((r) => ({ id: r, label: ROLE_LABELS[r] })),
    [actorRank],
  );

  const orgOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of users) {
      if (u.org_id && !seen.has(u.org_id)) seen.set(u.org_id, u.org_name || u.org_id);
    }
    return Array.from(seen, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [users]);

  const managerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of users) {
      if (u.manager_id && !seen.has(u.manager_id)) seen.set(u.manager_id, u.manager_name || u.manager_id);
    }
    return Array.from(seen, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [users]);

  const userById = useMemo(() => {
    const map = new Map<string, SessionUser>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  const canEditRow = useCallback(
    (u: SessionUser) => canCreateUser(actorRank, u.rank),
    [actorRank],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const roleIds = new Set(roleSelected.map((o) => o.id));
    const statusIds = new Set(statusSelected.map((o) => o.id));
    const orgIds = new Set(orgSelected.map((o) => o.id));
    const managerIds = new Set(managerSelected.map((o) => o.id));
    return users.filter((u) => {
      if (statusIds.size > 0 && !statusIds.has(u.is_active ? 'active' : 'inactive')) return false;
      if (roleIds.size > 0 && !roleIds.has(u.role)) return false;
      if (showCrossOrgFilters && orgIds.size > 0 && !orgIds.has(u.org_id)) return false;
      if (showCrossOrgFilters && managerIds.size > 0 && !(u.manager_id && managerIds.has(u.manager_id))) return false;
      if (q) {
        const hay = `${u.email} ${u.name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [users, search, roleSelected, statusSelected, orgSelected, managerSelected, showCrossOrgFilters]);

  const exportUsers = (format: ExportFormat) => {
    exportRows(filtered, USER_EXPORT_COLUMNS, buildFilename(['users']), format);
  };

  const nameCellRenderer = useCallback((params: ICellRendererParams<SessionUser>) => {
    const u = params.data;
    if (!u) return null;
    return (
      <div className="flex flex-col justify-center leading-tight">
        <p className="truncate text-sm font-semibold leading-tight text-[#0F172A]">
          {u.name ?? '—'}
          {u.id === currentUserId && (
            <span className="ml-2 text-[10px] font-semibold uppercase text-[#0b6cbf]">(you)</span>
          )}
        </p>
        {u.role_label && <p className="truncate text-[11px] leading-tight text-[#64748B]">{u.role_label}</p>}
      </div>
    );
  }, [currentUserId]);

  const managerCellRenderer = useCallback((params: ICellRendererParams<SessionUser>) => {
    const u = params.data;
    if (!u?.manager_id) return <span className="italic text-[#94A3B8]">—</span>;
    const manager = userById.get(u.manager_id);
    return (
      <div className="flex flex-col justify-center leading-tight">
        <p className="truncate text-sm leading-tight text-[#0F172A]">{u.manager_name ?? '—'}</p>
        {manager?.role_label && <p className="truncate text-[11px] leading-tight text-[#64748B]">{manager.role_label}</p>}
      </div>
    );
  }, [userById]);

  const statusCellRenderer = useCallback((params: ICellRendererParams<SessionUser>) => {
    if (!params.data) return null;
    return <UserStatusBadge active={params.data.is_active} />;
  }, []);

  const actionsCellRenderer = useCallback((params: ICellRendererParams<SessionUser>) => {
    const u = params.data;
    if (!u) return null;
    return canEditRow(u) ? (
      <button
        type="button"
        onClick={() => onEdit(u)}
        className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC]"
      >
        Edit
      </button>
    ) : (
      <span className="text-[10px] uppercase tracking-wide text-[#94A3B8]">View only</span>
    );
  }, [canEditRow, onEdit]);

  const columnDefs = useMemo((): ColDef<SessionUser>[] => [
    {
      colId: 'name', headerName: 'Name', width: 220, minWidth: 180, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.name ?? '',
      // Sorting/filtering the Name column still targets the name value; role_label
      // renders as a subtitle inside the cell (see nameCellRenderer) rather than
      // getting its own column — same "primary + subtitle" pattern the Leads
      // History grid uses for Lead name + phone.
      cellRenderer: nameCellRenderer,
    },
    {
      colId: 'email', headerName: 'Email', width: 240, minWidth: 200, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.email ?? '',
    },
    {
      colId: 'org_name', headerName: 'Org', width: 160, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.org_name || '—',
    },
    {
      colId: 'manager_name', headerName: 'Manager', width: 180, sortable: true, filter: true, editable: false,
      valueGetter: (p) => p.data?.manager_name ?? '',
      cellRenderer: managerCellRenderer,
    },
    {
      colId: 'status', headerName: 'Status', width: 130, sortable: true, filter: true, editable: false,
      valueGetter: (p) => (p.data?.is_active ? 'Active' : 'Inactive'),
      cellRenderer: statusCellRenderer,
      cellStyle: { display: 'flex', alignItems: 'center' },
    },
    {
      colId: '__actions', headerName: '', width: 120, minWidth: 120, maxWidth: 120,
      pinned: 'right', sortable: false, filter: false, editable: false, resizable: false,
      cellRenderer: actionsCellRenderer,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
    },
  ], [nameCellRenderer, managerCellRenderer, statusCellRenderer, actionsCellRenderer]);

  // Flex columns can leave a leftover blank strip after the last column if the
  // grid's own width settles after AG Grid's initial measurement (e.g. sidebar
  // collapses, layout reflows post-hydration). Forcing a fit on ready + on any
  // container resize keeps columns filling the full width with no gap.
  const onGridReady = useCallback((params: GridReadyEvent<SessionUser>) => {
    params.api.sizeColumnsToFit();
  }, []);
  const onGridSizeChanged = useCallback((params: GridSizeChangedEvent<SessionUser>) => {
    params.api.sizeColumnsToFit();
  }, []);

  const defaultColDef: ColDef = useMemo(() => ({
    resizable: true,
    suppressMovable: false,
    cellStyle: { fontSize: '13px', color: '#0F172A' },
  }), []);

  return (
    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#F1F5F9] p-3 sm:p-4">
        <input
          type="search"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[200px] flex-1 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
        />
        <MultiSelect
          label="Role"
          placeholder="All roles"
          options={roleOptions}
          selected={roleSelected}
          onChange={setRoleSelected}
        />
        <MultiSelect
          label="Status"
          placeholder="All statuses"
          options={STATUS_OPTIONS}
          selected={statusSelected}
          onChange={setStatusSelected}
        />
        {showCrossOrgFilters && (
          <>
            <MultiSelect
              label="Branch"
              placeholder="All branches"
              options={orgOptions}
              selected={orgSelected}
              onChange={setOrgSelected}
            />
            <MultiSelect
              label="Manager"
              placeholder="All managers"
              options={managerOptions}
              selected={managerSelected}
              onChange={setManagerSelected}
            />
          </>
        )}
        <span className="ml-auto text-xs text-[#64748B]">
          {filtered.length} of {users.length}
        </span>
        <DownloadButton onExport={exportUsers} rowCount={filtered.length} />
      </div>

      {isMobile ? (
        <ul className="divide-y divide-[#F1F5F9]">
          {filtered.map((u) => (
            <li key={u.id} className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#0F172A]">
                    {u.name ?? '—'}
                    {u.id === currentUserId && (
                      <span className="ml-2 text-[10px] font-semibold uppercase text-[#0b6cbf]">(you)</span>
                    )}
                  </p>
                  {u.role_label && <p className="text-[10px] text-[#94A3B8]">{u.role_label}</p>}
                  <p className="truncate text-xs text-[#475569]">{u.email}</p>
                </div>
                {canEditRow(u) ? (
                  <button
                    type="button"
                    onClick={() => onEdit(u)}
                    className="shrink-0 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1 text-xs font-semibold text-[#475569]"
                  >
                    Edit
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[#94A3B8]">
                    View only
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <UserStatusBadge active={u.is_active} />
                {u.manager_name ? (
                  <span className="text-[11px] text-[#475569]">↑ {u.manager_name}</span>
                ) : (
                  <span className="text-[11px] italic text-[#94A3B8]">No manager</span>
                )}
              </div>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-[#64748B]">
              No users match the filters.
            </li>
          )}
        </ul>
      ) : (
        <div className="ag-theme-alpine" style={{ height: 600, width: '100%' }}>
          <AgGridReact<SessionUser>
            rowData={filtered}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={[25, 50, 100]}
            rowHeight={44}
            headerHeight={40}
            animateRows={false}
            suppressCellFocus={false}
            enableCellTextSelection
            onGridReady={onGridReady}
            onGridSizeChanged={onGridSizeChanged}
            getRowId={(params) => params.data.id}
            overlayNoRowsTemplate="No users match the filters."
          />
        </div>
      )}
    </div>
  );
}
