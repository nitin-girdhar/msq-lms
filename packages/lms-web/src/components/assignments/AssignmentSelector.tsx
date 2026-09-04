'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionUser } from '@platform/types';
import { useAnchoredPanel, useDismissible } from '@platform/ui-kit';
import { displayName, sortByDisplayName } from '../../lib/users/assignable';

interface Props {
  id: string;
  value: string;
  onChange: (userId: string) => void;
  users: SessionUser[];
  disabled?: boolean;
  label?: string;
}

export default function AssignmentSelector({
  id,
  value,
  onChange,
  users,
  disabled,
  label = 'Assigned To',
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The panel is portalled to <body>, so it is NOT inside containerRef — it has
  // to be dismissed on its own ref too or every click on a name closes the list.
  useDismissible(open, [containerRef, panelRef], () => setOpen(false));

  // Every dialog this selector appears in clips its own content: Modal's card is
  // overflow-hidden and its body is the scroll region, so an absolutely
  // positioned list was cut off at the bottom edge of the form and the names
  // simply could not be reached. Fixed positioning against the trigger, outside
  // the dialog, is what makes the whole list visible.
  const rect = useAnchoredPanel(open, buttonRef);

  // A stale query would silently hide most of the list the next time the panel
  // opens, which reads as "the branch has no one in it".
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const selected = users.find((u) => u.id === value);

  // Sorted here as well as server-side: this component also renders lists a
  // caller assembled itself, and an assignee dropdown that is not alphabetical
  // is one people scan top to bottom without finding the name they want.
  const sorted = useMemo(() => sortByDisplayName(users), [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (u) =>
        displayName(u).toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.role_label ?? '').toLowerCase().includes(q),
    );
  }, [sorted, search]);

  // Name first — people pick a colleague by name, not by mailbox. The email
  // moves to the secondary line rather than disappearing: two people in this
  // tenant genuinely share a display name across branches, so it is what tells
  // them apart.
  const selectedLabel = selected ? displayName(selected) : '';

  const panel = open && rect && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={panelRef}
          style={rect.style}
          className="flex flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-lg"
        >
          <div className="shrink-0 border-b border-[#F1F5F9] p-2">
            <input
              autoFocus
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or role…"
              className="w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
            />
          </div>
          {/* min-h-0 is what lets this flex child shrink and become the scroll
              region, instead of pushing the panel past its measured height. */}
          <ul role="listbox" className="min-h-0 flex-1 overflow-y-auto">
            {filtered.map((u) => {
              const isSelected = u.id === value;
              const name = displayName(u);
              // Only show the email as a subtitle when it is not already the
              // label (i.e. when the user has no name to show).
              const detail = [u.role_label, name === u.email ? '' : u.email]
                .filter(Boolean)
                .join(' · ');
              return (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => { onChange(u.id); setOpen(false); }}
                  className={`cursor-pointer px-3 py-3 transition-colors ${
                    isSelected
                      ? 'bg-[#EFF6FF] text-[#0b6cbf]'
                      : 'text-[#0F172A] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <span className="block text-sm font-medium">{name}</span>
                  {detail && (
                    <span className="block text-xs text-[#64748B]">{detail}</span>
                  )}
                </li>
              );
            })}
            {users.length === 0 && (
              <li className="px-3 py-5 text-center text-sm text-[#64748B]">No users available</li>
            )}
            {users.length > 0 && filtered.length === 0 && (
              <li className="px-3 py-5 text-center text-sm text-[#64748B]">
                No matches for &quot;{search.trim()}&quot;.
              </li>
            )}
          </ul>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-[#0F172A]">
        {label}
      </label>
      <div ref={containerRef} className="relative">
        <button
          ref={buttonRef}
          id={id}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center justify-between rounded-xl border border-[#E2E8F0] bg-white px-3 py-3 text-left text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
        >
          <span className={selectedLabel ? 'truncate' : 'text-[#94A3B8]'}>
            {selectedLabel || 'Select a user…'}
          </span>
          <svg
            className={`ml-2 h-4 w-4 shrink-0 text-[#64748B] transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {panel}
      </div>
    </div>
  );
}
