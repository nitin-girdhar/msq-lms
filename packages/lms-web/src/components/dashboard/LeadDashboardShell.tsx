'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { SessionUser } from '@platform/types';
import { useNotifications } from '@platform/ui-kit';
import type { PlatformModule } from '@platform/ui-kit/server';
import { useLeads } from '../../hooks/useLeads';
import { useFollowUps } from '../../hooks/useFollowUps';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useLeadSources } from '../../hooks/useLeadSources';
import { LEAD_TYPES_PARAM, canFilterLeadTypes, parseLeadTypesParam } from '../../lib/leads/type-filter';
import StatsCards from '../StatsCards';
import SourceBreakdownBar from './SourceBreakdownBar';
import LeadsTable from '../LeadsTable';
import FollowUpsShell from '../leads/FollowUpsShell';
import { DownloadButton } from '@platform/ui-kit';
import { getRulesForTenant, canSeeUnassignedCard } from '@lms/authz';
import { applyLeadFilter } from '../../lib/leads/filter';
import { buildStatGroups } from '../../lib/leads/stats';
import { sessionBranchFilter, sessionBranchLabel } from '../../lib/leads/branch-scope';
import { buildLeadExportColumns } from '../../lib/export/lead-columns';
import { buildFilename, exportRows, type ExportRowsFormat as ExportFormat } from '@platform/ui-kit';

export type CardFilter =
  | 'all'
  | 'new'
  | 'callAttempted'
  | 'unqualified'
  | 'visitScheduled'
  | 'converted'
  | 'followUpDue'
  | 'followUpOverdue'
  | 'unassigned';

const FILTER_LABELS: Record<CardFilter, string> = {
  all:            'All Leads',
  new:            'New Leads',
  callAttempted:  'Contacting',
  unqualified:    'Unqualified Leads',
  visitScheduled: 'Visit Scheduled',
  converted:      'Converted',
  followUpDue:     'Follow-up Due',
  followUpOverdue: 'Follow-up Overdue',
  unassigned:     'Unassigned Leads',
};

interface Props {
  actor: SessionUser;
  enabledModules?: PlatformModule[];
}

// enabledModules defaults to NOTHING, matching getEnabledModules' fail-closed
// value. Defaulting to ['lms'] here would quietly re-assert the CRM entitlement
// that server helper stopped assuming.
export default function LeadDashboardShell({ actor, enabledModules = [] }: Props) {
  const [activeFilter, setActiveFilter] = useState<CardFilter>('all');
  const isFollowUpView = activeFilter === 'followUpDue' || activeFilter === 'followUpOverdue';

  // Branch context comes from the navbar branch switcher (the session): "All
  // branches" sends no org filter, a picked branch narrows every grid, tile and
  // export on this page to it. The server still decides what may be read.
  const orgIdsKey = sessionBranchFilter(actor)?.join(',') ?? '';
  const orgIds = useMemo(() => (orgIdsKey ? orgIdsKey.split(',') : undefined), [orgIdsKey]);
  const branchLabel = sessionBranchLabel(actor);

  const { sources: leadSources, loading: sourcesLoading } = useLeadSources();
  const [selectedSources, setSelectedSources] = useState<string[]>([]);

  // Campaign-type ("Type") filter. The control lives in the LMS navbar
  // (LeadTypeFilter, beside the branch pill) and hands the selection over as
  // ?types=. Read only for a holder of lms.leads.view.all_types, so a
  // hand-typed URL does nothing for anyone else — leads-service ignores their
  // campaign_type_ids too. Which types a row may show at all stays the row
  // policy's answer (lms.fn_user_sees_campaign_type).
  const searchParams = useSearchParams();
  const typesParam = searchParams.get(LEAD_TYPES_PARAM);
  const canFilterTypes = canFilterLeadTypes(actor);
  const selectedCampaignTypes = useMemo(
    () => (canFilterTypes ? parseLeadTypesParam(typesParam) : []),
    [canFilterTypes, typesParam],
  );

  const platforms = useMemo(
    () => selectedSources.length > 0 ? selectedSources : undefined,
    [selectedSources],
  );
  const campaignTypeIds = useMemo(
    () => selectedCampaignTypes.length > 0 ? selectedCampaignTypes : undefined,
    [selectedCampaignTypes],
  );

  const {
    leads, stats, loading, error,
    statusOptions, statusLabelMap, requiresFollowupStatuses,
    rejectionStatuses, stageOutcomes, stageIdToName,
    updateLead, refetch,
    addLeadById, updateLeadById, removeLeadById,
  } = useLeads(orgIds, platforms, campaignTypeIds);

  // Fetched once here (not inside the embedded Follow-ups view) so the Due /
  // Overdue tiles count exactly the rows that view renders when clicked.
  const followUpPipeline = useFollowUps(actor, orgIds, campaignTypeIds);
  const refetchFollowUps = followUpPipeline.refetch;
  const refetchAll = useCallback(async () => {
    await Promise.all([refetch(), refetchFollowUps()]);
  }, [refetch, refetchFollowUps]);

  const { addNotification } = useNotifications();

  useRealtimeEvents(actor.id, {
    onLeadCreated: useCallback((leadId: string) => { addLeadById(leadId); void refetchFollowUps(); }, [addLeadById, refetchFollowUps]),
    onLeadUpdated: useCallback((leadId: string) => { updateLeadById(leadId); void refetchFollowUps(); }, [updateLeadById, refetchFollowUps]),
    onLeadDeleted: useCallback((leadId: string) => { removeLeadById(leadId); void refetchFollowUps(); }, [removeLeadById, refetchFollowUps]),
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

  // Assignees are no longer fetched here. This grid spans branches, so the only
  // correct list is the one for the branch of the row being edited — LeadsTable
  // asks useAssignableCandidates for exactly that, with the capability check
  // (never a role-name allowlist, which tenant-defined roles never match) living
  // inside the hook alongside it.

  const statGroups = useMemo(
    () => buildStatGroups(leads, { upcoming: followUpPipeline.upcoming, missed: followUpPipeline.missed }),
    [leads, followUpPipeline.upcoming, followUpPipeline.missed],
  );

  const handleFilterChange = (filter: CardFilter) => {
    setActiveFilter(prev => (prev === filter ? 'all' : filter));
  };

  const exportLeads = (format: ExportFormat) => {
    const rows     = applyLeadFilter(leads, activeFilter);
    const columns  = buildLeadExportColumns();
    const filename = buildFilename([
      branchLabel,
      activeFilter === 'all' ? '' : FILTER_LABELS[activeFilter],
    ]);
    exportRows(rows, columns, filename, format);
  };

  const exportableCount = applyLeadFilter(leads, activeFilter).length;

  // Rendered twice — inline in the toolbar on desktop, own row below it on mobile.
  const sourceRowsForFilter = statGroups[activeFilter].sources;
  const sourceTotal = activeFilter === 'all' ? stats.serverTotal : statGroups[activeFilter].count;

  return (
    <div className="flex w-full flex-1 flex-col bg-[#F8FAFC] lg:min-h-0">

      {/* Stats cards */}
      <div className="shrink-0 border-b border-[#E2E8F0] bg-white">
        <StatsCards
          stats={stats}
          groups={statGroups}
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          hideUnassigned={!canSeeUnassignedCard(getRulesForTenant(actor.tenant_id), actor.rank)}
        />
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#E2E8F0] bg-white px-4 py-1.5 sm:px-5 sm:py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 text-sm font-semibold text-[#0F172A]">{branchLabel}</span>
          {!loading && (
            <span
              className="shrink-0 rounded-full border border-[#E2E8F0] bg-[#F1F5F9] px-2 py-0.5 text-xs font-medium tabular-nums text-[#64748B]"
              title={selectedCampaignTypes.length > 0 ? 'This total already reflects the Type filter in the top bar' : undefined}
            >
              {activeFilter === 'all' ? `${stats.serverTotal} total` : `${exportableCount} of ${stats.serverTotal}`}
              {selectedCampaignTypes.length > 0 && ' (type-filtered)'}
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

        <SourceBreakdownBar
          rows={sourceRowsForFilter}
          total={sourceTotal}
          className="hidden flex-1 md:flex"
        />

        <div className="flex shrink-0 items-center gap-2">
          {error && (
            <span className="rounded-lg border border-orange-100 bg-orange-50 px-3 py-1.5 text-xs text-[#EA580C]">
              {error}
            </span>
          )}
          {!isFollowUpView && (
            <DownloadButton onExport={exportLeads} rowCount={exportableCount} disabled={loading} />
          )}
        </div>
      </div>

      {/* Source breakdown — its own scrollable row on mobile, where the toolbar has no room for it */}
      <SourceBreakdownBar
        rows={sourceRowsForFilter}
        total={sourceTotal}
        className="flex w-full shrink-0 border-b border-[#E2E8F0] bg-white px-4 py-1.5 md:hidden"
      />

      {/* Grid region */}
      <div className={`flex w-full flex-1 flex-col lg:min-h-0 lg:overflow-hidden ${isFollowUpView ? 'p-2 sm:px-5 sm:py-1.5' : 'p-2 sm:px-5 sm:py-3'}`}>
        {isFollowUpView ? (
          <div className="flex w-full min-w-0 flex-1 flex-col overflow-y-auto lg:min-h-0">
            <FollowUpsShell
              actor={actor}
              embedded
              pipeline={followUpPipeline}
              section={activeFilter === 'followUpDue' ? 'upcoming' : 'missed'}
            />
          </div>
        ) : (
          <div className="flex w-full flex-1 flex-col rounded-xl border border-[#E2E8F0] bg-white shadow-sm lg:min-h-0 lg:overflow-hidden">
            <LeadsTable
              leads={leads}
              loading={loading}
              statusFilter={activeFilter}
              onUpdate={updateLead}
              newLeadRowKeys={new Set()}
              statusOptions={statusOptions}
              statusLabelMap={statusLabelMap}
              actor={actor}
              onAssignmentChanged={refetchAll}
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
