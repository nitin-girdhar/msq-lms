'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@platform/types';
import type { ReactNode } from 'react';
import { users as usersApi, useNotifications } from '@platform/ui-kit';
import type { PlatformModule } from '@platform/ui-kit/server';
import { useOrgs, type DynamicOrg } from '../../hooks/useOrgs';
import { useLeads } from '../../hooks/useLeads';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useLocationFilters } from '../../hooks/useLocationFilters';
import { useLeadSources } from '../../hooks/useLeadSources';
import StatsCards from '../StatsCards';
import LeadsTable from '../LeadsTable';
import FollowUpsShell from '../leads/FollowUpsShell';
import { DownloadButton } from '@platform/ui-kit';
import { getRulesForTenant, canSeeUnassignedCard } from '@lms/authz';
import { applyLeadFilter } from '../../lib/leads/filter';
import { buildLeadExportColumns } from '../../lib/export/lead-columns';
import { buildFilename, exportRows, type ExportRowsFormat as ExportFormat } from '@platform/ui-kit';

const INLINE_ASSIGN_ROLES: ReadonlyArray<SessionUser['role']> = [
  'super_admin', 'tenant_admin', 'org_admin', 'org_sr_manager',
  'org_manager', 'senior_sales_executive',
];

export type CardFilter =
  | 'all'
  | 'new'
  | 'callAttempted'
  | 'unqualified'
  | 'visitScheduled'
  | 'converted'
  | 'followUp'
  | 'unassigned';

const FILTER_LABELS: Record<CardFilter, string> = {
  all:            'All Leads',
  new:            'New Leads',
  callAttempted:  'Contacting',
  unqualified:    'Unqualified Leads',
  visitScheduled: 'Visit Scheduled',
  converted:      'Converted',
  followUp:       'Follow-up Required',
  unassigned:     'Unassigned Leads',
};

interface Props {
  actor: SessionUser;
  enabledModules?: PlatformModule[];
  /** Cross-product "my day" summary tile — rendered by the app shell (apps/web),
   *  which is the only layer allowed to reach into both @task/web and @hr/web. */
  dayWidget?: ReactNode;
}

export default function LeadDashboardShell({ actor, enabledModules = ['lms'], dayWidget }: Props) {
  const [activeFilter, setActiveFilter] = useState<CardFilter>('all');

  const {
    countries, states, cities,
    selectedCountries, selectedStates, selectedCities,
    setSelectedCountries, setSelectedStates, setSelectedCities,
    loadingCountries, loadingStates, loadingCities,
  } = useLocationFilters();

  const locationFilter = useMemo(() => {
    const f: { cityIds: number[]; stateIds?: number[]; countryIds?: number[] } = {
      cityIds: selectedCities.map(c => c.id),
    };
    if (selectedCities.length === 0) f.stateIds = selectedStates.map(s => s.id);
    if (selectedStates.length === 0 && selectedCities.length === 0) f.countryIds = selectedCountries.map(c => c.id);
    return f;
  }, [selectedCountries, selectedStates, selectedCities]);

  const { orgs, loading: orgsLoading, error: orgsError } = useOrgs(locationFilter);
  const [selectedOrgs, setSelectedOrgs] = useState<DynamicOrg[]>([]);
  const { sources: leadSources, loading: sourcesLoading } = useLeadSources();
  const [selectedSources, setSelectedSources] = useState<string[]>([]);

  const hasLocationFilter = selectedCountries.length > 0 || selectedStates.length > 0 || selectedCities.length > 0;

  // When a location filter is active, auto-select all matching orgs so the
  // grid filters immediately without requiring a separate org pick.
  // When location is cleared, clear org selection too.
  useEffect(() => {
    if (orgsLoading) return;
    if (hasLocationFilter) {
      setSelectedOrgs(orgs);
    } else {
      setSelectedOrgs([]);
    }
  }, [orgs, hasLocationFilter, orgsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // undefined  = no location/org filter → fetch all leads for session org
  // []         = location filter active but no matching orgs → show nothing
  // ['uuid..'] = specific orgs selected → filter by those org IDs
  const orgIds = useMemo(
    () => hasLocationFilter
      ? selectedOrgs.map(o => o.id)
      : selectedOrgs.length > 0
        ? selectedOrgs.map(o => o.id)
        : undefined,
    [selectedOrgs, hasLocationFilter],
  );
  const platforms = useMemo(
    () => selectedSources.length > 0 ? selectedSources : undefined,
    [selectedSources],
  );

  const primaryOrg = selectedOrgs[0] ?? orgs[0] ?? null;

  const {
    leads, stats, loading, error,
    statusOptions, statusLabelMap, requiresFollowupStatuses,
    rejectionStatuses, stageOutcomes, stageIdToName,
    updateLead, refetch,
    addLeadById, updateLeadById, removeLeadById,
  } = useLeads(orgIds, platforms);

  const { addNotification } = useNotifications();

  useRealtimeEvents(actor.id, {
    onLeadCreated: useCallback((leadId: string) => { addLeadById(leadId); }, [addLeadById]),
    onLeadUpdated: useCallback((leadId: string) => { updateLeadById(leadId); }, [updateLeadById]),
    onLeadDeleted: useCallback((leadId: string) => { removeLeadById(leadId); }, [removeLeadById]),
    onFollowUpDue: useCallback((data) => {
      addNotification({
        id: `${data.lead_id}:${data.scheduled_at}:due`,
        leadId: data.lead_id,
        message: data.message,
        scheduledAt: data.scheduled_at,
      });
    }, [addNotification]),
    onFollowUpMissed: useCallback((data) => {
      addNotification({
        id: `${data.lead_id}:${data.scheduled_at}:missed`,
        leadId: data.lead_id,
        message: data.message,
        scheduledAt: data.scheduled_at,
      });
    }, [addNotification]),
  });

  const [candidates, setCandidates] = useState<SessionUser[]>([]);
  const canInlineAssign = INLINE_ASSIGN_ROLES.includes(actor.role);

  useEffect(() => {
    if (!canInlineAssign) { setCandidates([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const json = await usersApi.assignable();
        if (cancelled) return;
        const raw = Array.isArray(json.data) ? json.data as Record<string, unknown>[] : [];
        setCandidates(raw.map((u) => ({
          ...u,
          name: (u.full_name ?? u.name ?? '') as string,
          role: (u.role_name ?? u.role ?? '') as SessionUser['role'],
          role_label: (u.role_label ?? '') as string,
          rank: Number(u.rank ?? 0),
          org_id: (u.org_id ?? '') as string,
          org_name: '',
          tenant_id: '',
          tenant_name: '',
          manager_id: null,
          manager_name: null,
          last_login_at: null,
        })) as SessionUser[]);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => { cancelled = true; };
  }, [canInlineAssign]);

  const handleFilterChange = (filter: CardFilter) => {
    setActiveFilter(prev => (prev === filter ? 'all' : filter));
  };

  const exportLeads = (format: ExportFormat) => {
    const rows     = applyLeadFilter(leads, activeFilter);
    const columns  = buildLeadExportColumns();
    const orgLabel = selectedOrgs.length === 1
      ? selectedOrgs[0].name
      : selectedOrgs.length > 1
        ? `${selectedOrgs.length}-orgs`
        : primaryOrg?.name ?? '';
    const filename = buildFilename([
      orgLabel,
      activeFilter === 'all' ? '' : FILTER_LABELS[activeFilter],
    ]);
    exportRows(rows, columns, filename, format);
  };

  const exportableCount = applyLeadFilter(leads, activeFilter).length;

  const orgLabel = selectedOrgs.length === 0
    ? 'All Branches'
    : selectedOrgs.length === 1
      ? selectedOrgs[0].name
      : `${selectedOrgs.length} orgs`;

  return (
    <div className="flex w-full flex-1 flex-col bg-[#F8FAFC] lg:min-h-0">

      {/* My Day widget — self-hides (no wrapper chrome) when no relevant module/stat applies */}
      {dayWidget}

      {/* Stats cards */}
      <div className="shrink-0 border-b border-[#E2E8F0] bg-white">
        <StatsCards
          stats={stats}
          leads={leads}
          actor={actor}
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          hideUnassigned={!canSeeUnassignedCard(getRulesForTenant(actor.tenant_id), actor.rank)}
        />
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#E2E8F0] bg-white px-4 py-1.5 sm:px-5 sm:py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 text-sm font-semibold text-[#0F172A]">{orgLabel}</span>
          {!loading && (
            <span className="shrink-0 rounded-full border border-[#E2E8F0] bg-[#F1F5F9] px-2 py-0.5 text-xs font-medium tabular-nums text-[#64748B]">
              {activeFilter === 'all' ? `${stats.serverTotal} total` : `${exportableCount} of ${stats.serverTotal}`}
            </span>
          )}
          {activeFilter !== 'all' && (
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-2.5 py-0.5 text-xs font-medium text-[#0b6cbf]">
              Showing: {FILTER_LABELS[activeFilter]}
              <button
                type="button"
                onClick={() => setActiveFilter('all')}
                className="ml-0.5 transition-colors hover:text-[#1e3a5f]"
                title="Clear filter"
                aria-label="Clear filter"
              >
                ×
              </button>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error && (
            <span className="rounded-lg border border-orange-100 bg-orange-50 px-3 py-1.5 text-xs text-[#EA580C]">
              {error}
            </span>
          )}
          {activeFilter !== 'followUp' && (
            <DownloadButton onExport={exportLeads} rowCount={exportableCount} disabled={loading} />
          )}
        </div>
      </div>

      {/* Grid region */}
      <div className={`flex w-full flex-1 flex-col lg:min-h-0 lg:overflow-hidden ${activeFilter === 'followUp' ? 'p-2 sm:px-5 sm:py-1.5' : 'p-2 sm:px-5 sm:py-3'}`}>
        {activeFilter === 'followUp' ? (
          <div className="flex w-full flex-1 flex-col overflow-y-auto lg:min-h-0">
            <FollowUpsShell actor={actor} embedded />
          </div>
        ) : (
          <div className="flex w-full flex-1 flex-col rounded-xl border border-[#E2E8F0] bg-white shadow-sm lg:min-h-0 lg:overflow-hidden">
            <LeadsTable
              leads={leads}
              loading={loading || orgsLoading}
              statusFilter={activeFilter}
              onUpdate={updateLead}
              newLeadRowKeys={new Set()}
              statusOptions={statusOptions}
              statusLabelMap={statusLabelMap}
              actor={actor}
              assignmentCandidates={candidates}
              onAssignmentChanged={refetch}
              requiresFollowupStatuses={requiresFollowupStatuses}
              rejectionStatuses={rejectionStatuses}
              stageOutcomes={stageOutcomes}
              stageIdToName={stageIdToName}
            />
          </div>
        )}
      </div>
    </div>
  );
}
