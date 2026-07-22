"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@platform/types";
import type { AssignmentView } from '../../types/leads';
import { assignments as assignmentsApi, leads as leadsApi, lead_sources as leadSourcesApi } from '../../lib/api/client';
import { useOrgs } from '../../hooks/useOrgs';
import { Modal, users as usersApi } from "@platform/ui-kit";
import AssignmentSelector from "./AssignmentSelector";

const PHONE_RE = /^(\+91[\s-]?)?[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  open: boolean;
  onClose: () => void;
  actor: SessionUser;
  candidates: SessionUser[];
  existing?: AssignmentView | null;
}

export default function AssignLeadModal({
  open,
  onClose,
  actor,
  candidates,
  existing,
}: Props) {
  const router = useRouter();
  const { orgs } = useOrgs();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [orgId, setOrgId] = useState("");
  // The walk-in-lead org picker lets a tenant/super admin file the lead into ANY
  // branch, so the assignee list must be re-fetched for whichever branch is
  // selected — the static `candidates` prop is scoped to the actor's own org
  // and would otherwise show the wrong branch's users (see AssignmentSelector).
  const [orgCandidates, setOrgCandidates] = useState<SessionUser[]>([]);
  const [orgCandidatesLoading, setOrgCandidatesLoading] = useState(false);
  // Resolved once so walk-in leads are attributed via source_id — the same
  // acquisition-channel field every other lead source (webhook intake, ad
  // campaigns) uses — rather than an untracked free-text metadata field.
  const [walkInSourceId, setWalkInSourceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    leadSourcesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const match = res.data.find((s) => s.name === "walk_in");
        setWalkInSourceId(match?.id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const validAssignedTo = (id: string | null | undefined) =>
    candidates.some((c) => c.id === id) ? (id ?? "") : "";

  const [assignedTo, setAssignedTo] = useState(() =>
    validAssignedTo(existing?.assigned_to),
  );
  const [notes, setNotes] = useState("");

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFirstName("");
    setLastName("");
    setPhone("");
    setEmail("");
    setOrgId("");
    setOrgCandidates([]);
    setAssignedTo(validAssignedTo(existing?.assigned_to));
    setNotes("");
    setError(null);
    setPhoneError(null);
    setEmailError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing]);

  useEffect(() => {
    if (existing || !orgId) {
      setOrgCandidates([]);
      return;
    }
    let cancelled = false;
    setOrgCandidatesLoading(true);
    usersApi
      .assignable({ orgId })
      .then((res) => {
        if (!cancelled) setOrgCandidates((res.data ?? []) as SessionUser[]);
      })
      .catch(() => {
        if (!cancelled) setOrgCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setOrgCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, existing]);

  const close = () => {
    if (pending) return;
    onClose();
    router.refresh();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPhoneError(null);
    setEmailError(null);

    if (isEdit) {
      if (!notes.trim()) {
        setError("Notes are required.");
        return;
      }
      if (!assignedTo) {
        setError("Pick an assignee from the list.");
        return;
      }
      if (!candidates.some((c) => c.id === assignedTo)) {
        setError(
          "The selected assignee is no longer available. Please pick another.",
        );
        return;
      }
      setPending(true);
      try {
        await assignmentsApi.update(existing!.id, {
          assigned_to: assignedTo,
          notes: notes.trim(),
        });
        close();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error.");
      } finally {
        setPending(false);
      }
      return;
    }

    // CREATE
    if (!firstName.trim()) {
      setError("First name is required.");
      return;
    }
    if (!phone.trim()) {
      setPhoneError("Phone number is required.");
      return;
    }
    if (!PHONE_RE.test(phone.trim())) {
      setPhoneError(
        "Enter a valid 10-digit Indian mobile number (e.g. 9876543210 or +91 9876543210).",
      );
      return;
    }
    if (email.trim() && !EMAIL_RE.test(email.trim())) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (!orgId) {
      setError("Select an org.");
      return;
    }
    if (!assignedTo) {
      setError("Pick an assignee.");
      return;
    }
    if (!notes.trim()) {
      setError("Notes are required.");
      return;
    }

    setPending(true);
    try {
      await leadsApi.create({
        first_name: firstName.trim(),
        last_name: lastName.trim() || undefined,
        phone: phone.trim(),
        email: email.trim() || undefined,
        org_id: orgId,
        assigned_user_id: assignedTo,
        ...(walkInSourceId ? { source_id: walkInSourceId } : {}),
        metadata: { source: "walk_in", initial_notes: notes.trim() },
      });
      close();
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string; field?: string } }).body;
      if (body?.field === "phone") {
        setPhoneError(body.error ?? "Phone number already exists in this org.");
      } else if (body?.field === "email") {
        setEmailError(body.error ?? "Email already exists in this org.");
      } else {
        setError(err instanceof Error ? err.message : "Network error.");
      }
    } finally {
      setPending(false);
    }
  };

  const unassign = async () => {
    if (!existing || pending) return;
    setError(null);
    setPending(true);
    try {
      await assignmentsApi.remove(existing.id);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setPending(false);
    }
  };

  const isEdit = !!existing;

  return (
    <Modal
      open={open}
      onClose={close}
      title={isEdit ? "Edit assignment" : "New walk-in lead"}
      locked={pending}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </div>
        )}

        {isEdit ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#0F172A]">
                Org
              </label>
              <input
                type="text"
                value={existing?.branch ?? ""}
                disabled
                className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
              />
            </div>
            {existing?.assigned_rep_name && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                Current Owner:{" "}
                <span className="font-semibold">{existing.assigned_rep_name}</span>
                {existing.assigned_rep_email ? ` (${existing.assigned_rep_email})` : ""}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-2">
              <span className="text-xs font-semibold text-blue-700">
                Source: Walk-in
              </span>
              <span className="text-[11px] text-blue-500">
                Lead will be created with status &quot;new&quot;
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wl-fname"
                  className="text-xs font-semibold text-[#0F172A]"
                >
                  First Name <span className="font-normal text-red-500">*</span>
                </label>
                <input
                  id="wl-fname"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={pending}
                  placeholder="e.g. Rahul"
                  className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wl-lname"
                  className="text-xs font-semibold text-[#0F172A]"
                >
                  Last Name
                </label>
                <input
                  id="wl-lname"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={pending}
                  placeholder="e.g. Singh"
                  className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wl-phone"
                  className="text-xs font-semibold text-[#0F172A]"
                >
                  Phone <span className="font-normal text-red-500">*</span>
                </label>
                <input
                  id="wl-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setPhoneError(null);
                  }}
                  disabled={pending}
                  placeholder="9876543210"
                  className={`rounded-xl border bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[#F8FAFC] ${
                    phoneError
                      ? "border-red-400 focus:border-red-500 focus:ring-red-200"
                      : "border-[#E2E8F0] focus:border-[#0b6cbf] focus:ring-[#0b6cbf]/20"
                  }`}
                />
                {phoneError && (
                  <p className="text-[11px] text-red-500">{phoneError}</p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wl-email"
                  className="text-xs font-semibold text-[#0F172A]"
                >
                  Email
                </label>
                <input
                  id="wl-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailError(null);
                  }}
                  disabled={pending}
                  placeholder="rahul@example.com"
                  className={`rounded-xl border bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[#F8FAFC] ${
                    emailError
                      ? "border-red-400 focus:border-red-500 focus:ring-red-200"
                      : "border-[#E2E8F0] focus:border-[#0b6cbf] focus:ring-[#0b6cbf]/20"
                  }`}
                />
                {emailError && (
                  <p className="text-[11px] text-red-500">{emailError}</p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="wl-org"
                className="text-xs font-semibold text-[#0F172A]"
              >
                Org <span className="font-normal text-red-500">*</span>
              </label>
              <select
                id="wl-org"
                value={orgId}
                onChange={(e) => { setOrgId(e.target.value); setAssignedTo(""); }}
                disabled={pending}
                className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
              >
                <option value="">Select an org…</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <AssignmentSelector
          id="wl-assignee"
          value={assignedTo}
          onChange={setAssignedTo}
          users={isEdit ? candidates : orgCandidates}
          disabled={pending || (!isEdit && (!orgId || orgCandidatesLoading))}
        />
        {!isEdit && !orgId && (
          <p className="-mt-2 text-[11px] text-[#64748B]">Select an org above to see who&apos;s assignable there.</p>
        )}
        {!isEdit && orgId && orgCandidatesLoading && (
          <p className="-mt-2 text-[11px] text-[#64748B]">Loading assignable users…</p>
        )}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="wl-notes"
            className="text-xs font-semibold text-[#0F172A]"
          >
            Notes <span className="font-normal text-red-500">*</span>
          </label>
          <textarea
            id="wl-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
            rows={3}
            placeholder={
              isEdit ? "" : "Fitness goal, membership interest, visit context…"
            }
            className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {isEdit ? (
            <button
              type="button"
              onClick={unassign}
              disabled={pending}
              className="rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Unassign
            </button>
          ) : (
            <span className="text-[11px] text-[#64748B]">
              Acting as {actor.email}
            </span>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0b6cbf] px-3 py-2 text-xs font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {pending && (
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  aria-hidden
                />
              )}
              {isEdit ? "Save changes" : "Add lead"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
