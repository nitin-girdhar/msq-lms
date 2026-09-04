'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { SessionUser } from '@platform/types';
import type { LeadView } from '../../types/leads';
import { followUps as followUpsApi, leads as leadsApi } from '../../lib/api/client';
import { LeadHistoryModal } from '../LeadHistoryModal';
import { LeadEditModal } from './LeadEditModal';
import { MobileFollowUpCard } from './MobileFollowUpCard';
import { useLeadEditData } from '../../hooks/useLeadEditData';
import { type FollowUpItem, formatDate } from '../../lib/leads/followup-format';
import {
  DownloadButton,
  NotificationOptIn,
  buildFilename,
  exportRows,
  useIsMobile,
  type ExportColumn,
} from '@platform/ui-kit';

// Desktop grid is code-split and never fetched below the md breakpoint — see
// FollowUpGrid's header note. ssr:false because AG Grid has no useful SSR output
// and this screen is always behind auth (dynamic, per-request) anyway.
const FollowUpGrid = dynamic(() => import('./FollowUpGrid'), { ssr: false });

const EXPORT_COLS: ExportColumn<FollowUpItem>[] = [
  { header: 'Lead', value: (f) => f.leadFullName },
  { header: 'Phone', value: (f) => f.leadPhone ?? '' },
  { header: 'Stage', value: (f) => f.leadStageLabel ?? f.leadStage.replace(/_/g, ' ') },
  { header: 'Assigned To', value: (f) => f.assignedRepName },
  { header: 'Email', value: (f) => f.assignedRepEmail },
  { header: 'Status', value: (f) => f.followUpStatusLabel ?? f.followUpStatus },
  { header: 'Scheduled', value: (f) => (f.scheduledAt ? formatDate(f.scheduledAt) : 'Not scheduled') },
  { header: 'Notes', value: (f) => f.notes ?? '' },
];

interface Props {
  actor: SessionUser;
  embedded?: boolean;
  /**
   * Lead to open on arrival, from `?leadId=` — set by the Web Push follow-up
   * notification so tapping it lands on that lead rather than just this grid.
   *
   * Resolved ONLY against `all`, the list the API already returned for this
   * actor (sales reps are filtered to their own by `assignedRepId`, and the
   * service applies RLS on top). An id the actor cannot see simply matches
   * nothing and the grid renders normally — this must never become a fetch by
   * id, which would turn a URL parameter into a way to read someone else's lead.
   */
  // `| undefined` is required, not redundant: the workspace compiles with
  // `exactOptionalPropertyTypes`, so an absent `?leadId=` cannot be passed
  // through as `undefined` without it.
  focusLeadId?: string | undefined;
}

export default function FollowUpsShell({ actor, embedded, focusLeadId }: Props) {
  const [all, setAll] = useState<FollowUpItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyItem, setHistoryItem] = useState<FollowUpItem | null>(null);
  const [editingLead, setEditingLead] = useState<LeadView | null>(null);
  const isMobile = useIsMobile(767); // below Tailwind's md breakpoint

  const editData = useLeadEditData(actor, editingLead?.org_id);

  const isSalesRep = actor.role === 'sales_representative';

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: { assignedRepId?: string } = {};
    if (isSalesRep) params.assignedRepId = actor.id;
    followUpsApi.list(params)
      .then((body) => {
        const data = (body.data ?? body.pipeline ?? []) as FollowUpItem[];
        setAll(data);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [isSalesRep, actor.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Open the notification's lead once the list has arrived. `focusConsumed`
  // makes this fire at most once: without it, closing the modal would re-open it
  // on the next render, trapping the user on a screen they cannot dismiss.
  const [focusConsumed, setFocusConsumed] = useState(false);
  useEffect(() => {
    if (!focusLeadId || focusConsumed || loading || error) return;
    const match = all.find((f) => f.leadId === focusLeadId);
    if (match) setHistoryItem(match);
    // Consumed either way — an unmatched id (already actioned, reassigned, or
    // not this actor's) must not keep retrying on every refetch.
    setFocusConsumed(true);
  }, [focusLeadId, focusConsumed, loading, error, all]);

  const handleEdit = useCallback(async (item: FollowUpItem) => {
    try {
      const res = await leadsApi.get(item.leadId);
      setEditingLead(res.data);
    } catch {
      // Lead fetch failed — silently ignore
    }
  }, []);

  const upcoming = useMemo(
    () => all.filter((f) => f.isOverdue === false).sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()),
    [all],
  );
  const missed = useMemo(
    () => all.filter((f) => f.isOverdue === true).sort((a, b) => (b.minutesOverdue ?? 0) - (a.minutesOverdue ?? 0)),
    [all],
  );

  const renderList = (items: FollowUpItem[], type: 'upcoming' | 'missed') =>
    isMobile ? (
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <MobileFollowUpCard key={item.leadId} item={item} type={type} onEdit={handleEdit} onHistory={setHistoryItem} />
        ))}
      </div>
    ) : (
      <FollowUpGrid items={items} onEdit={handleEdit} onHistory={setHistoryItem} type={type} />
    );

  return (
    <div className={embedded ? 'w-full space-y-3' : 'w-full space-y-6 px-3 py-4 sm:px-4'}>
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A]">Follow-Up Pipeline</h1>
          <p className="mt-1 text-sm text-[#64748B]">
            {isSalesRep ? 'Your pending and missed follow-ups' : 'All pending and missed follow-ups across the org'}
          </p>
        </div>
      )}

      {/* In-context push opt-in: this is the screen where "notify me when one is
          due" is self-evident. Renders nothing where push is unsupported. */}
      <NotificationOptIn />

      {loading && <div className="flex items-center justify-center py-16 text-sm text-[#94A3B8]">Loading…</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}

      {!loading && !error && (
        <>
          <section>
            <div className={`flex items-center justify-between ${embedded ? 'mb-1.5' : 'mb-3'}`}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#0b6cbf]">Upcoming ({upcoming.length})</h2>
              <DownloadButton onExport={(fmt) => exportRows(upcoming, EXPORT_COLS, buildFilename(['upcoming-followups']), fmt)} rowCount={upcoming.length} />
            </div>
            {upcoming.length > 0 ? (
              renderList(upcoming, 'upcoming')
            ) : (
              <p className="py-8 text-center text-sm text-[#94A3B8]">No upcoming follow-ups.</p>
            )}
          </section>

          <section>
            <div className={`flex items-center justify-between ${embedded ? 'mb-1.5' : 'mb-3'}`}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600">Missed / Overdue ({missed.length})</h2>
              <DownloadButton onExport={(fmt) => exportRows(missed, EXPORT_COLS, buildFilename(['missed-followups']), fmt)} rowCount={missed.length} />
            </div>
            {missed.length > 0 ? (
              renderList(missed, 'missed')
            ) : (
              <p className="py-8 text-center text-sm text-[#94A3B8]">No missed follow-ups.</p>
            )}
          </section>
        </>
      )}

      {historyItem && (
        <LeadHistoryModal lead={{ lead_id: historyItem.leadId }} onClose={() => setHistoryItem(null)} />
      )}

      {editingLead && (
        <LeadEditModal
          lead={editingLead}
          statusOptions={editData.statusOptions}
          statusLabelMap={editData.statusLabelMap}
          followUpSet={editData.followUpSet}
          rejectionSet={editData.rejectionSet}
          stageOutcomes={editData.stageOutcomes}
          stageIdToName={editData.stageIdToName}
          candidates={editData.candidates}
          actor={actor}
          loadError={editData.loadError}
          onUpdate={async (payload) => { await editData.updateLead(payload); fetchData(); }}
          onAssignmentChanged={fetchData}
          onClose={() => setEditingLead(null)}
        />
      )}
    </div>
  );
}
