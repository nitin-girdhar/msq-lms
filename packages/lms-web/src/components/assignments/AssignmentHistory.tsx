interface ActivityEvent {
  id: string;
  action_type: string;
  performed_by: string | null;
  created_at: string;
}

interface Props {
  events: ActivityEvent[];
  userLabel?: (userId: string | null) => string;
}

const LABELS: Record<string, string> = {
  assignment_created:    'Assigned',
  assignment_reassigned: 'Reassigned',
  assignment_removed:    'Unassigned',
  status_change:         'Status changed',
  lead_transferred:      'Transferred',
};

export default function AssignmentHistory({ events, userLabel }: Props) {
  if (events.length === 0) {
    return <p className="text-xs text-[#64748B]">No assignment history yet.</p>;
  }

  return (
    <ol className="space-y-3" aria-label="Assignment history">
      {events.map((event) => {
        const verb  = LABELS[event.action_type] ?? event.action_type;
        const actor = userLabel
          ? userLabel(event.performed_by)
          : event.performed_by ?? 'system';
        return (
          <li
            key={event.id}
            className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-xs text-[#475569] shadow-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-[#0F172A]">{verb}</span>
              <time className="text-[11px] text-[#94A3B8]">
                {new Date(event.created_at).toLocaleString()}
              </time>
            </div>
            <div className="mt-1 text-[11px]">by {actor}</div>
          </li>
        );
      })}
    </ol>
  );
}
