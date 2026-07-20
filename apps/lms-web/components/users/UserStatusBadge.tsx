interface Props {
  active: boolean;
}

export default function UserStatusBadge({ active }: Props) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0" />
      Inactive
    </span>
  );
}
