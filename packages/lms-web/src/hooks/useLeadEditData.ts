'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionUser } from '@platform/types';
import type { StageOption, StageOutcome, UpdatePayload } from '../types/leads';
import { lookups, leads as leadsApi } from '../lib/api/client';
import { users as usersApi } from '@platform/ui-kit';
import { can, CAPABILITY } from '@platform/rbac';
import { toAssignableUsers } from '../lib/users/assignable';

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
  /** Set when the stage/outcome catalog could not be loaded — the edit modal's
   *  follow-up rule depends on it, so saving must be blocked rather than run
   *  against an empty catalog. */
  loadError: string | null;
}

// `leadOrgId` is the branch of the lead currently being edited. Candidates are
// fetched for that branch because iam.can_assign_to judges the write against
// the lead's org, not the caller's current one.
export function useLeadEditData(actor: SessionUser, leadOrgId?: string): UseLeadEditDataReturn {
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [statusLabelMap, setStatusLabelMap] = useState<Record<string, string>>({});
  const [requiresFollowup, setRequiresFollowup] = useState<string[]>([]);
  const [rejectionStatuses, setRejectionStatuses] = useState<string[]>([]);
  const [stageOutcomes, setStageOutcomes] = useState<StageOutcome[]>([]);
  const [stageIdToName, setStageIdToName] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const stageNameToIdRef = useRef<Record<string, string>>({});
  const canAssign = can(actor, CAPABILITY.LMS_LEADS_ASSIGN);

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
      } catch (err) {
        // Never swallow this. followUpSet is derived from the stage catalog, so a
        // failed fetch leaves it empty — the Follow-up Due field then does not
        // render and its "required" check cannot fire, and a status change into
        // `contacting` saves with no follow-up at all. The modal disables saving
        // rather than silently dropping the rule.
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load lead statuses');
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
        // Scoped to the LEAD's branch, because that is the org
        // iam.can_assign_to is evaluated against: the target must hold an active
        // mapping there. The server now returns candidates across every branch
        // the actor covers, so without this a Wingman covering six branches
        // would be offered ~16 names of whom only the lead's own branch could
        // actually be assigned — a picker full of choices the write rejects.
        // Falls back to full coverage when no lead is in context.
        const json = await usersApi.assignable(
          leadOrgId ? { product: 'lms', orgId: leadOrgId } : { product: 'lms' },
        );
        if (cancelled) return;
        setCandidates(toAssignableUsers(json.data));
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => { cancelled = true; };
  }, [canAssign, leadOrgId]);

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
    if (payload.expectedUpdatedAt) patchData.expected_updated_at = payload.expectedUpdatedAt;

    // The follow-up rides along on the PATCH rather than following it as a second
    // request: leads-service opens it in the same transaction as the stage move,
    // so a lead can never land in a followup_required stage without a due time.
    if (payload.field === 'stage' && payload.followUp) {
      const fu = payload.followUp;
      patchData.follow_up_scheduled_at = fu.scheduledAt;
      if (fu.assignedUserId) patchData.follow_up_assigned_user_id = fu.assignedUserId;
    }

    await leadsApi.update(payload.leadId, patchData);
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
    loadError,
  };
}
