'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { lead_sources } from '../lib/api/client';

export function useLeadSources() {
  const router = useRouter();
  const [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    lead_sources.list()
      .then((json) => {
        if (cancelled) return;
        const data = json.data;
        if (Array.isArray(data)) {
          setSources(
            data.map((d) =>
              typeof d === 'string' ? d : (d as Record<string, unknown>).name as string ?? '',
            ).filter(Boolean),
          );
        }
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 401) { router.replace('/login'); return; }
        setError(err instanceof Error ? err.message : 'Failed to load lead sources');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router]);

  return { sources, loading, error };
}
