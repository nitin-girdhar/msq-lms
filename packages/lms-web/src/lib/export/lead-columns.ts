'use client';

import type { LeadView } from '../../types/leads';
import type { ExportColumn } from '@platform/ui-kit';

export function buildLeadExportColumns(): ExportColumn<LeadView>[] {
  return [
    { header: 'Date', value: (l) => l.created_at ? new Date(l.created_at).toLocaleDateString() : '' },
    { header: 'Campaign', value: (l) => l.campaign_name ?? '' },
    { header: 'Name', value: (l) => l.full_name },
    { header: 'Phone', value: (l) => l.phone ?? '' },
    { header: 'Address', value: (l) => l.address_line1 ?? l.city_name ?? l.city ?? '' },
    { header: 'Lead Source', value: (l) => l.source ?? '' },
    { header: 'Status', value: (l) => l.stage_label ?? l.stage },
    { header: 'Outcome', value: (l) => l.outcome_label ?? l.outcome ?? '' },
    { header: 'Remarks', value: (l) => (l.metadata?.remarks as string) ?? '' },
    { header: 'Assigned To', value: (l) => l.assigned_rep_name ?? '' },
    { header: 'Org', value: (l) => l.org_name ?? '' },
    { header: 'City', value: (l) => l.city_name ?? l.city ?? '' },
  ];
}
