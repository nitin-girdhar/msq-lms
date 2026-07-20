'use client';

import { useRef, useState } from 'react';
import type { SessionUser } from '@platform/types';
import { useDismissible } from '@platform/ui-kit';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useDismissible(open, [containerRef], () => setOpen(false));

  const selected = users.find((u) => u.id === value);

  const selectedLabel = selected
    ? (selected.name ? `${selected.name} (${selected.email})` : selected.email)
    : '';

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
          className="flex w-full items-center justify-between rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-left text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
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

        {open && (
          <ul
            role="listbox"
            className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-[#E2E8F0] bg-white shadow-lg"
          >
            {users.map((u) => {
              const isSelected = u.id === value;
              const name = u.name ? `${u.name} (${u.email})` : u.email;
              const role = u.role_label || '';
              return (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => { onChange(u.id); setOpen(false); }}
                  className={`cursor-pointer px-3 py-2 transition-colors ${
                    isSelected
                      ? 'bg-[#EFF6FF] text-[#0b6cbf]'
                      : 'text-[#0F172A] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <span className="block truncate text-sm font-medium">{name}</span>
                  {role && (
                    <span className="block truncate text-[11px] text-[#64748B]">{role}</span>
                  )}
                </li>
              );
            })}
            {users.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-[#64748B]">No users available</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
