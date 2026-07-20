'use client';

import { useEffect, useState } from 'react';
import type { LeadFormData, LeadFormDataField } from '../../types/leads';
import { leads as leadsApi } from '../../lib/api/client';

// ── Presentational: question → answer grid ──────────────────────────────────
// Reusable wherever form-submission data is already fetched (e.g. history timeline).

export function LeadFormDataFields({ fields }: { fields: LeadFormDataField[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5 min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">{f.label}</dt>
          <dd className="break-words text-sm text-[#0F172A]">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Self-fetching, collapsible panel ─────────────────────────────────────────
// Generic lead-level section: drop it into any modal/page with a lead id.
// Renders nothing when the lead has no captured form submission.

interface LeadFormDataPanelProps {
  leadId: string;
  source?: string | null | undefined;
  defaultOpen?: boolean;
  className?: string | undefined;
}

export function LeadFormDataPanel({ leadId, source, defaultOpen = false, className }: LeadFormDataPanelProps) {
  const [data, setData] = useState<LeadFormData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    let cancelled = false;
    leadsApi
      .getFormData(leadId)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load form data'); });
    return () => { cancelled = true; };
  }, [leadId]);

  if (error) return null;
  if (!data || data.fields.length === 0) return null;

  const sourceLabel = source
    ? source.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : null;

  return (
    <div className={`px-6 py-4 ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">
            Form Submission
          </span>
          {sourceLabel && (
            <span className="inline-block rounded-full bg-[#EFF6FF] px-2 py-0.5 text-[10px] font-semibold text-[#1D4ED8]">
              {sourceLabel}
            </span>
          )}
          <span className="text-[10px] font-semibold text-[#94A3B8]">
            {data.fields.length} field{data.fields.length !== 1 ? 's' : ''}
          </span>
        </span>
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-[#94A3B8] transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="mt-3">
          <LeadFormDataFields fields={data.fields} />
        </div>
      )}
    </div>
  );
}
