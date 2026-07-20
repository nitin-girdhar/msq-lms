interface Props {
  name: string | null;
}

export function LeadAssigneeBadge({ name }: Props) {
  if (!name) {
    return <span className="text-[11px] italic text-[#94A3B8]">Unassigned</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-semibold text-[#0b6cbf]">
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#0b6cbf] text-[9px] font-bold text-white">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="max-w-[100px] truncate">{name}</span>
    </span>
  );
}
