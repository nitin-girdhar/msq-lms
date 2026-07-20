'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionUser, UserRole } from '@platform/types';
import { ROLES, ROLE_RANK } from '@platform/auth-constants';
import { canCreateUser } from '@/src/lib/permissions';
import { Modal, users as usersApi } from '@platform/ui-kit';
import RoleSelector from './RoleSelector';
import TemporaryPasswordPanel from './TemporaryPasswordPanel';

const PHONE_RE = /^(\+91[\s-]?)?[6-9]\d{9}$/;

interface Props {
  open: boolean;
  onClose: () => void;
  actorRank: number;
  users: SessionUser[];
  actor: SessionUser;
}

interface CreateSuccess {
  email: string;
  temporaryPassword: string;
}

function defaultCreatableRole(actorRank: number): UserRole | null {
  for (const r of ROLES) {
    if (canCreateUser(actorRank, ROLE_RANK[r] ?? 0)) return r;
  }
  return null;
}

export default function CreateUserModal({ open, onClose, actorRank, users, actor }: Props) {
  const router = useRouter();
  const initialRole = useMemo(
    () => defaultCreatableRole(actorRank) ?? 'sales_representative',
    [actorRank],
  );
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole>(initialRole);
  const [managerId, setManagerId] = useState(actor.id);
  const [forcePasswordChange, setForcePasswordChange] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<CreateSuccess | null>(null);

  const reset = () => {
    setFirstName('');
    setMiddleName('');
    setLastName('');
    setEmail('');
    setMobile('');
    setMobileError(null);
    setRole(initialRole);
    setManagerId(actor.id);
    setForcePasswordChange(true);
    setError(null);
    setSuccess(null);
  };

  const handleClose = () => {
    if (pending) return;
    reset();
    onClose();
    if (success) router.refresh();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim()) {
      setError('First name is required.');
      return;
    }
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    if (mobile && !PHONE_RE.test(mobile)) {
      setMobileError('Enter a valid 10-digit Indian mobile number.');
      return;
    }
    setMobileError(null);
    setPending(true);
    try {
      const body: Record<string, unknown> = {
        first_name: firstName.trim(),
        email: email.trim(),
        role_name: role,
        force_password_change: forcePasswordChange,
      };
      if (middleName.trim()) body.middle_name = middleName.trim();
      if (lastName.trim()) body.last_name = lastName.trim();
      if (mobile) body.mobile = mobile;
      if (managerId) body.manager_id = managerId;

      const data = await usersApi.create(body);
      if (!data.temporary_password || !data.data?.email) {
        setError('Unexpected response from server.');
        return;
      }
      setSuccess({ email: data.data.email, temporaryPassword: data.temporary_password });
    } catch (err: unknown) {
      const body = (err as { body?: { details?: Array<{ path: string[]; message: string }> } }).body;
      const detail = body?.details?.map((d) => `${d.path.join('.')}: ${d.message}`).join('; ');
      setError(detail || (err instanceof Error ? err.message : 'Network error.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title={success ? 'User created' : 'New user'} locked={pending}>
      {success ? (
        <div className="space-y-4">
          <p className="text-sm text-[#0F172A]">
            <span className="font-semibold">{success.email}</span> can now sign in.
          </p>
          <TemporaryPasswordPanel password={success.temporaryPassword} email={success.email} />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699]"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field id="cu-first-name" label="First name *" value={firstName} onChange={setFirstName} disabled={pending} required autoComplete="given-name" />
            <Field id="cu-last-name" label="Last name" value={lastName} onChange={setLastName} disabled={pending} autoComplete="family-name" />
          </div>
          <Field id="cu-middle-name" label="Middle name" value={middleName} onChange={setMiddleName} disabled={pending} autoComplete="additional-name" />
          <div className="grid grid-cols-2 gap-3">
            <Field id="cu-email" label="Email *" type="email" value={email} onChange={setEmail} disabled={pending} required autoComplete="off" />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cu-mobile" className="text-xs font-semibold text-[#0F172A]">Mobile</label>
              <input
                id="cu-mobile"
                type="tel"
                value={mobile}
                onChange={(e) => { setMobile(e.target.value); setMobileError(null); }}
                disabled={pending}
                placeholder="+91 98XXXXXXXX"
                autoComplete="tel"
                className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
              />
              {mobileError && <p className="text-[11px] text-red-600">{mobileError}</p>}
            </div>
          </div>

          <RoleSelector id="cu-role" value={role} onChange={setRole} actorRank={actorRank} disabled={pending} />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="cu-manager" className="text-xs font-semibold text-[#0F172A]">Manager</label>
            <select
              id="cu-manager"
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              disabled={pending}
              className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
            >
              <option value="">— None —</option>
              {users.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>{u.name ?? u.email}</option>
              ))}
            </select>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-[#0F172A]">
            <input
              type="checkbox"
              checked={forcePasswordChange}
              onChange={(e) => setForcePasswordChange(e.target.checked)}
              disabled={pending}
              className="h-4 w-4 rounded border-[#E2E8F0] text-[#0b6cbf] focus:ring-[#0b6cbf]/20"
            />
            <span>Require password change on first login</span>
          </label>

          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={handleClose} disabled={pending}
              className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60">
              Cancel
            </button>
            <button type="submit" disabled={pending} aria-busy={pending}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-70">
              {pending && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
              )}
              {pending ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'email';
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
}

function Field({ id, label, value, onChange, type = 'text', disabled, required, autoComplete }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-[#0F172A]">{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        disabled={disabled}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
      />
    </div>
  );
}
