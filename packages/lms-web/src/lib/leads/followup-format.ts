// Shared shape + time formatters for the Follow-Up Pipeline screen. Extracted so
// the desktop AG Grid (FollowUpGrid) and the mobile card list (MobileFollowUpCard)
// format "due in" / "overdue" identically and can't drift apart.

export interface FollowUpItem {
  followUpId: string | null;
  leadId: string;
  leadFullName: string;
  leadPhone: string | null;
  leadStage: string;
  leadStageLabel: string | null;
  assignedRepName: string;
  assignedRepEmail: string;
  isOverdue: boolean | null;
  minutesOverdue: number | null;
  followUpStatus: string | null;
  followUpStatusLabel: string | null;
  scheduledAt: string | null;
  lastInteractionAt: string | null;
  lastInteractionType: string | null;
  lastInteractionTypeLabel: string | null;
  notes: string | null;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export function overdueDuration(mins: number): string {
  if (mins < 60) return `${mins}m overdue`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m overdue`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h overdue`;
}
