'use client';

import { useState } from 'react';
import { Modal, users as usersApi } from '@platform/ui-kit';

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string;
  email: string;
}

interface Rule {
  label: string;
  test: (v: string) => boolean;
}

const PASSWORD_MIN_LENGTH = parseInt(process.env.NEXT_PUBLIC_PASSWORD_MIN_LENGTH ?? '12', 10);

const RULES: Rule[] = [
  { label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (v) => v.length >= PASSWORD_MIN_LENGTH },
  { label: 'One lowercase letter',                       test: (v) => /[a-z]/.test(v) },
  { label: 'One uppercase letter',                       test: (v) => /[A-Z]/.test(v) },
  { label: 'One number',                                 test: (v) => /[0-9]/.test(v) },
];

export default function ResetPasswordModal({ open, onClose, userId, email }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = () => {
    setPassword('');
    setConfirm('');
    setShow(false);
    setError(null);
    setDone(false);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const allRulesPass = RULES.every((r) => r.test(password));
  const matches = password.length > 0 && password === confirm;
  const canSubmit = allRulesPass && matches && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await usersApi.resetPassword(userId, password);
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title={`Set password · ${email}`} locked={submitting}>
      {done ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Password updated. The user&apos;s existing sessions have been signed
            out and they&apos;ll be asked to choose a new password on next login.
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="self-end rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699]"
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="reset-pw" className="text-xs font-semibold text-[#0F172A]">New password</label>
            <div className="relative">
              <input
                id="reset-pw"
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                autoComplete="new-password"
                className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 pr-16 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-semibold text-[#64748B] hover:bg-[#F1F5F9]"
                tabIndex={-1}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="reset-pw-confirm" className="text-xs font-semibold text-[#0F172A]">Confirm password</label>
            <input
              id="reset-pw-confirm"
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={submitting}
              autoComplete="new-password"
              className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
            />
            {confirm.length > 0 && !matches && (
              <p className="text-xs text-red-600">Passwords do not match.</p>
            )}
          </div>

          <ul className="flex flex-col gap-1">
            {RULES.map((r) => {
              const ok = r.test(password);
              return (
                <li key={r.label} className={`flex items-center gap-1.5 text-[11px] ${ok ? 'text-emerald-600' : 'text-[#94A3B8]'}`}>
                  <span aria-hidden>{ok ? '✓' : '○'}</span>
                  {r.label}
                </li>
              );
            })}
            <li className="text-[11px] text-[#94A3B8]">Special characters allowed (optional)</li>
          </ul>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              aria-busy={submitting}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0b6cbf] px-4 py-2 text-xs font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
              )}
              Set password
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
