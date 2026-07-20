'use client';

import { useMemo } from 'react';
import { ROLES, ROLE_LABELS, ROLE_RANK } from '@crm/auth-constants';
import type { UserRole } from '@crm/types';
import { canCreateUser } from '@/src/lib/permissions';

interface Props {
  id: string;
  value: UserRole;
  onChange: (role: UserRole) => void;
  actorRank: number;
  disabled?: boolean;
  label?: string;
}

export default function RoleSelector({
  id,
  value,
  onChange,
  actorRank,
  disabled,
  label = 'Role',
}: Props) {
  const options = useMemo(
    () => ROLES.filter((r) => canCreateUser(actorRank, ROLE_RANK[r] ?? 0)),
    [actorRank],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-[#0F172A]">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as UserRole)}
        disabled={disabled || options.length === 0}
        className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
    </div>
  );
}
