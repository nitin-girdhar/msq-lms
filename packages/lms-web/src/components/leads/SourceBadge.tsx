// Lead sources are a tenant-managed dynamic list (no color column on the
// backend), so colors are derived by hashing the name against a fixed
// palette — the same name always lands on the same color.
const SOURCE_PALETTE: Array<{ bg: string; color: string; dot: string }> = [
  { bg: '#EFF6FF', color: '#1D4ED8', dot: '#3B82F6' }, // blue
  { bg: '#FDF2F8', color: '#BE185D', dot: '#EC4899' }, // pink
  { bg: '#F0FDF4', color: '#15803D', dot: '#22C55E' }, // green
  { bg: '#FFF7ED', color: '#C2410C', dot: '#F97316' }, // orange
  { bg: '#FAF5FF', color: '#7E22CE', dot: '#A855F7' }, // purple
  { bg: '#ECFEFF', color: '#0E7490', dot: '#06B6D4' }, // cyan
  { bg: '#FEFCE8', color: '#A16207', dot: '#EAB308' }, // yellow
];

export function hashSourceColor(name: string): { bg: string; color: string; dot: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % SOURCE_PALETTE.length;
  return SOURCE_PALETTE[idx];
}

interface Props {
  value: string | null;
  label?: string | null;
}

export function SourceBadge({ value, label }: Props) {
  const text = label ?? value;
  if (!value || !text) {
    return (
      <span style={{ background: '#F1F5F9', color: '#475569' }} className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold">
        —
      </span>
    );
  }
  const { bg, color, dot } = hashSourceColor(value);
  return (
    <span style={{ background: bg, color }} className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold">
      <span style={{ background: dot }} className="w-1.5 h-1.5 rounded-full shrink-0" />
      {text}
    </span>
  );
}
