'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { SessionUser } from '@platform/types';
import { MultiSelect } from '@platform/ui-kit';
import { campaign_types as campaignTypesApi } from '../../lib/api/client';
import { LEAD_TYPES_PARAM, canFilterLeadTypes, parseLeadTypesParam } from '../../lib/leads/type-filter';
import type { CampaignType } from '../../types/leads';

// The only page this filter drives. usePathname() is basePath-relative, so this
// is the same on every deployment prefix.
const LEADS_PATH = '/dashboard/leads';

interface Props {
  actor: SessionUser;
}

// Navbar "Type" filter for the Leads page — mounted in AppNavbar's filterSlot,
// right beside the branch pill. It renders NOTHING off the Leads page and for
// anyone without lms.leads.view.all_types (canFilterLeadTypes): those users see
// their own department's leads, which the server decides, and have nothing to
// narrow. The selection is written to ?types= and read by LeadDashboardShell.
//
// AppNavbar mounts a slot twice (inline on sm+, mobile row below), so this
// component can be live twice at once. Both copies read and write the same URL
// param, so they can never disagree.
export default function LeadTypeFilter({ actor }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const active = pathname === LEADS_PATH && canFilterLeadTypes(actor);

  const [types, setTypes] = useState<CampaignType[]>([]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await campaignTypesApi.list();
        if (!cancelled) setTypes((res.data ?? []).filter((t) => t.is_active));
      } catch { /* hides the filter below — never blocks the page */ }
    })();
    return () => { cancelled = true; };
  }, [active]);

  const selectedIds = useMemo(
    () => parseLeadTypesParam(searchParams.get(LEAD_TYPES_PARAM)),
    [searchParams],
  );

  if (!active || types.length === 0) return null;

  const options = types.map((t) => ({ id: t.id, label: t.label }));
  const onChange = (next: { id: string | number }[]) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next.length > 0) params.set(LEAD_TYPES_PARAM, next.map((o) => String(o.id)).join(','));
    else params.delete(LEAD_TYPES_PARAM);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <MultiSelect
      label="Type"
      placeholder="All types"
      options={options}
      selected={options.filter((o) => selectedIds.includes(o.id))}
      onChange={onChange}
    />
  );
}
