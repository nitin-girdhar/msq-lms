'use client';

import { useCallback, useRef, useState } from 'react';
import type { AssignmentView, StageOption, StageOutcome } from '../types/leads';
import { assignments as api } from '../lib/api/client';

export interface LeadsHistoryFilters {
  page: number;
  page_size: number;
  date_from?: string | undefined;
  date_to?: string | undefined;
  stage_ids?: string | undefined;
  outcome_ids?: string | undefined;
  org_ids?: string | undefined;
  assigned_to?: string | undefined;
  active_only?: boolean | undefined;
  [key: string]: string | number | boolean | undefined;
}

export function useLeadsHistory() {
  const [data, setData] = useState<AssignmentView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageOptions, setStageOptions] = useState<StageOption[]>([]);
  const [stageOutcomes, setStageOutcomes] = useState<StageOutcome[]>([]);
  const filtersRef = useRef<LeadsHistoryFilters | null>(null);

  const fetchData = useCallback(async (filters: LeadsHistoryFilters) => {
    filtersRef.current = filters;
    setLoading(true);
    setError(null);
    try {
      const res = await api.leadsHistory(filters);
      setData(res.data as unknown as AssignmentView[]);
      setTotal(typeof res.total === 'number' ? res.total : 0);
      setPage(res.page);
      setPageSize(res.page_size);
      setStageOptions((res.stage_options ?? []) as StageOption[]);
      setStageOutcomes((res.stage_outcomes ?? []) as StageOutcome[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  const goToPage = useCallback((newPage: number) => {
    if (!filtersRef.current) return;
    fetchData({ ...filtersRef.current, page: newPage });
  }, [fetchData]);

  const changePageSize = useCallback((newSize: number) => {
    if (!filtersRef.current) return;
    fetchData({ ...filtersRef.current, page: 1, page_size: newSize });
  }, [fetchData]);

  return {
    data,
    total,
    page,
    pageSize,
    loading,
    error,
    stageOptions,
    stageOutcomes,
    fetchData,
    goToPage,
    changePageSize,
  };
}
