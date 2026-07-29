'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@platform/ui-kit';
import type { LeadView, WhatsAppTemplate } from '../../types/leads';
import { leads as leadsApi } from '../../lib/api/client';

// The submit button lives in the Modal's pinned footer, outside the <form>;
// the HTML `form` attribute is what still wires it to this form.
const FORM_ID = 'whatsapp-send-form';

interface Props {
  open: boolean;
  onClose: () => void;
  lead: LeadView;
  onSent: () => void;
}

export default function WhatsAppSendModal({ open, onClose, lead, onSent }: Props) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentLabel, setSentLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setError(null);
    setSentLabel(null);
    setLoading(true);

    // Guards against a stale response landing after the modal is reopened for a
    // different lead and overwriting the newer list.
    let cancelled = false;
    leadsApi.getWhatsAppTemplates(lead.lead_id)
      .then((res) => { if (!cancelled) setTemplates(res.data); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load message templates.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, lead.lead_id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId) return;
    setPending(true);
    setError(null);
    try {
      const res = await leadsApi.sendWhatsApp(lead.lead_id, { template_id: selectedId });
      setSentLabel(res.data.template_label);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed. Please try again.');
    } finally {
      setPending(false);
    }
  };

  const footer = sentLabel ? (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onClose}
        className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0a5fa8]"
      >
        Done
      </button>
    </div>
  ) : (
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
        disabled={pending || !selectedId}
        aria-busy={pending}
        className="inline-flex items-center gap-2 rounded-xl bg-[#25D366] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1DA851] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {pending && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
        )}
        {pending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send WhatsApp"
      locked={pending}
      footer={footer}
      layer="nested"
    >
        {sentLabel ? (
          <div className="flex flex-col gap-4">
            <div role="status" className="flex items-start gap-2 rounded-xl border border-[#86EFAC] bg-[#F0FDF4] px-3 py-2.5 text-xs text-green-800">
              <svg className="mt-px h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>
                <span className="font-semibold">{sentLabel}</span> sent to {lead.phone}. It has been added
                to this lead&apos;s activity history.
              </span>
            </div>
          </div>
        ) : (
          <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs text-[#475569]">
              Sending to <span className="font-semibold text-[#0F172A]">{lead.full_name || 'this lead'}</span>
              {lead.phone && <> on <span className="font-semibold text-[#0F172A]">{lead.phone}</span></>}.
            </div>

            {error && (
              <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-[#0F172A]">
                Message <span className="font-normal text-red-500">*</span>
              </span>
              {loading ? (
                <div className="rounded-xl border border-[#E2E8F0] px-3 py-2.5 text-sm text-[#94A3B8]">
                  Loading messages…
                </div>
              ) : templates.length === 0 ? (
                <div className="rounded-xl border border-[#E2E8F0] px-3 py-2.5 text-xs text-[#64748B]">
                  No message templates are configured yet.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {templates.map((t) => (
                    <label
                      key={t.id}
                      className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors ${
                        selectedId === t.id
                          ? 'border-[#25D366] bg-[#F0FDF4]'
                          : 'border-[#E2E8F0] hover:bg-[#F8FAFC]'
                      } ${pending ? 'cursor-not-allowed opacity-60' : ''}`}
                    >
                      <input
                        type="radio"
                        name="whatsapp-template"
                        value={t.id}
                        checked={selectedId === t.id}
                        onChange={() => setSelectedId(t.id)}
                        disabled={pending}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#25D366]"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-[#0F172A]">{t.label}</span>
                        {t.preview_text && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-[#64748B]">
                            {t.preview_text}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {/* Meta only permits business-initiated messages from approved
                  templates, so there is intentionally no free-text box here. */}
              <p className="text-[11px] text-[#94A3B8]">
                Names are filled in automatically when the message is sent.
              </p>
            </div>

          </form>
        )}
    </Modal>
  );
}
