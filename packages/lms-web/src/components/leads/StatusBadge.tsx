import { STATUS_CONFIG } from './constants';

interface Props {
  value: string;
  labelMap?: Record<string, string>;
}

export function StatusBadge({ value, labelMap }: Props) {
  const cfg   = STATUS_CONFIG[value];
  const bg    = cfg?.bg    ?? '#F1F5F9';
  const color = cfg?.color ?? '#475569';
  const dot   = cfg?.dot   ?? '#94A3B8';
  const text  = labelMap?.[value] ?? value;
  return (
    <span style={{ background: bg, color }} className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold">
      <span style={{ background: dot }} className="w-1.5 h-1.5 rounded-full shrink-0" />
      {text || '—'}
    </span>
  );
}
