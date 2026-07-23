'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeadView } from '../types/leads';
import type { UpdatePayload, StageOption, StageOutcome } from '../types/leads';
import { leads as leadsApi } from '../lib/api/client';

export const DEFAULT_PAGE_SIZE = 5000;
export const MAX_PAGE_SIZE = 5000;

function sortNewestFirst(list: LeadView[]): LeadView[] {
  return [...list].sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : 0;
    return db - da;
  });
}

interface UseLeadsReturn {
  leads: LeadView[];
  stats: { total: number; lastUpdated: Date | null; serverTotal: number };
  loading: boolean;
  error: string | null;
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  statusOptions: string[];
  statusLabelMap: Record<string, string>;
  requiresFollowupStatuses: string[];
  rejectionStatuses: string[];
  stageOutcomes: StageOutcome[];
  stageIdToName: Record<string, string>;
  updateLead: (payload: UpdatePayload) => Promise<void>;
  refetch: () => Promise<void>;
  addLeadById: (leadId: string) => Promise<void>;
  updateLeadById: (leadId: string) => Promise<void>;
  removeLeadById: (leadId: string) => void;
}

export function useLeads(orgIds?: string[], platforms?: string[]): UseLeadsReturn {
  const [leads, setLeads]           = useState<LeadView[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [page, setPage]             = useState(1);
  const [pageSize, setPageSize]     = useState(DEFAULT_PAGE_SIZE);
  const [statusOptions, setStatusOptions]           = useState<string[]>([]);
  const [statusLabelMap, setStatusLabelMap]         = useState<Record<string, string>>({});
  const [requiresFollowupStatuses, setRequiresFollowup] = useState<string[]>([]);
  const [rejectionStatuses, setRejectionStatuses]   = useState<string[]>([]);
  const [stageOutcomes, setStageOutcomes]           = useState<StageOutcome[]>([]);
  const [stageIdToName, setStageIdToName]           = useState<Record<string, string>>({});

  const orgIdsRef        = useRef(orgIds);
  const platformsRef     = useRef(platforms);
  const pageRef          = useRef(page);
  const pageSizeRef      = useRef(pageSize);
  const stageNameToIdRef = useRef<Record<string, string>>({});
  orgIdsRef.current    = orgIds;
  platformsRef.current = platforms;
  pageRef.current      = page;
  pageSizeRef.current  = pageSize;

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const ids   = orgIdsRef.current;
      const plats = platformsRef.current;

      // Empty array = location filter active but no orgs match → show nothing
      if (ids !== undefined && ids.length === 0) {
        setLeads([]);
        setLastUpdated(new Date());
        setError(null);
        return;
      }

      const params: Parameters<typeof leadsApi.list>[0] = {
        page: pageRef.current,
        page_size: Math.min(pageSizeRef.current, MAX_PAGE_SIZE),
      };
      if (ids?.length)   params.org_ids   = ids.join(',');
      if (plats?.length) params.platforms = plats.join(',');
      const data = await leadsApi.list(params);

      const rawStages = (data.stage_options ?? []) as StageOption[];
      const rawOutcomes = (data.stage_outcomes ?? []) as StageOutcome[];

      const opts    = rawStages.map((s) => s.name);
      const labelMap: Record<string, string> = {};
      const followup: string[] = [];
      const rejected: string[] = [];
      const idToName: Record<string, string> = {};
      const nameToId: Record<string, string> = {};

      for (const s of rawStages) {
        labelMap[s.name] = s.label;
        idToName[s.id]   = s.name;
        nameToId[s.name] = s.id;
        if (s.followup_required) followup.push(s.name);
        if (s.is_rejected)       rejected.push(s.name);
      }
      stageNameToIdRef.current = nameToId;

      setStatusOptions(opts);
      setStatusLabelMap(labelMap);
      setRequiresFollowup(followup);
      setRejectionStatuses(rejected);
      setStageOutcomes(rawOutcomes);
      setStageIdToName(idToName);
      setLeads(sortNewestFirst(data.data));
      setServerTotal(typeof data.total === 'number' ? data.total : data.data.length);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const orgIdsKey    = orgIds?.join(',') ?? '';
  const platformsKey = platforms?.join(',') ?? '';

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1);
  }, [orgIdsKey, platformsKey]);

  useEffect(() => {
    setLeads([]);
    setLoading(true);
    setLastUpdated(null);
    fetchData(false);
  }, [orgIdsKey, platformsKey, page, pageSize, fetchData]);

  const updateLead = useCallback(
    async (payload: UpdatePayload) => {
      setLeads((prev) =>
        prev.map((l) => {
          if (l.lead_id !== payload.leadId) return l;
          if (payload.field === 'stage') return { ...l, stage: payload.value };
          if (payload.field === 'comments') return { ...l, metadata: { ...l.metadata, remarks: payload.value } };
          return l;
        }),
      );

      const patchData: Record<string, unknown> = {};
      if (payload.field === 'stage') {
        const stage_id = stageNameToIdRef.current[payload.value];
        if (stage_id) patchData.stage_id = stage_id;
        if (payload.outcomeId)      patchData.outcome_id      = payload.outcomeId;
        if (payload.outcomeComment) patchData.outcome_comment = payload.outcomeComment;
        if (payload.transitionNote) patchData.transition_note = payload.transitionNote;
      } else {
        patchData.metadata = { remarks: payload.value };
      }
      if (payload.expectedUpdatedAt) patchData.expected_updated_at = payload.expectedUpdatedAt;

      try {
        await leadsApi.update(payload.leadId, patchData);
        if (payload.field === 'stage' && payload.followUp) {
          const fu = payload.followUp;
          const fuData: Record<string, unknown> = { scheduled_at: fu.scheduledAt };
          if (fu.assignedUserId) fuData.assigned_user_id = fu.assignedUserId;
          if (fu.notes)          fuData.notes             = fu.notes;
          await leadsApi.addFollowUp(payload.leadId, fuData);
        }
      } catch (err) {
        await fetchData(true);
        throw err;
      }
    },
    [fetchData],
  );

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  const addLeadById = useCallback(async (leadId: string) => {
    try {
      // Re-fetch via the full list endpoint for a single lead to get the
      // dashboard view shape (lead_id, stage label, rep name, etc.)
      await fetchData(true);
    } catch {
      // Lead not visible to this user (RLS) — ignore
    }
  }, [fetchData]);

  const updateLeadById = useCallback(async (leadId: string) => {
    try {
      await fetchData(true);
    } catch {
      // Silent refetch failed — ignore
    }
  }, [fetchData]);

  const removeLeadById = useCallback((leadId: string) => {
    setLeads((prev) => prev.filter((l) => l.lead_id !== leadId));
    setServerTotal((t) => Math.max(0, t - 1));
  }, []);

  return {
    leads,
    stats: { total: leads.length, lastUpdated, serverTotal },
    loading,
    error,
    page,
    pageSize,
    setPage,
    setPageSize,
    statusOptions,
    statusLabelMap,
    requiresFollowupStatuses,
    rejectionStatuses,
    stageOutcomes,
    stageIdToName,
    updateLead,
    refetch,
    addLeadById,
    updateLeadById,
    removeLeadById,
  };
}
