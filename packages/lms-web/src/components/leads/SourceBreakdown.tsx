'use client';

import { useMemo } from 'react';
import type { LeadView } from '../../types/leads';
import { hashSourceColor } from './SourceBadge';

interface Props {
  leads: LeadView[];
}

export function SourceBreakdown({ leads }: Props) {
  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lead of leads) {
      const key = lead.source_label ?? lead.source ?? 'Unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count, ...hashSourceColor(label) }))
      .sort((a, b) => b.count - a.count);
  }, [leads]);

  if (rows.length === 0) return null;

  const max = Math.max(...rows.map((r) => r.count));

  return (
    <div className="px-4 sm:px-5 pb-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2 min-w-[140px]">
          <span style={{ background: row.dot }} className="w-2 h-2 rounded-full shrink-0" />
          <span className="text-xs font-medium text-[#475569] whitespace-nowrap">{row.label}</span>
          <span className="text-xs font-bold text-[#0F172A] tabular-nums">{row.count}</span>
          <div className="w-16 h-1.5 rounded-full bg-[#F1F5F9] overflow-hidden shrink-0">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(6, (row.count / max) * 100)}%`, background: row.dot }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
