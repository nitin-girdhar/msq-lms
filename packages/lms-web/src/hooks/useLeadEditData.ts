'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionUser } from '@platform/types';
import type { StageOption, StageOutcome, UpdatePayload } from '../types/leads';
import { lookups, leads as leadsApi } from '../lib/api/client';
import { users as usersApi } from '@platform/ui-kit';
import { CAN_ASSIGN_ROLES } from '../components/leads/constants';

interface UseLeadEditDataReturn {
  statusOptions: string[];
  statusLabelMap: Record<string, string>;
  followUpSet: Set<string>;
  rejectionSet: Set<string>;
  stageOutcomes: StageOutcome[];
  stageIdToName: Record<string, string>;
  candidates: SessionUser[];
  updateLead: (payload: UpdatePayload) => Promise<void>;
  loading: boolean;
}

export function useLeadEditData(actor: SessionUser): UseLeadEditDataReturn {
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [statusLabelMap, setStatusLabelMap] = useState<Record<string, string>>({});
  const [requiresFollowup, setRequiresFollowup] = useState<string[]>([]);
  const [rejectionStatuses, setRejectionStatuses] = useState<string[]>([]);
  const [stageOutcomes, setStageOutcomes] = useState<StageOutcome[]>([]);
  const [stageIdToName, setStageIdToName] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(true);

  const stageNameToIdRef = useRef<Record<string, string>>({});
  const canAssign = CAN_ASSIGN_ROLES.includes(actor.role);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [stagesRes, outcomesRes] = await Promise.all([
          lookups.leadStages() as Promise<{ success: true; data: StageOption[] }>,
          lookups.leadStageOutcomes() as Promise<{ success: true; data: StageOutcome[] }>,
        ]);

        if (cancelled) return;

        const rawStages = stagesRes.data ?? [];
        const rawOutcomes = outcomesRes.data ?? [];

        const opts: string[] = [];
        const labelMap: Record<string, string> = {};
        const followup: string[] = [];
        const rejected: string[] = [];
        const idToName: Record<string, string> = {};
        const nameToId: Record<string, string> = {};

        for (const s of rawStages) {
          opts.push(s.name);
          labelMap[s.name] = s.label;
          idToName[s.id] = s.name;
          nameToId[s.name] = s.id;
          if (s.followup_required) followup.push(s.name);
          if (s.is_rejected) rejected.push(s.name);
        }

        stageNameToIdRef.current = nameToId;
        setStatusOptions(opts);
        setStatusLabelMap(labelMap);
        setRequiresFollowup(followup);
        setRejectionStatuses(rejected);
        setStageOutcomes(rawOutcomes);
        setStageIdToName(idToName);
      } catch {
        // Stages/outcomes fetch failed — edit modal will have empty options
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!canAssign) { setCandidates([]); return; }
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
  }, [canAssign]);

  const followUpSet = useMemo(() => new Set(requiresFollowup), [requiresFollowup]);
  const rejectionSet = useMemo(() => new Set(rejectionStatuses), [rejectionStatuses]);

  const updateLead = useCallback(async (payload: UpdatePayload) => {
    const patchData: Record<string, unknown> = {};
    if (payload.field === 'stage') {
      const stage_id = stageNameToIdRef.current[payload.value];
      if (stage_id) patchData.stage_id = stage_id;
      if (payload.outcomeId) patchData.outcome_id = payload.outcomeId;
      if (payload.outcomeComment) patchData.outcome_comment = payload.outcomeComment;
      if (payload.transitionNote) patchData.transition_note = payload.transitionNote;
    } else {
      patchData.metadata = { remarks: payload.value };
    }

    await leadsApi.update(payload.leadId, patchData);

    if (payload.field === 'stage' && payload.followUp) {
      const fu = payload.followUp;
      const fuData: Record<string, unknown> = { scheduled_at: fu.scheduledAt };
      if (fu.assignedUserId) fuData.assigned_user_id = fu.assignedUserId;
      if (fu.notes) fuData.notes = fu.notes;
      await leadsApi.addFollowUp(payload.leadId, fuData);
    }
  }, []);

  return {
    statusOptions,
    statusLabelMap,
    followUpSet,
    rejectionSet,
    stageOutcomes,
    stageIdToName,
    candidates,
    updateLead,
    loading,
  };
}
