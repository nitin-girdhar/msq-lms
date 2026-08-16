'use client';

import { useMemo, useState } from 'react';
import type { SessionUser } from '@platform/types';
import { can, CAPABILITY } from '@platform/rbac';
import type { LeadView } from '../../types/leads';
import type { StageOutcome, UpdatePayload } from '../../types/leads';
import { leads as leadsApi } from '../../lib/api/client';
import { Modal, UserPicker } from '@platform/ui-kit';
import { LeadFormDataPanel } from './LeadFormDataPanel';
import TransferOutModal from './TransferOutModal';
import WhatsAppSendModal from './WhatsAppSendModal';

interface Props {
  lead: LeadView;
  statusOptions: string[];
  statusLabelMap: Record<string, string>;
  followUpSet: Set<string>;
  rejectionSet: Set<string>;
  stageOutcomes: StageOutcome[];
  stageIdToName: Record<string, string>;
  candidates: SessionUser[];
  actor: SessionUser;
  /** Stage/outcome catalog failed to load — saving is blocked, since the
   *  follow-up rule is derived from that catalog. */
  loadError?: string | null;
  onUpdate: (payload: UpdatePayload) => Promise<void>;
  onAssignmentChanged: () => void;
  onClose: () => void;
}

export function LeadEditModal({
  lead, statusOptions, statusLabelMap, followUpSet, rejectionSet,
  stageOutcomes, stageIdToName, candidates, actor, loadError, onUpdate, onAssignmentChanged, onClose,
}: Props) {
  const origStatus     = lead.stage ?? '';
  const origAssigneeId = lead.assigned_user_id ?? null;

  const [selectedStatus,     setSelectedStatus]     = useState(origStatus);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(origAssigneeId);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [outcomeId,      setOutcomeId]      = useState<string | ''>(lead.outcome_id ?? '');
  const [transitionNote, setTransitionNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);

  // Two independent questions, and they get different treatments.
  //
  // MAY THEY SEND AT ALL — the capability leads-service gates both WhatsApp
  // routes on. Absent, the button is not rendered: unticking `Send WhatsApp` in
  // the Capability Matrix has to actually remove the action, not leave it on
  // screen to 403 on click.
  const mayWhatsApp = can(actor, CAPABILITY.LMS_LEADS_WHATSAPP_SEND);

  // CAN THIS LEAD RECEIVE — mirrors the server-side check (last10Digits):
  // anything that doesn't yield 10 digits can't be dialled, so the button stays
  // visible but inert rather than letting the rep click through to a guaranteed
  // error. A permission the role holds shouldn't vanish over missing lead data.
  const canWhatsApp = (lead.phone ?? '').replace(/\D/g, '').length >= 10;

  const stageNameToId = useMemo(() => {
    const inv: Record<string, string> = {};
    for (const [id, name] of Object.entries(stageIdToName)) inv[name] = id;
    return inv;
  }, [stageIdToName]);

  const canAssign       = can(actor, CAPABILITY.LMS_LEADS_ASSIGN);
  const statusChanged   = selectedStatus !== origStatus;
  const assigneeChanged = selectedAssigneeId !== origAssigneeId;
  const outcomeChanged  = outcomeId !== (lead.outcome_id ?? '');
  const fuVisible       = followUpSet.has(selectedStatus);
  const showFollowUp    = statusChanged && fuVisible;
  const showRejection   = statusChanged && rejectionSet.has(selectedStatus);

  const selectedStageId  = stageNameToId[selectedStatus];
  const filteredOutcomes = stageOutcomes.filter(o => o.stage_id === selectedStageId);
  const hasOutcomes      = filteredOutcomes.length > 0;
  const selectedOutcome  = filteredOutcomes.find(o => o.id === outcomeId);
  // Reflects the DB rule for whichever outcome is selected — including an
  // outcome-only edit with no stage change — since
  // lms.check_lead_stage_outcome() enforces requires_comment regardless of
  // whether the stage moved.
  const outcomeCommentRequired = selectedOutcome?.requires_comment ?? false;

  const currentAssigneeName = (() => {
    if (!origAssigneeId) return null;
    const inList = candidates.find(u => u.id === origAssigneeId);
    if (inList) return inList.name ?? inList.email;
    return lead.assigned_rep_name ?? null;
  })();

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (hasOutcomes && !outcomeId) errs.outcome = 'Select an outcome';
    if (fuVisible && !(editedFuDate ?? fuLocalDate)) errs.followUp = 'Follow-up date is required';
    if (noteRequired && !transitionNote.trim()) errs.transitionNote = 'Notes are required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // The version this editor was opened against. Sent with every write so the
  // server can reject a save that would clobber someone else's concurrent edit
  // (409) rather than silently applying last-writer-wins.
  const expectedUpdatedAt = lead.updated_at
    ? new Date(lead.updated_at).toISOString()
    : undefined;

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Tracks whether we have already written to the lead this save, so the
      // optimistic-concurrency token is only attached to the FIRST write (see
      // the assignee PATCH below).
      let leadWritten = false;

      // Who the follow-up belongs to, and when it is due. Attached to whichever
      // lead write happens first so the stage move and the follow-up commit
      // together — the server rejects a move into a follow-up stage that arrives
      // without one, and a second request could always fail on its own.
      const fuTargetDate = editedFuDate ?? fuLocalDate;
      const fuAssignee   = selectedAssigneeId ?? origAssigneeId ?? actor.id;
      const fuPayload    = fuFieldChanged
        ? { scheduledAt: new Date(fuTargetDate).toISOString(), assignedUserId: fuAssignee }
        : null;

      if (statusChanged) {
        await onUpdate({
          leadId: lead.lead_id,
          field: 'stage',
          value: selectedStatus,
          ...(fuPayload ? { followUp: fuPayload } : {}),
          ...(outcomeId !== '' ? { outcomeId } : {}),
          ...(transitionNote.trim() ? { transitionNote: transitionNote.trim() } : {}),
          // The DB rejects a save when the selected outcome requires a comment
          // (lms.check_lead_stage_outcome) but only `outcome_comment` satisfies
          // that check — transition_note is a separate audit-log field. Reuse
          // the same Notes text there rather than adding a second textarea.
          ...(outcomeCommentRequired && transitionNote.trim() ? { outcomeComment: transitionNote.trim() } : {}),
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        });
        leadWritten = true;
      } else if (outcomeChanged && outcomeId !== '' && lead.lead_id) {
        // The Outcome select renders whenever the CURRENT stage has outcomes,
        // not only after a stage change — so the outcome is editable on its
        // own. Without this branch that edit reached no endpoint at all: the
        // modal closed as if it had saved, nothing was persisted and no
        // lms.lead_status_log row was written. The trigger behind that log
        // fires on `UPDATE OF stage_id, outcome_id`, so an outcome-only PATCH
        // records the transition note exactly like a stage change does.
        await leadsApi.update(lead.lead_id, {
          outcome_id: outcomeId,
          ...(fuPayload ? {
            follow_up_scheduled_at: fuPayload.scheduledAt,
            follow_up_assigned_user_id: fuPayload.assignedUserId,
          } : {}),
          ...(transitionNote.trim() ? { transition_note: transitionNote.trim() } : {}),
          ...(outcomeCommentRequired && transitionNote.trim() ? { outcome_comment: transitionNote.trim() } : {}),
          ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
        });
        leadWritten = true;
      }

      const autoAssign        = showRejection && !origAssigneeId;
      const assigneeToSet     = autoAssign ? actor.id : selectedAssigneeId;
      const shouldPatchAssignee = autoAssign || (assigneeChanged && lead.lead_id);

      if (shouldPatchAssignee && lead.lead_id) {
        await leadsApi.update(lead.lead_id, {
          assigned_user_id: assigneeToSet,
          // Only when no earlier write already carried it — the follow-up must be
          // created exactly once.
          ...(fuPayload && !leadWritten ? {
            follow_up_scheduled_at: fuPayload.scheduledAt,
            follow_up_assigned_user_id: fuPayload.assignedUserId,
          } : {}),
          ...(transitionNote.trim() ? { transition_note: transitionNote.trim() } : {}),
          // Only guard this write when it is the first one: an earlier stage or
          // outcome PATCH already bumped updated_at, so re-sending the version
          // we opened with would 409 against our own change.
          ...(expectedUpdatedAt && !leadWritten ? { expected_updated_at: expectedUpdatedAt } : {}),
        });
        leadWritten = true;
      }

      // Only reachable when the due date is the sole change — every other path
      // above folded the follow-up into its own lead write.
      if (fuPayload && !leadWritten && lead.lead_id) {
        await leadsApi.addFollowUp(lead.lead_id, {
          scheduled_at: fuPayload.scheduledAt,
          assigned_user_id: fuPayload.assignedUserId,
          ...(transitionNote.trim() ? { notes: transitionNote.trim() } : {}),
        });
      }

      onAssignmentChanged();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = (value: string) => {
    setSelectedStatus(value);
    setErrors({});
    setOutcomeId('');
    setTransitionNote('');
  };

  const statusLabelText = statusLabelMap[origStatus] ?? origStatus;

  // Current follow-up due time comes straight from the lead record (lms.marketing_leads.scheduled_at) —
  // the source of truth for "when is this lead's next follow-up due" — not from a separate follow-ups fetch.
  // Convert UTC date string to local datetime-local format (YYYY-MM-DDTHH:MM)
  const toLocalDatetime = (utc: string): string => {
    const d = new Date(utc);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fuLocalDate = lead.scheduled_at ? toLocalDatetime(lead.scheduled_at) : '';

  const [editedFuDate, setEditedFuDate] = useState<string | null>(null);
  const fuDateChanged = editedFuDate !== null && editedFuDate !== fuLocalDate;
  // Any change that touches a followup-required stage — the stage itself, the date, or who
  // it's assigned to — appends a fresh lms.lead_follow_ups row (append-only history), even if
  // the due date itself didn't move. marketing_leads.scheduled_at is always the latest value.
  const fuFieldChanged = fuVisible && (statusChanged || fuDateChanged || assigneeChanged) && Boolean(editedFuDate ?? fuLocalDate);
  const anyFieldChanged = statusChanged || assigneeChanged || outcomeChanged || fuFieldChanged;
  // A note explains WHY a lead moved, so it is compulsory for the changes that
  // land in the audit log — stage, outcome, and moving the follow-up date. A bare
  // re-assignment is deliberately excluded: handing a lead to someone else needs
  // no justification, and the note used to be demanded there and then silently
  // dropped, since lms.log_lead_stage_change() writes no row when neither the
  // stage nor the outcome moved.
  //
  // Keyed on fuDateChanged, not fuFieldChanged: the latter is also true when only
  // the assignee moved (the follow-up row is re-stamped with the new owner), which
  // would put us right back to demanding a note for an assignment-only edit.
  const noteRequired = statusChanged || outcomeChanged || fuDateChanged;

  const updateSectionStyle = !anyFieldChanged ? ''
    : selectedStatus === 'converted' ? 'border border-[#86EFAC] bg-[#F0FDF4]'
    : showFollowUp ? 'border border-[#BFDBFE] bg-[#EFF6FF]'
    : showRejection ? 'border border-[#FCA5A5] bg-[#FEF2F2]'
    : '';

  const subtitle = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium text-[#0F172A]">{lead.full_name || '—'}</span>
              {lead.phone && (
                <a href={`tel:${lead.phone}`} className="flex items-center gap-1 text-xs text-[#0b6cbf] hover:underline">
                  <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498A1 1 0 0121 17.72V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  {lead.phone}
                </a>
              )}
              {lead.email && (
                <a href={`mailto:${lead.email}`} className="flex items-center gap-1 text-xs text-[#0b6cbf] hover:underline">
                  <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  {lead.email}
                </a>
              )}
              {/* Rendered whenever the role holds the send capability, disabled
                  when there's no usable number, so the action stays discoverable
                  instead of silently vanishing.
                  The WhatsApp mark is a filled brand glyph, hence `fill` rather
                  than the `stroke` convention the other icons here use. */}
              {mayWhatsApp && (
              <button
                type="button"
                onClick={() => setShowWhatsAppModal(true)}
                disabled={!canWhatsApp}
                title={canWhatsApp ? 'Send a WhatsApp message' : 'No WhatsApp number on this lead'}
                aria-label={canWhatsApp ? 'Send a WhatsApp message' : 'No WhatsApp number on this lead'}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors ${
                  canWhatsApp
                    ? 'text-[#25D366] hover:bg-[#F0FDF4]'
                    : 'cursor-not-allowed text-[#CBD5E1]'
                }`}
              >
                <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 00-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.247-.694.247-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 016.988 2.896 9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.548 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.465 3.49" />
                </svg>
                WhatsApp
              </button>
              )}
    </div>
  );

  const footer = (
    <div className="flex justify-end gap-3">
      <button type="button" onClick={onClose} disabled={saving}
        className="rounded-lg border border-[#E2E8F0] px-4 py-2 text-sm font-semibold text-[#475569] transition-colors hover:bg-[#F8FAFC] disabled:opacity-60">
        Cancel
      </button>
      {selectedStatus === 'transferred_out' ? (
        <button type="button" onClick={() => setShowTransferModal(true)}
          disabled={!statusChanged}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60">
          Transfer Lead →
        </button>
      ) : (
        <button type="button" onClick={handleSave}
          disabled={saving || !anyFieldChanged || Boolean(loadError)}
          title={loadError ? 'Lead statuses could not be loaded — reload the page before editing' : undefined}
          className="rounded-lg bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#0a5fa8] disabled:cursor-not-allowed disabled:opacity-60">
          {saving ? (
            <span className="inline-flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Saving…
            </span>
          ) : 'Save Changes'}
        </button>
      )}
    </div>
  );

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Edit Lead"
        subtitle={subtitle}
        maxWidth="max-w-3xl"
        locked={saving}
        footer={footer}
        // The sections carry their own px-6 gutters and divider rules, so the
        // body opts out of the shell's default padding.
        bodyClassName="sheet-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex flex-col divide-y divide-[#F1F5F9]">
          {loadError && (
            <div className="mx-6 my-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Lead statuses could not be loaded, so this lead cannot be edited safely — reload the page and try again.
            </div>
          )}

          {/* Read-only lead details */}
          <div className="px-6 py-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Lead Details</p>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
              <InfoRow label="Status" value={statusLabelText} />
              <InfoRow label="Outcome" value={lead.outcome_label ?? '—'} />
              <InfoRow label="Date" value={lead.created_at ? new Date(lead.created_at).toLocaleDateString('en-IN') : '—'} />
              <InfoRow label="Lead Source" value={lead.source_label ?? lead.source ?? lead.platform ?? '—'} />
              <InfoRow label="Assigned To" value={lead.assigned_rep_name ?? '—'} />
              <InfoRow label="Follow-up" value={lead.scheduled_at ? new Date(lead.scheduled_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'} />
              <InfoRow label="Campaign" value={lead.campaign_name ?? '—'} full />
            </div>
          </div>

          {/* Original form submission (e.g. Meta lead-gen answers) — hidden when none */}
          <LeadFormDataPanel leadId={lead.lead_id} source={lead.source ?? lead.platform} />

          {/* Editable fields */}
          <div className="flex flex-col gap-4 px-6 py-5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Update</p>

            <div className={`grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl px-4 py-4 ${updateSectionStyle}`}>
              {/* Row 1 — Left: Assigned To */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Assigned To</label>
                {canAssign ? (
                  <UserPicker
                    value={selectedAssigneeId ?? ''}
                    onChange={(id) => setSelectedAssigneeId(id || null)}
                    users={candidates}
                    allowEmpty
                    emptyLabel="Unassigned"
                    extraOption={
                      origAssigneeId && !candidates.some(c => c.id === origAssigneeId)
                        ? { id: origAssigneeId, label: `${currentAssigneeName ?? origAssigneeId} (current)` }
                        : undefined
                    }
                  />
                ) : (
                  <div className="px-3 py-2 text-sm text-[#64748B]">{currentAssigneeName ?? 'Unassigned'}</div>
                )}
              </div>

              {/* Row 1 — Right: Status */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Status</label>
                <select
                  value={selectedStatus}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#0F172A] focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
                >
                  {statusOptions.map((s) => (
                    <option key={s} value={s}>{statusLabelMap[s] ?? s}</option>
                  ))}
                </select>
              </div>

              {/* Row 2 — Left: Follow-up Due (shown only for stages requiring a follow-up) */}
              {fuVisible && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">
                    Follow-up Due <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={editedFuDate ?? fuLocalDate}
                    onChange={(e) => { setEditedFuDate(e.target.value); setErrors(p => ({ ...p, followUp: '' })); }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:ring-2 ${errors.followUp ? 'border-red-400 focus:ring-red-200' : 'border-[#E2E8F0] focus:border-[#0b6cbf] focus:ring-[#0b6cbf]/20'}`}
                  />
                  {errors.followUp && <p className="text-xs text-red-500">{errors.followUp}</p>}
                </div>
              )}

              {/* Row 2 — Right: Outcome */}
              {hasOutcomes && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">
                    {showRejection ? 'Reason' : 'Outcome'} <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={outcomeId}
                    onChange={(e) => { setOutcomeId(e.target.value); setErrors(p => ({ ...p, outcome: '' })); }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:ring-2 ${errors.outcome ? 'border-red-400 focus:ring-red-200' : 'border-[#E2E8F0] focus:border-[#0b6cbf] focus:ring-[#0b6cbf]/20'}`}
                  >
                    <option value="" disabled>{showRejection ? 'Select a reason…' : 'Select an outcome…'}</option>
                    {filteredOutcomes.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                  {errors.outcome && <p className="text-xs text-red-500">{errors.outcome}</p>}
                </div>
              )}
            </div>

            {/* Notes — mandatory for stage/outcome/follow-up changes, optional for an
                assignment-only edit (not needed for the transfer_out path at all) */}
            {anyFieldChanged && selectedStatus !== 'transferred_out' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">
                  Notes {noteRequired && <span className="text-red-500">*</span>}
                </label>
                <textarea
                  value={transitionNote}
                  onChange={(e) => { setTransitionNote(e.target.value); setErrors(p => ({ ...p, transitionNote: '' })); }}
                  placeholder={noteRequired ? 'Add a note about this change…' : 'Add a note about this change (optional)…'}
                  rows={2}
                  className={`w-full resize-none rounded-lg border px-3 py-2 text-sm text-[#0F172A] placeholder:text-[#CBD5E1] focus:outline-none focus:ring-2 ${errors.transitionNote ? 'border-red-400 focus:ring-red-200' : 'border-[#E2E8F0] focus:border-[#0b6cbf] focus:ring-[#0b6cbf]/20'}`}
                />
                {errors.transitionNote && <p className="text-xs text-red-500">{errors.transitionNote}</p>}
              </div>
            )}
          </div>
        </div>

        {saveError && (
          <div className="mx-6 my-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
            {saveError}
          </div>
        )}
      </Modal>

      <TransferOutModal
        open={showTransferModal}
        onClose={() => setShowTransferModal(false)}
        lead={lead}
        onTransferred={() => { onAssignmentChanged(); onClose(); }}
      />
      {/* Refreshes so the new interaction shows up, but deliberately leaves the
          edit modal open — sending a message isn't an edit, and closing here
          would discard any in-progress field changes. */}
      <WhatsAppSendModal
        open={showWhatsAppModal}
        onClose={() => setShowWhatsAppModal(false)}
        lead={lead}
        onSent={onAssignmentChanged}
      />
    </>
  );
}

function InfoRow({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex items-start gap-2${full ? ' col-span-2' : ''}`}>
      <span className="w-20 shrink-0 pt-px text-xs font-semibold text-[#94A3B8]">{label}</span>
      <span className="break-all text-sm text-[#0F172A]">{value}</span>
    </div>
  );
}
