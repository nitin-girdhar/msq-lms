'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionUser } from '@platform/types';
import { followUps as followUpsApi } from '../lib/api/client';
import type { FollowUpItem } from '../lib/leads/followup-format';

interface UseFollowUpsReturn {
  all: FollowUpItem[];
  /** Scheduled now or later, soonest first. */
  upcoming: FollowUpItem[];
  /** Scheduled time already passed, most overdue first. */
  missed: FollowUpItem[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * The follow-up pipeline for the given branches / campaign types.
 *
 * Due vs overdue is decided by the server (`isOverdue` = scheduled_at < NOW()
 * at query time), so the counts are a snapshot of when the page loaded or last
 * refetched — the same list the Leads tiles count and the sections render,
 * which is what keeps "tile says 12" and "section shows 12" in agreement.
 *
 * `orgIds` undefined = every branch the server lets this actor read (the
 * session's "All branches"); the server pins non-tenant-wide actors to their
 * session org regardless. `enabled: false` skips fetching entirely, for a
 * caller that is handed the list by a parent instead.
 */
export function useFollowUps(
  actor: SessionUser,
  orgIds?: string[],
  campaignTypeIds?: string[],
  enabled = true,
): UseFollowUpsReturn {
  const [all, setAll] = useState<FollowUpItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const isSalesRep = actor.role === 'sales_representative';
  const orgIdsRef = useRef(orgIds);
  const typesRef = useRef(campaignTypeIds);
  orgIdsRef.current = orgIds;
  typesRef.current = campaignTypeIds;

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params: Parameters<typeof followUpsApi.list>[0] = {};
      if (isSalesRep) params.assignedRepId = actor.id;
      if (orgIdsRef.current?.length) params.org_ids = orgIdsRef.current.join(',');
      if (typesRef.current?.length) params.campaign_type_ids = typesRef.current.join(',');
      const body = await followUpsApi.list(params);
      setAll((body.data ?? body.pipeline ?? []) as FollowUpItem[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [isSalesRep, actor.id]);

  const orgIdsKey = orgIds?.join(',') ?? '';
  const typesKey = campaignTypeIds?.join(',') ?? '';
  useEffect(() => {
    if (!enabled) return;
    void fetchData(false);
  }, [enabled, orgIdsKey, typesKey, fetchData]);

  const upcoming = useMemo(
    () => all
      .filter((f) => f.isOverdue === false)
      .sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()),
    [all],
  );
  const missed = useMemo(
    () => all
      .filter((f) => f.isOverdue === true)
      .sort((a, b) => (b.minutesOverdue ?? 0) - (a.minutesOverdue ?? 0)),
    [all],
  );

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  return { all, upcoming, missed, loading, error, refetch };
}
