import { StatusBadge } from './StatusBadge';
import { type FollowUpItem, formatDate, overdueDuration, timeUntil } from '../../lib/leads/followup-format';

interface Props {
  item: FollowUpItem;
  type: 'upcoming' | 'missed';
  onEdit: (f: FollowUpItem) => void;
  onHistory: (f: FollowUpItem) => void;
}

// Below the md breakpoint the Follow-Up grid is replaced by these cards — the
// screen a rep opens from a follow-up notification on a phone. Shows the four
// things that matter on a 390px viewport (name, phone, stage, when it is due)
// and keeps every action at a >=44px tap target.
//
// Actions mirror what the desktop grid offers — Call (phone-only, a plain tel:
// link), Open (the lead edit modal, which is also where a follow-up is
// rescheduled), and History.
export function MobileFollowUpCard({ item, type, onEdit, onHistory }: Props) {
  const isMissed = type === 'missed';
  const stageLabel = item.leadStageLabel ?? item.leadStage.replace(/_/g, ' ');
  const due = item.scheduledAt
    ? (isMissed ? overdueDuration(item.minutesOverdue ?? 0) : `in ${timeUntil(item.scheduledAt)}`)
    : 'Not scheduled';

  return (
    <div className={[
      'flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm',
      isMissed ? 'border-red-200' : 'border-[#E2E8F0]',
    ].join(' ')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-[#0F172A]">{item.leadFullName}</p>
          {item.leadPhone
            ? <p className="text-sm text-[#64748B]">{item.leadPhone}</p>
            : <p className="text-sm italic text-[#94A3B8]">No phone</p>}
        </div>
        <StatusBadge value={item.leadStage} labelMap={{ [item.leadStage]: stageLabel }} />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8]">
          {isMissed ? 'Overdue' : 'Due'}
        </span>
        <span className={isMissed ? 'font-semibold text-red-700' : 'font-semibold text-[#0b6cbf]'}>{due}</span>
        {item.scheduledAt && (
          <span className="text-xs text-[#94A3B8]">· {formatDate(item.scheduledAt)}</span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <a
          href={item.leadPhone ? `tel:${item.leadPhone}` : undefined}
          aria-disabled={!item.leadPhone}
          className={[
            'flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border text-sm font-semibold transition-colors',
            item.leadPhone
              ? 'border-[#E2E8F0] bg-white text-[#0b6cbf] hover:border-[#0b6cbf] active:scale-[0.98]'
              : 'pointer-events-none border-[#F1F5F9] bg-[#F8FAFC] text-[#CBD5E1]',
          ].join(' ')}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498A1 1 0 0121 17.72V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
          Call
        </a>
        <button
          type="button"
          onClick={() => onEdit(item)}
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#475569] transition-colors hover:border-[#0b6cbf] hover:text-[#0b6cbf] active:scale-[0.98]"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Open
        </button>
        <button
          type="button"
          onClick={() => onHistory(item)}
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#475569] transition-colors hover:border-[#7C3AED] hover:text-[#7C3AED] active:scale-[0.98]"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          History
        </button>
      </div>
    </div>
  );
}
