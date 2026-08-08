'use client';

import { useEffect, useState } from 'react';
import type { SessionUser } from '@platform/types';
import { LMS_RANKS } from '@lms/authz';
import { Modal, users as usersApi } from '@platform/ui-kit';
import { assignments as assignmentsApi } from '../../lib/api/client';
import AssignmentSelector from '../assignments/AssignmentSelector';

const FORM_ID = 'bulk-assign-form';

interface Props {
  open: boolean;
  onClose: () => void;
  orgId: string;
  leadIds: string[];
  onAssigned: (result: { updated: number; skipped: string[] }) => void;
}

export default function BulkAssignModal({ open, onClose, orgId, leadIds, onAssigned }: Props) {
  const [candidates, setCandidates] = useState<SessionUser[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [assignedTo, setAssignedTo] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAssignedTo('');
    setError(null);
    let cancelled = false;
    setCandidatesLoading(true);
    usersApi
      .assignable({ orgId, maxRank: LMS_RANKS.SSE })
      .then((res) => {
        if (!cancelled) setCandidates((res.data ?? []) as SessionUser[]);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, orgId]);

  const close = () => {
    if (pending) return;
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!assignedTo) {
      setError('Pick an assignee from the list.');
      return;
    }
    setPending(true);
    try {
      const res = await assignmentsApi.bulkAssign({ lead_ids: leadIds, assigned_to: assignedTo });
      onAssigned(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setPending(false);
    }
  };

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={close}
        disabled={pending}
        className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60"
      >
        Cancel
      </button>
      <button
        type="submit"
        form={FORM_ID}
        disabled={pending || !assignedTo}
        aria-busy={pending}
        className="inline-flex items-center gap-2 rounded-xl bg-[#0b6cbf] px-3 py-2 text-xs font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {pending && (
          <span
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
            aria-hidden
          />
        )}
        Assign {leadIds.length} lead{leadIds.length === 1 ? '' : 's'}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={close} title="Bulk assign leads" locked={pending} footer={footer}>
      <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <p className="text-xs text-[#64748B]">
          {leadIds.length} lead{leadIds.length === 1 ? '' : 's'} will be assigned to whoever you pick below.
          Only Senior Sales Executives and reps in this branch are eligible.
        </p>

        <AssignmentSelector
          id="bulk-assignee"
          value={assignedTo}
          onChange={setAssignedTo}
          users={candidates}
          disabled={pending || candidatesLoading}
          label="Assign to"
        />
        {candidatesLoading && (
          <p className="-mt-2 text-[11px] text-[#64748B]">Loading eligible assignees…</p>
        )}
      </form>
    </Modal>
  );
}
