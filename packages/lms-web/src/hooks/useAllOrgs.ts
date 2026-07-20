'use client';

import { useEffect, useState } from 'react';
import { orgs as orgsApi } from '@platform/ui-kit';

export interface OrgOption {
  id: string;
  name: string;
}

export function useAllOrgs() {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await orgsApi.all();
        if (cancelled) return;
        const list = Array.isArray(json.data) ? json.data : [];
        setOrgs(
          list
            .filter((o) => o && typeof o === 'object' && o.id && o.name)
            .map((o) => ({ id: o.id, name: o.name })),
        );
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load orgs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { orgs, loading, error };
}
