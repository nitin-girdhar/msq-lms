"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LeadView } from "../types/leads";
import { leads as leadsApi } from '../lib/api/client';
import { LeadFormDataPanel } from "./leads/LeadFormDataPanel";
import { STATUS_CONFIG } from "./leads/constants";

interface TimelineEvent {
  eventId: string;
  orgId: string;
  leadId: string;
  eventType:
    | "status_change"
    | "follow_up"
    | "interaction"
    | "assignment_change";
  eventAt: string;
  actorName: string | null;
  actorEmail: string | null;
  oldStage: string | null;
  oldStageLabel: string | null;
  newStage: string | null;
  newStageLabel: string | null;
  oldOutcome: string | null;
  oldOutcomeLabel: string | null;
  newOutcome: string | null;
  newOutcomeLabel: string | null;
  assignedToName: string | null;
  note: string | null;
  followupId: string | null;
  followupStatus: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  interactionType: string | null;
}

interface EventGroup {
  id: string;
  events: TimelineEvent[];
  anchor: TimelineEvent;
}

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  new: { bg: "#EFF6FF", color: "#1D4ED8" },
  contacting: { bg: "#FFF7ED", color: "#C2410C" },
  qualified: { bg: "#FAF5FF", color: "#7E22CE" },
  converted: { bg: "#F0FDF4", color: "#15803D" },
  unqualified: { bg: "#FEF2F2", color: "#B91C1C" },
  transferred_out: { bg: "#FFFBEB", color: "#92400E" },
};

function StatusPill({
  name,
  label,
}: {
  name: string | null;
  label: string | null;
}) {
  if (!name) return <span className="text-[#94A3B8] italic text-xs">—</span>;
  const cfg = STATUS_COLORS[name];
  const text =
    label ?? name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
      style={
        cfg
          ? { background: cfg.bg, color: cfg.color }
          : { background: "#F1F5F9", color: "#475569" }
      }
    >
      {text}
    </span>
  );
}

function FollowUpPill({ status }: { status: string | null }) {
  if (!status) return null;
  const cfg: Record<string, string> = {
    pending: "bg-amber-100 text-amber-700",
    completed: "bg-emerald-100 text-emerald-700",
    missed: "bg-red-100 text-red-700",
    rescheduled: "bg-blue-100 text-blue-700",
  };
  const label = status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cfg[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {label}
    </span>
  );
}

function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(String(iso));
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function InteractionIcon({ type }: { type: string | null }) {
  const t = (type ?? "").toLowerCase();
  if (t.includes("call") || t.includes("phone")) {
    return (
      <svg
        className="h-3.5 w-3.5 shrink-0 text-sky-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498A1 1 0 0121 17.72V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
        />
      </svg>
    );
  }
  if (t.includes("email") || t.includes("mail")) {
    return (
      <svg
        className="h-3.5 w-3.5 shrink-0 text-sky-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
        />
      </svg>
    );
  }
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 text-sky-600"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

function SummaryField({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">
        {label}
      </span>
      {href && value ? (
        <a
          href={href}
          className="text-sm font-medium text-[#0b6cbf] hover:underline truncate"
        >
          {value}
        </a>
      ) : (
        <span className="text-sm font-medium text-[#0F172A] truncate">
          {value || "—"}
        </span>
      )}
    </div>
  );
}

function eventKey(ev: TimelineEvent): string {
  return ev.eventId ? `${ev.eventType}-${ev.eventId}` : "";
}

function groupEvents(events: TimelineEvent[]): EventGroup[] {
  if (events.length === 0) return [];
  const WINDOW_MS = 30_000;
  const groups: EventGroup[] = [];
  let current: TimelineEvent[] = [events[0]];

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    const anchor = current[0];
    const bothHaveActor = Boolean(ev.actorName) && Boolean(anchor.actorName);
    const sameActor = bothHaveActor && ev.actorName === anchor.actorName;
    const t1 = anchor.eventAt ? new Date(String(anchor.eventAt)).getTime() : 0;
    const t2 = ev.eventAt ? new Date(String(ev.eventAt)).getTime() : 0;
    const within = t1 - t2 <= WINDOW_MS;
    if (sameActor && within) {
      current.push(ev);
    } else {
      groups.push({
        id: eventKey(anchor) || `g${groups.length}`,
        events: current,
        anchor,
      });
      current = [ev];
    }
  }
  groups.push({
    id: eventKey(current[0]) || `g${groups.length}`,
    events: current,
    anchor: current[0],
  });
  return groups;
}

function groupDotClass(g: EventGroup): string {
  const evs = g.events;
  if (evs.some((e) => e.eventType === "status_change")) return "bg-indigo-500";
  if (evs.some((e) => e.eventType === "assignment_change"))
    return "bg-violet-500";
  if (evs.some((e) => e.followupStatus === "completed"))
    return "bg-emerald-500";
  if (evs.some((e) => e.followupStatus === "missed")) return "bg-red-400";
  if (evs.some((e) => e.eventType === "follow_up")) return "bg-amber-400";
  if (evs.some((e) => e.eventType === "interaction")) return "bg-sky-500";
  return "bg-[#CBD5E1]";
}

function groupCardClass(g: EventGroup): string {
  const evs = g.events;
  if (evs.some((e) => e.eventType === "status_change"))
    return "border-[#E2E8F0] bg-white";
  if (evs.some((e) => e.eventType === "assignment_change"))
    return "border-violet-100 bg-violet-50";
  if (evs.some((e) => e.followupStatus === "missed"))
    return "border-red-100 bg-red-50";
  if (evs.some((e) => e.followupStatus === "pending"))
    return "border-amber-100 bg-amber-50";
  if (evs.some((e) => e.eventType === "interaction"))
    return "border-sky-100 bg-sky-50";
  return "border-[#E2E8F0] bg-white";
}

function GroupedEventCard({
  group,
  onUpdateFollowUp,
  readOnly,
}: {
  group: EventGroup;
  onUpdateFollowUp: (fu: TimelineEvent) => void;
  readOnly?: boolean;
}) {
  const { events, anchor } = group;
  const statusEv = events.find((e) => e.eventType === "status_change");
  const assignEv = events.find((e) => e.eventType === "assignment_change");
  const followUps = events.filter((e) => e.eventType === "follow_up");
  const otherInteractions = events.filter(
    (e) =>
      e.eventType === "interaction" && e.interactionType !== "internal_note",
  );
  const noteInteractions = events.filter(
    (e) =>
      e.eventType === "interaction" && e.interactionType === "internal_note",
  );

  return (
    <div
      className={`rounded-xl border px-4 py-3 flex flex-col gap-2 ${groupCardClass(group)}`}
    >
      {statusEv && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-[#0F172A]">
          <svg
            className="h-3.5 w-3.5 shrink-0 text-indigo-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          <span>Status Updated</span>
          {statusEv.oldStage ? (
            <>
              <span className="text-[#94A3B8] font-normal">from</span>
              <StatusPill
                name={statusEv.oldStage}
                label={statusEv.oldStageLabel}
              />
              <span className="text-[#94A3B8] font-normal">to</span>
            </>
          ) : (
            <span className="text-[#94A3B8] font-normal">set to</span>
          )}
          <StatusPill name={statusEv.newStage} label={statusEv.newStageLabel} />
        </div>
      )}

      {statusEv?.newOutcome && (
        <p className="pl-5 text-xs text-red-600">
          Reason:{" "}
          <span className="font-semibold">
            {statusEv.newOutcomeLabel ?? statusEv.newOutcome.replace(/_/g, " ")}
          </span>
        </p>
      )}

      {assignEv && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-[#0F172A]">
          <svg
            className="h-3.5 w-3.5 shrink-0 text-violet-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
          <span>{assignEv.note ?? "Assignment Changed"}</span>
        </div>
      )}

      {followUps.map((fu) => (
        <div
          key={fu.followupId ?? fu.eventId}
          className="flex flex-wrap items-center justify-between gap-1.5"
        >
          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-[#0F172A]">
            <svg
              className="h-3.5 w-3.5 shrink-0 text-amber-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <span>Follow-up</span>
            <FollowUpPill status={fu.followupStatus} />
            {fu.scheduledAt && (
              <span className="text-xs font-normal text-[#64748B]">
                {fu.followupStatus === "completed" ? "completed" : "scheduled"}{" "}
                {formatDate(fu.scheduledAt)}
              </span>
            )}
            {fu.assignedToName && (
              <span className="text-xs font-normal text-[#64748B]">
                · {fu.assignedToName}
              </span>
            )}
          </div>
          {!readOnly && fu.followupId &&
            ["pending", "missed"].includes(fu.followupStatus ?? "") && (
              <button
                type="button"
                onClick={() => onUpdateFollowUp(fu)}
                className="shrink-0 rounded-md border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-semibold text-[#475569] hover:border-[#0891b2] hover:text-[#0891b2] transition-colors"
              >
                Update
              </button>
            )}
        </div>
      ))}

      {otherInteractions.map((ix) => (
        <div
          key={ix.eventId}
          className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-[#0F172A]"
        >
          <InteractionIcon type={ix.interactionType} />
          <span>
            {ix.interactionType
              ? ix.interactionType
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (c) => c.toUpperCase())
              : "Interaction"}{" "}
            Logged
          </span>
        </div>
      ))}

      {statusEv?.note && (
        <p className="rounded-lg border-l-2 border-[#CBD5E1] bg-white/70 px-3 py-2 text-sm text-[#475569] italic">
          {statusEv.note}
        </p>
      )}

      {followUps
        .filter((fu) => fu.note)
        .map((fu) => (
          <p
            key={`funote-${fu.followupId ?? fu.eventId}`}
            className="rounded-lg border-l-2 border-[#CBD5E1] bg-white/70 px-3 py-2 text-sm text-[#475569] italic"
          >
            {fu.note}
          </p>
        ))}

      {noteInteractions
        .filter((ni) => ni.note)
        .map((ni) => (
          <p
            key={`ni-${ni.eventId}`}
            className="rounded-lg border-l-2 border-[#CBD5E1] bg-white/70 px-3 py-2 text-sm text-[#475569] italic"
          >
            {ni.note}
          </p>
        ))}

      <p className="text-xs text-[#64748B] mt-0.5">
        {anchor.actorName ?? <span className="italic">System / Import</span>}
        <span className="mx-1 text-[#CBD5E1]">·</span>
        {formatDate(anchor.eventAt)}
      </p>
    </div>
  );
}

// ── Follow-Up Action Modal ────────────────────────────────────────────────────
type FollowUpAction = "complete" | "reschedule" | "add_note";

function defaultRescheduleAt(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.toISOString().slice(0, 16);
}

interface FollowUpActionModalProps {
  followUp: TimelineEvent;
  onClose: () => void;
  onUpdated: () => void;
}

function FollowUpActionModal({
  followUp,
  onClose,
  onUpdated,
}: FollowUpActionModalProps) {
  const [action, setAction] = useState<FollowUpAction>("complete");
  const [notes, setNotes] = useState("");
  const [scheduledAt, setScheduledAt] = useState(defaultRescheduleAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nowIso = new Date().toISOString().slice(0, 16);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (action === "reschedule" && !scheduledAt) {
      setError("Please set a new date and time.");
      return;
    }
    if (action === "add_note" && !notes.trim()) {
      setError("Please enter a note.");
      return;
    }
    if (!followUp.followupId) {
      setError("Follow-up ID missing — cannot update this entry.");
      return;
    }

    setLoading(true);
    try {
      const body: Record<string, unknown> = { action };
      if (action === "reschedule")
        body.scheduledAt = new Date(scheduledAt).toISOString();
      if (notes.trim()) body.notes = notes.trim();

      await leadsApi.updateFollowUp(followUp.leadId, followUp.followupId!, body);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#E2E8F0] px-6 py-4">
          <h2 className="text-base font-semibold text-[#0F172A]">
            Update Follow-Up
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[#94A3B8] hover:bg-[#F1F5F9] hover:text-[#475569]"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div>
            <label className="mb-2 block text-xs font-bold uppercase tracking-widest text-[#94A3B8]">
              Action
            </label>
            <div className="flex gap-2">
              {(["complete", "reschedule", "add_note"] as FollowUpAction[]).map(
                (a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAction(a)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                      action === a
                        ? "border-[#0891b2] bg-[#EFF6FF] text-[#0891b2]"
                        : "border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC]"
                    }`}
                  >
                    {a === "complete"
                      ? "Complete"
                      : a === "reschedule"
                        ? "Reschedule"
                        : "Add Note"}
                  </button>
                ),
              )}
            </div>
          </div>

          {action === "reschedule" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-[#475569]">
                New date &amp; time <span className="text-red-500">*</span>
              </label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                required
                min={nowIso}
                className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0891b2]"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-semibold text-[#475569]">
              {action === "add_note" ? (
                <>
                  <>Note</> <span className="text-red-500">*</span>
                </>
              ) : (
                <>
                  <>Notes</>{" "}
                  <span className="text-xs font-normal text-[#94A3B8]">
                    (optional)
                  </span>
                </>
              )}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                action === "complete"
                  ? "What was the outcome of this follow-up?"
                  : action === "reschedule"
                    ? "Why is this being rescheduled?"
                    : "Add a note to this follow-up…"
              }
              rows={3}
              className="w-full resize-none rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0891b2]"
            />
          </div>

          {error && (
            <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-lg border border-[#E2E8F0] px-4 py-2 text-sm font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#0891b2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0e7490] disabled:opacity-50"
            >
              {loading ? (
                <>
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Lead History Modal ────────────────────────────────────────────────────────
interface Props {
  lead: { lead_id: string };
  statusLabelMap?: Record<string, string>;
  onClose: () => void;
}

export function LeadHistoryModal({ lead: leadProp, statusLabelMap = {}, onClose }: Props) {
  const [lead, setLead] = useState<LeadView | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFollowUp, setActiveFollowUp] = useState<TimelineEvent | null>(null);
  const leadId = leadProp.lead_id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      leadsApi.get(leadId).then((res: { data: unknown }) => res.data ?? null),
      leadsApi.getTimeline(leadId).then((res: { data: unknown[] }) => (res.data ?? []) as TimelineEvent[]),
    ])
      .then(([leadData, timelineData]) => {
        setLead(leadData as LeadView | null);
        setEvents(timelineData);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load data"))
      .finally(() => setLoading(false));
  }, [leadId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (typeof document === "undefined") return null;

  const currentStatus = lead?.stage ?? "";
  const statusLabel = statusLabelMap[currentStatus] ?? lead?.stage_label ?? currentStatus;
  const statusCfg = STATUS_CONFIG[currentStatus];
  const groups = groupEvents(events);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-[2px] p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="my-auto w-full max-w-3xl rounded-2xl bg-white shadow-2xl flex flex-col overflow-hidden"
        style={{ maxHeight: "90vh" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[#F1F5F9] px-6 py-4 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#0F172A]">Lead History</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium text-[#0F172A]">{lead?.full_name || "—"}</span>
              {lead?.phone && (
                <a href={`tel:${lead.phone}`} className="flex items-center gap-1 text-xs text-[#0b6cbf] hover:underline">
                  <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498A1 1 0 0121 17.72V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  {lead.phone}
                </a>
              )}
              {lead?.email && (
                <a href={`mailto:${lead.email}`} className="flex items-center gap-1 text-xs text-[#0b6cbf] hover:underline">
                  <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  {lead.email}
                </a>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} className="ml-4 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#64748B] hover:bg-[#F1F5F9]">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Lead Details */}
        {lead && (
          <div className="border-b border-[#F1F5F9] px-6 py-4 shrink-0">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Lead Details</p>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
              <InfoRow label="Status" value={statusLabel} />
              <InfoRow label="Outcome" value={lead.outcome_label ?? "—"} />
              <InfoRow label="Date" value={lead.created_at ? new Date(lead.created_at).toLocaleDateString("en-IN") : "—"} />
              <InfoRow label="Lead Source" value={lead.source ?? lead.platform ?? "—"} />
              <InfoRow label="Assigned To" value={lead.assigned_rep_name ?? "—"} />
              <InfoRow label="Follow-up" value={lead.scheduled_at ? formatDate(lead.scheduled_at) : "—"} />
              <InfoRow label="Campaign" value={lead.campaign_name ?? "—"} full />
            </div>
          </div>
        )}

        {/* Original form submission — same expandable section as the Edit modal */}
        <LeadFormDataPanel
          leadId={leadId}
          source={lead?.source ?? lead?.platform}
          className="border-b border-[#F1F5F9] shrink-0"
        />

        <div className="flex flex-col overflow-hidden flex-1">
          <div className="px-6 py-3 border-b border-[#F1F5F9] shrink-0 flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">
              Activity History
            </p>
            {!loading && !error && groups.length > 0 && (
              <span className="text-[10px] font-semibold text-[#94A3B8]">
                {groups.length} event{groups.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          <div className="overflow-y-auto flex-1 px-6 py-4">
            {loading && (
              <div className="flex items-center justify-center py-12 gap-2 text-[#94A3B8]">
                <svg
                  className="h-4 w-4 animate-spin text-[#0A6BA8]"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z"
                  />
                </svg>
                <span className="text-sm">Loading history…</span>
              </div>
            )}

            {!loading && error && (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                <svg
                  className="h-8 w-8 text-red-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-[#475569]">
                    Could not load history
                  </p>
                  <p className="mt-0.5 text-xs text-[#94A3B8]">{error}</p>
                </div>
              </div>
            )}

            {!loading && !error && groups.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                <svg
                  className="h-8 w-8 text-[#CBD5E1]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-[#475569]">
                    No activity yet
                  </p>
                  <p className="mt-0.5 text-xs text-[#94A3B8]">
                    Status changes, follow-ups, and interactions will appear
                    here.
                  </p>
                </div>
              </div>
            )}

            {!loading && !error && groups.length > 0 && (
              <div className="relative">
                <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-[#E2E8F0]" />
                <ul className="space-y-3 pl-8">
                  {groups.map((group) => (
                    <li key={group.id} className="relative">
                      <span
                        className={`absolute -left-[23px] top-3 h-3.5 w-3.5 rounded-full ring-2 ring-white ${groupDotClass(group)}`}
                      />
                      <GroupedEventCard
                        group={group}
                        onUpdateFollowUp={setActiveFollowUp}
                        readOnly
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end border-t border-[#F1F5F9] px-6 py-4 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#E2E8F0] px-5 py-2 text-sm font-semibold text-[#475569] transition-colors hover:bg-[#F8FAFC]"
          >
            Close
          </button>
        </div>
      </div>

      {activeFollowUp && (
        <FollowUpActionModal
          followUp={activeFollowUp}
          onClose={() => setActiveFollowUp(null)}
          onUpdated={() => {
            setActiveFollowUp(null);
            fetchData();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function InfoRow({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex items-start gap-2${full ? " col-span-2" : ""}`}>
      <span className="w-20 shrink-0 pt-px text-xs font-semibold text-[#94A3B8]">{label}</span>
      <span className="break-all text-sm text-[#0F172A]">{value}</span>
    </div>
  );
}
