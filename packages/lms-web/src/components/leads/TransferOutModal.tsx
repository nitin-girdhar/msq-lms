'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@platform/ui-kit';
import type { LeadView } from '../../types/leads';
import { leads as leadsApi } from '../../lib/api/client';
import { useAllOrgs } from '../../hooks/useAllOrgs';

// The submit button lives in the Modal's pinned footer, outside the <form>;
// the HTML `form` attribute is what still wires it to this form.
const FORM_ID = 'transfer-out-form';

interface Props {
  open: boolean;
  onClose: () => void;
  lead: LeadView;
  onTransferred: () => void;
}

export default function TransferOutModal({ open, onClose, lead, onTransferred }: Props) {
  const { orgs, loading: orgsLoading, error: orgsError } = useAllOrgs();
  const [targetOrgId, setTargetOrgId] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableOrgs = orgs.filter((o) => o.id !== lead.org_id);

  useEffect(() => {
    if (!open) return;
    setTargetOrgId('');
    setNotes('');
    setError(null);
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetOrgId) return;
    if (targetOrgId === lead.org_id) {
      setError('Target branch must be different from the current branch.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await leadsApi.transfer(lead.lead_id, {
        target_org_id: targetOrgId,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onTransferred();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed. Please try again.');
    } finally {
      setPending(false);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        disabled={pending}
        className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60"
      >
        Cancel
      </button>
      <button
        type="submit"
        form={FORM_ID}
        disabled={pending || !targetOrgId}
        aria-busy={pending}
        className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {pending && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
        )}
        Transfer Lead
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer Lead Out"
      locked={pending}
      footer={footer}
      layer="nested"
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Transferring <span className="font-semibold">{lead.full_name || 'this lead'}</span>
          {lead.phone && <> ({lead.phone})</>} to another branch.
          The current lead will be marked as <span className="font-semibold">transferred out</span>.
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="transfer-target-org" className="text-xs font-semibold text-[#0F172A]">
            Target Branch <span className="font-normal text-red-500">*</span>
          </label>
          {orgsLoading ? (
            <div className="rounded-xl border border-[#E2E8F0] px-3 py-2.5 text-sm text-[#94A3B8]">
              Loading branches…
            </div>
          ) : orgsError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              Failed to load branches: {orgsError}
            </div>
          ) : (
            <select
              id="transfer-target-org"
              value={targetOrgId}
              onChange={(e) => setTargetOrgId(e.target.value)}
              disabled={pending}
              className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
            >
              <option value="">Select a branch…</option>
              {availableOrgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="transfer-notes" className="text-xs font-semibold text-[#0F172A]">
            Notes
          </label>
          <textarea
            id="transfer-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
            rows={3}
            placeholder="Reason for transfer, context for the receiving branch…"
            className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
          />
        </div>
      </form>
    </Modal>
  );
}
