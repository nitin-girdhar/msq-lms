import type { SourceRow } from '../../lib/leads/stats';

interface Props {
  rows: SourceRow[];
  total: number;
  /** Placement/visibility is the caller's call — inline in the toolbar on desktop, own row on mobile. */
  className?: string;
}

/**
 * Source split of whichever stat card is currently selected. Lives in the toolbar
 * so the cards stay compact and only one breakdown is on screen at a time. Below `md`
 * the toolbar has no room for it, so the shell renders it as its own scrollable row.
 */
export default function SourceBreakdownBar({ rows, total, className = '' }: Props) {
  if (!rows.length) return null;

  return (
    <div
      className={`min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-[#94A3B8]">
        By source
      </span>
      {rows.map((r) => {
        const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
        return (
          <span
            key={r.label}
            title={`${r.label}: ${r.count} (${pct}%)`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-0.5 text-xs font-medium text-[#475569]"
          >
            <span style={{ background: r.dot }} className="h-1.5 w-1.5 shrink-0 rounded-full" />
            {r.label}
            <span className="font-bold tabular-nums text-[#0F172A]">{r.count}</span>
            <span className="tabular-nums text-[#94A3B8]">{pct}%</span>
          </span>
        );
      })}
    </div>
  );
}
