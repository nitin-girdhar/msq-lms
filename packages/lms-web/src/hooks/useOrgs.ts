'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { orgs as orgsApi } from '@platform/ui-kit';

export interface DynamicOrg {
  id: string;
  name: string;
  cityId: number | null;
  stateId: number | null;
  countryId: number | null;
}

export interface LocationFilter {
  cityIds?: number[];
  stateIds?: number[];
  countryIds?: number[];
}

interface UseOrgsReturn {
  orgs: DynamicOrg[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useOrgs(locationFilter?: LocationFilter): UseOrgsReturn {
  const [orgs, setOrgs] = useState<DynamicOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef(locationFilter);
  filterRef.current = locationFilter;

  const fetchOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const f = filterRef.current;
      const params: { cityIds?: string; stateIds?: string; countryIds?: string } = {};
      if (f?.cityIds?.length)    params.cityIds    = f.cityIds.join(',');
      if (f?.stateIds?.length)   params.stateIds   = f.stateIds.join(',');
      if (f?.countryIds?.length) params.countryIds  = f.countryIds.join(',');

      const json = await orgsApi.list(params);
      const raw = json.data ?? [];

      setOrgs(
        raw.map((o) => ({
          id: o.id,
          name: o.name,
          cityId: o.cityId ?? o.city_id ?? null,
          stateId: o.stateId ?? o.state_id ?? null,
          countryId: o.countryId ?? o.country_id ?? null,
        })),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const filterKey = JSON.stringify(locationFilter);
  useEffect(() => {
    setOrgs([]);
    fetchOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, fetchOrgs]);

  return { orgs, loading, error, refresh: fetchOrgs };
}
