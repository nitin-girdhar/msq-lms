'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionUser } from '@platform/types';
import { RANKS } from '@platform/authz';
import {
  Modal,
  users as usersApi,
  DepartmentRoleSelect,
  OrgAssignmentsField,
  ManagerSelect,
  useRoleCatalog,
  useUserAssignments,
} from '@platform/ui-kit';
import TemporaryPasswordPanel from './TemporaryPasswordPanel';

const PHONE_RE = /^(\+91[\s-]?)?[6-9]\d{9}$/;

// The submit button lives in the Modal's pinned footer, outside the <form>;
// the HTML `form` attribute is what still wires it to this form.
const FORM_ID = 'lms-create-user-form';

interface Props {
  open: boolean;
  onClose: () => void;
  actorRank: number;
  users: SessionUser[];
  actor: SessionUser;
  orgs: Array<{ id: string; name: string }>;
}

interface CreateSuccess {
  email: string;
  temporaryPassword: string;
}

export default function CreateUserModal({ open, onClose, actorRank, actor, orgs }: Props) {
  const router = useRouter();

  // Only fetch while the modal is open — the Users page mounts this up-front so
  // the dialog can animate in.
  const { roles, departments, loading: rolesLoading, error: rolesError } = useRoleCatalog(open);

  // Assigning across branches is the same authority as moving someone between
  // them, matching the roster's own cross-org gate.
  const canPickBranches = actorRank >= RANKS.TENANT_ADMIN;

  const a = useUserAssignments({
    fallbackOrgId: actor.org_id,
    roles,
    rolesLoaded: !rolesLoading,
  });

  const branchOptions = canPickBranches ? orgs : orgs.filter((o) => o.id === actor.org_id);

  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [mobileError, setMobileError] = useState<string | null>(null);
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
    setForcePasswordChange(true);
    setError(null);
    setSuccess(null);
    a.reset();
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
    if (!a.isComplete) {
      setError(a.assignments.length === 0 ? 'Select at least one branch.' : 'Every branch needs a role.');
      return;
    }
    setMobileError(null);
    setPending(true);
    try {
      const body: Record<string, unknown> = {
        first_name: firstName.trim(),
        email: email.trim(),
        force_password_change: forcePasswordChange,
        ...a.payload(),
      };
      if (middleName.trim()) body.middle_name = middleName.trim();
      if (lastName.trim()) body.last_name = lastName.trim();
      if (mobile) body.mobile = mobile;
      if (a.managerId) body.manager_id = a.managerId;

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

  const footer = success ? (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={handleClose}
        className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699]"
      >
        Done
      </button>
    </div>
  ) : (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={handleClose} disabled={pending}
        className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60">
        Cancel
      </button>
      <button type="submit" form={FORM_ID} disabled={pending} aria-busy={pending}
        className="inline-flex items-center gap-2 rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-70">
        {pending && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
        )}
        {pending ? 'Creating…' : 'Create user'}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={handleClose} title={success ? 'User created' : 'New user'} locked={pending} maxWidth="max-w-2xl" footer={footer}>
      {success ? (
        <div className="space-y-4">
          <p className="text-sm text-[#0F172A]">
            <span className="font-semibold">{success.email}</span> can now sign in.
          </p>
          <TemporaryPasswordPanel password={success.temporaryPassword} email={success.email} />
        </div>
      ) : (
        <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
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

          {rolesError && (
            <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {rolesError}
            </div>
          )}

          <hr className="border-0 border-t border-[#F1F5F9]" />

          <DepartmentRoleSelect
            departmentId={a.departmentId}
            onDepartmentChange={a.setDepartmentId}
            roleId={a.roleId}
            onRoleChange={a.setRoleId}
            roles={roles}
            departments={departments}
            loading={rolesLoading}
            disabled={pending}
          />

          <OrgAssignmentsField
            branches={branchOptions}
            assignments={a.assignments}
            onChange={a.setAssignments}
            homeOrgId={a.homeOrgId}
            onHomeChange={a.setHomeOrgId}
            roles={roles}
            departmentId={a.departmentId}
            defaultRoleId={a.roleId}
            canPickBranches={canPickBranches}
            disabled={pending}
          />

          <ManagerSelect
            value={a.managerId}
            onChange={a.setManagerId}
            homeOrgId={a.homeOrgId}
            disabled={pending}
          />

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
