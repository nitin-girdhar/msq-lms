'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { locations as locationsApi } from '../lib/api/client';

export interface LocationOption {
  id: number;
  name: string;
  isoCode?: string;
  countryId?: number;
  stateId?: number;
}

interface UseLocationFiltersReturn {
  countries: LocationOption[];
  states: LocationOption[];
  cities: LocationOption[];
  selectedCountries: LocationOption[];
  selectedStates: LocationOption[];
  selectedCities: LocationOption[];
  setSelectedCountries: (next: LocationOption[]) => void;
  setSelectedStates: (next: LocationOption[]) => void;
  setSelectedCities: (next: LocationOption[]) => void;
  loadingCountries: boolean;
  loadingStates: boolean;
  loadingCities: boolean;
}

async function fetchLocations(
  params: { level?: string; countryIds?: string; stateIds?: string },
  router: ReturnType<typeof useRouter>,
): Promise<LocationOption[]> {
  try {
    const json = await locationsApi.list(params);
    return Array.isArray(json.data) ? (json.data as LocationOption[]) : [];
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) { router.replace('/login'); return []; }
    throw err;
  }
}

export function useLocationFilters(): UseLocationFiltersReturn {
  const router = useRouter();

  const [countries, setCountries] = useState<LocationOption[]>([]);
  const [states, setStates]       = useState<LocationOption[]>([]);
  const [cities, setCities]       = useState<LocationOption[]>([]);

  const [selectedCountries, _setSelectedCountries] = useState<LocationOption[]>([]);
  const [selectedStates, _setSelectedStates]       = useState<LocationOption[]>([]);
  const [selectedCities, _setSelectedCities]       = useState<LocationOption[]>([]);

  const [loadingCountries, setLoadingCountries] = useState(false);
  const [loadingStates, setLoadingStates]       = useState(false);
  const [loadingCities, setLoadingCities]       = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingCountries(true);
    fetchLocations({ level: 'countries' }, router)
      .then((data) => { if (!cancelled) setCountries(data); })
      .catch(() => { if (!cancelled) setCountries([]); })
      .finally(() => { if (!cancelled) setLoadingCountries(false); });
    return () => { cancelled = true; };
  }, [router]);

  const countryKey = selectedCountries.map((c) => c.id).join(',');
  useEffect(() => {
    if (!countryKey) { setStates([]); return; }
    let cancelled = false;
    setLoadingStates(true);
    fetchLocations({ level: 'states', countryIds: countryKey }, router)
      .then((data) => { if (!cancelled) setStates(data); })
      .catch(() => { if (!cancelled) setStates([]); })
      .finally(() => { if (!cancelled) setLoadingStates(false); });
    return () => { cancelled = true; };
  }, [countryKey, router]);

  const stateKey = selectedStates.map((s) => s.id).join(',');
  useEffect(() => {
    if (!stateKey) { setCities([]); return; }
    let cancelled = false;
    setLoadingCities(true);
    fetchLocations({ level: 'cities', stateIds: stateKey }, router)
      .then((data) => { if (!cancelled) setCities(data); })
      .catch(() => { if (!cancelled) setCities([]); })
      .finally(() => { if (!cancelled) setLoadingCities(false); });
    return () => { cancelled = true; };
  }, [stateKey, router]);

  const setSelectedCountries = useCallback((next: LocationOption[]) => {
    _setSelectedCountries(next);
    _setSelectedStates([]);
    _setSelectedCities([]);
  }, []);

  const setSelectedStates = useCallback((next: LocationOption[]) => {
    _setSelectedStates(next);
    _setSelectedCities([]);
  }, []);

  const setSelectedCities = useCallback((next: LocationOption[]) => {
    _setSelectedCities(next);
  }, []);

  return {
    countries, states, cities,
    selectedCountries, selectedStates, selectedCities,
    setSelectedCountries, setSelectedStates, setSelectedCities,
    loadingCountries, loadingStates, loadingCities,
  };
}
