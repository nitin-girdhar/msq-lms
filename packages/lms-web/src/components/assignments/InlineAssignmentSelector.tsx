'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionUser } from '@platform/types';
import type { AssignmentView } from '../../types/leads';
import { ROLE_LABELS } from '@platform/auth-constants';
import { leads as leadsApi } from '../../lib/api/client';
import { useDismissible } from '@platform/ui-kit';

interface Props {
  branch: string;
  leadId: string;
  existing: AssignmentView | null;
  actor: SessionUser;
  candidates: SessionUser[];
  onChanged: () => void;
}

type PopoverRect = { top: number; left: number; minWidth: number };

const CAN_ASSIGN_ROLES: ReadonlyArray<SessionUser['role']> = [
  'super_admin',
  'tenant_admin',
  'org_admin',
  'org_sr_manager',
  'org_manager',
  'senior_sales_executive',
];

export default function InlineAssignmentSelector({
  leadId,
  existing,
  actor,
  candidates,
  onChanged,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverRect, setPopoverRect] = useState<PopoverRect | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const canAssign = CAN_ASSIGN_ROLES.includes(actor.role);

  useDismissible(open, [triggerRef, popoverRef], () => setOpen(false));

  const openPicker = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const popoverHeight = 320;
    const popoverWidth = 280;
    const top = Math.max(8, r.top - popoverHeight - 4);
    const left = Math.min(
      Math.max(8, r.right - popoverWidth),
      window.innerWidth - popoverWidth - 8,
    );
    setPopoverRect({ top, left, minWidth: Math.max(r.width, popoverWidth) });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handler = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const popoverHeight = 320;
      const popoverWidth = 280;
      setPopoverRect({
        top: Math.max(8, r.top - popoverHeight - 4),
        left: Math.min(
          Math.max(8, r.right - popoverWidth),
          window.innerWidth - popoverWidth - 8,
        ),
        minWidth: Math.max(r.width, popoverWidth),
      });
    };
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [open]);

  const candidatesById = useMemo(() => {
    const m = new Map<string, SessionUser>();
    for (const u of candidates) m.set(u.id, u);
    return m;
  }, [candidates]);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.name ?? '').toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const currentAssigneeLabel = (() => {
    if (!existing) return null;
    if (existing.assigned_rep_name) return existing.assigned_rep_name;
    if (existing.assigned_rep_email) return existing.assigned_rep_email;
    const inList = candidatesById.get(existing.assigned_to);
    if (inList) return inList.name ?? inList.email;
    return 'Unknown user';
  })();

  const assign = async (userId: string) => {
    setSaving(true);
    setError(null);
    try {
      await leadsApi.update(leadId, { assignedUserId: userId });
      onChanged();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const unassign = async () => {
    if (!existing) return;
    setSaving(true);
    setError(null);
    try {
      await leadsApi.update(leadId, { assignedUserId: null });
      onChanged();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  if (!canAssign && actor.rank > 0) {
    const isMyLead = !!existing && existing.assigned_to === actor.id;
    return (
      <div className="flex flex-col items-start gap-0.5">
        {isMyLead ? (
          <ReadonlyBadge label={currentAssigneeLabel ?? 'You'} />
        ) : (
          <button
            type="button"
            onClick={() => assign(actor.id)}
            disabled={saving}
            className="rounded-full border border-dashed border-[#CBD5E1] bg-white px-2.5 py-0.5 text-[11px] font-semibold text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : '+ Assign to me'}
          </button>
        )}
        {error && (
          <span className="block text-[10px] text-red-600">{error}</span>
        )}
      </div>
    );
  }

  if (!canAssign) {
    return existing ? (
      <ReadonlyBadge label={currentAssigneeLabel ?? 'Unknown user'} />
    ) : (
      <span className="text-[11px] italic text-[#94A3B8]">Unassigned</span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          existing
            ? 'flex items-center gap-1.5 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-semibold text-[#0b6cbf] transition-colors hover:bg-[#DBEAFE] disabled:cursor-not-allowed disabled:opacity-60'
            : 'rounded-full border border-dashed border-[#CBD5E1] bg-white px-2.5 py-0.5 text-[11px] font-semibold text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf] disabled:cursor-not-allowed disabled:opacity-60'
        }
      >
        {saving ? (
          <span className="inline-flex items-center gap-1">
            <span
              className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
            Saving…
          </span>
        ) : existing ? (
          <>
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#0b6cbf] text-[9px] font-bold text-white">
              {(currentAssigneeLabel ?? '?').charAt(0).toUpperCase()}
            </span>
            <span className="max-w-[100px] truncate">
              {currentAssigneeLabel}
            </span>
          </>
        ) : (
          '+ Assign'
        )}
      </button>

      {open &&
        popoverRect &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Assign lead"
            style={{
              position: 'fixed',
              top: popoverRect.top,
              left: popoverRect.left,
              minWidth: popoverRect.minWidth,
              maxWidth: 320,
              zIndex: 1000,
            }}
            className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-lg"
          >
            <div className="border-b border-[#F1F5F9] p-2">
              <input
                autoFocus
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search assignees…"
                className="w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700"
              >
                {error}
              </div>
            )}

            <div className="max-h-64 overflow-y-auto">
              {candidates.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-[#64748B]">
                  No eligible assignees in this branch.
                </div>
              )}

              {filteredCandidates.length === 0 && candidates.length > 0 && (
                <div className="px-4 py-6 text-center text-xs text-[#64748B]">
                  No matches for &quot;{search}&quot;.
                </div>
              )}

              {filteredCandidates.map((u) => {
                const isCurrent = existing?.assigned_to === u.id;
                return (
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onClick={() => !isCurrent && assign(u.id)}
                    disabled={saving || isCurrent}
                    className={
                      isCurrent
                        ? 'flex w-full items-center justify-between gap-2 bg-[#EFF6FF] px-3 py-2 text-left text-sm text-[#0b6cbf]'
                        : 'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[#0F172A] transition-colors hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60'
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {u.name ? `${u.name} (${u.email})` : u.email}
                      </span>
                      <span className="block truncate text-[11px] text-[#64748B]">
                        {u.role_label ?? ROLE_LABELS[u.role]}
                      </span>
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#0b6cbf]">
                        current
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {existing && (
              <div className="border-t border-[#F1F5F9] p-2">
                <button
                  type="button"
                  onClick={unassign}
                  disabled={saving}
                  className="w-full rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Unassign
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function ReadonlyBadge({ label }: { label: string }) {
  const initial = label.charAt(0).toUpperCase();
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-semibold text-[#0b6cbf]"
      title={label}
    >
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#0b6cbf] text-[9px] font-bold text-white">
        {initial}
      </span>
      <span className="max-w-[100px] truncate">{label}</span>
    </span>
  );
}
