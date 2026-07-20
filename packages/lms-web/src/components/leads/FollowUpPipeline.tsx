'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LeadView } from '../../types/leads';
import { followUps as followUpsApi } from '../../lib/api/client';
import { LeadHistoryModal } from '../LeadHistoryModal';

interface FollowUpEnriched {
  followUpId: string;
  leadId: string;
  leadFullName: string;
  leadPhone: string | null;
  leadStage: string;
  assignedRepName: string;
  assignedRepEmail: string;
  isOverdue: boolean;
  minutesOverdue: number | null;
  followUpStatus: string;
  scheduledAt: string;
  lastInteractionAt: string | null;
  lastInteractionType: string | null;
  notes: string | null;
}

interface Props {
  assignedRepId?: string;
  overdueOnly?: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function OverdueBadge({ minutes }: { minutes: number }) {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const label = hrs > 0 ? `${hrs}h ${mins}m overdue` : `${mins}m overdue`;
  return (
    <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
      {label}
    </span>
  );
}

function followUpToLeadView(item: FollowUpEnriched): LeadView {
  return {
    lead_id: item.leadId, org_id: '', org_name: '', first_name: '', middle_name: null, last_name: '',
    full_name: item.leadFullName, phone: item.leadPhone, email: null, address_line1: null,
    city: null, city_name: null, state_name: null, country_name: null,
    stage: item.leadStage, stage_label: item.leadStage.replace(/_/g, ' '), source: null,
    followup_required: false, is_rejected: false, is_terminated: false,
    outcome: null, outcome_label: null, outcome_comment: null, stage_id: '', outcome_id: null,
    scheduled_at: item.scheduledAt, is_followup_overdue: item.isOverdue,
    campaign_name: null, platform: null, assigned_rep_name: item.assignedRepName,
    assigned_rep_email: item.assignedRepEmail, tags: [], metadata: {},
    created_at: new Date(), updated_at: new Date(), is_deleted: false,
    assigned_user_id: null, campaign_id: null,
  };
}

export function FollowUpPipeline({ assignedRepId, overdueOnly }: Props) {
  const [pipeline, setPipeline] = useState<FollowUpEnriched[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyLead, setHistoryLead] = useState<FollowUpEnriched | null>(null);

  const fetchPipeline = useCallback(() => {
    setLoading(true);
    setError(null);
    const params: { assignedRepId?: string; overdueOnly?: string } = {};
    if (assignedRepId) params.assignedRepId = assignedRepId;
    if (overdueOnly) params.overdueOnly = 'true';

    followUpsApi.list(params)
      .then((body) => {
        const data = (body.data ?? body.pipeline ?? []) as FollowUpEnriched[];
        setPipeline(data);
      })
      .catch((err) => setError((err as Error).message ?? 'Failed to load follow-ups'))
      .finally(() => setLoading(false));
  }, [assignedRepId, overdueOnly]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-[#64748B]">
        Loading follow-ups…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-red-500">
        {error}
      </div>
    );
  }

  if (!pipeline.length) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-[#64748B]">
        {overdueOnly ? 'No overdue follow-ups.' : 'No pending follow-ups.'}
      </div>
    );
  }

  return (
    <>
    <div className="overflow-x-auto rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <table className="min-w-full divide-y divide-[#F1F5F9] text-sm">
        <thead className="bg-[#F8FAFC]">
          <tr>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">Lead</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">Assigned To</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">Status</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">Scheduled</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">Last Interaction</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">Notes</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[#F1F5F9] bg-white">
          {pipeline.map((item) => (
            <tr
              key={item.followUpId}
              className={item.isOverdue ? 'bg-red-50' : undefined}
            >
              <td className="px-4 py-3">
                <p className="font-semibold text-[#0F172A]">{item.leadFullName}</p>
                {item.leadPhone && (
                  <p className="text-xs text-[#64748B]">{item.leadPhone}</p>
                )}
                <span className="mt-0.5 inline-block rounded-full border border-[#E2E8F0] bg-[#F1F5F9] px-2 py-0.5 text-xs text-[#475569]">
                  {item.leadStage.replace(/_/g, ' ')}
                </span>
              </td>
              <td className="px-4 py-3">
                <p className="text-[#0F172A]">{item.assignedRepName}</p>
                <p className="text-xs text-[#64748B]">{item.assignedRepEmail}</p>
              </td>
              <td className="px-4 py-3">
                {item.isOverdue ? (
                  <OverdueBadge minutes={item.minutesOverdue ?? 0} />
                ) : (
                  <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                    {item.followUpStatus.replace(/_/g, ' ')}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-[#475569]">
                {formatDate(item.scheduledAt)}
              </td>
              <td className="px-4 py-3 text-[#64748B]">
                {item.lastInteractionAt ? (
                  <>
                    <p className="text-xs">{formatDate(item.lastInteractionAt)}</p>
                    {item.lastInteractionType && (
                      <p className="text-xs text-[#94A3B8]">{item.lastInteractionType}</p>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-[#94A3B8]">—</span>
                )}
              </td>
              <td className="max-w-[200px] px-4 py-3 text-xs text-[#64748B]">
                {item.notes ?? <span className="text-[#94A3B8]">—</span>}
              </td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => setHistoryLead(item)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#0b6cbf] hover:underline"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  History
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {historyLead && (
      <LeadHistoryModal
        lead={{ lead_id: historyLead.leadId }}
        onClose={() => setHistoryLead(null)}
      />
    )}
    </>
  );
}
