import type { LeadView } from '../../types/leads';
import { StatusBadge } from './StatusBadge';
import { LeadAssigneeBadge } from './LeadAssigneeBadge';

interface Props {
  lead: LeadView;
  isNew: boolean;
  statusLabelMap?: Record<string, string>;
  onEditClick: (lead: LeadView) => void;
  onHistoryClick: (lead: LeadView) => void;
}

export function MobileLeadCard({ lead, isNew, statusLabelMap, onEditClick, onHistoryClick }: Props) {
  const assigneeName = lead.assigned_rep_name ?? null;

  return (
    <div className={[
      'bg-white rounded-2xl border shadow-sm mx-4 flex flex-col gap-0 overflow-hidden transition-shadow',
      isNew ? 'border-[#93C5FD] shadow-blue-100' : 'border-[#E2E8F0]',
    ].join(' ')}>
      {isNew && (
        <div className="bg-[#DBEAFE] px-4 py-1.5 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] animate-pulse" />
          <span className="text-xs font-semibold text-[#1D4ED8]">New Lead</span>
        </div>
      )}

      <div className="px-4 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-base font-bold text-[#0F172A] truncate">{lead.full_name || '—'}</span>
          <a href={`tel:${lead.phone}`} className="text-sm font-medium text-[#0A6BA8] flex items-center gap-1">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498A1 1 0 0121 17.72V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
            {lead.phone || '—'}
          </a>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0 pt-0.5">
          <StatusBadge value={lead.stage ?? ''} labelMap={statusLabelMap ?? {}} />
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => onEditClick(lead)}
              className="flex items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-semibold text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf] active:scale-[0.97]"
              style={{ minHeight: 28 }}>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit
            </button>
            <button type="button" onClick={() => onHistoryClick(lead)}
              className="flex items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-semibold text-[#475569] transition-colors hover:border-[#7C3AED] hover:text-[#7C3AED] active:scale-[0.97]"
              style={{ minHeight: 28 }}>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              History
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 pb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8]">Assigned To</span>
        <LeadAssigneeBadge name={assigneeName} />
      </div>

      <div className="h-px bg-[#F1F5F9] mx-4" />

      <div className="px-4 py-3 flex flex-col gap-2">
        {lead.org_name && (
          <div className="flex items-start gap-2">
            <span className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide w-20 shrink-0 pt-0.5">Branch</span>
            <span className="text-sm text-[#0F172A]">{lead.org_name}</span>
          </div>
        )}
        {lead.address_line1 && (
          <div className="flex items-start gap-2">
            <span className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide w-20 shrink-0 pt-0.5">Address</span>
            <span className="text-sm text-[#0F172A]">{lead.address_line1}</span>
          </div>
        )}
        {lead.campaign_name && (
          <div className="flex items-start gap-2">
            <span className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide w-20 shrink-0 pt-0.5">Campaign</span>
            <span className="text-sm text-[#475569]">{lead.campaign_name}</span>
          </div>
        )}
        {lead.created_at && (
          <div className="flex items-start gap-2">
            <span className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide w-20 shrink-0 pt-0.5">Date</span>
            <span className="text-sm text-[#64748B]">{new Date(lead.created_at).toLocaleDateString('en-IN')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
