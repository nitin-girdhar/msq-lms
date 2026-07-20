'use client';

import { useEffect, useRef, useState } from 'react';
import { useNotifications } from '@platform/ui-kit';
import { LeadHistoryModal } from '@lms/web';

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead, dismiss, clearAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const [historyLeadId, setHistoryLeadId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleNotificationClick = (id: string, leadId: string) => {
    markRead(id);
    setHistoryLeadId(leadId);
    setOpen(false);
  };

  return (
    <>
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-[#E2E8F0] bg-white text-[#475569] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A]"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EF4444] px-1 text-[10px] font-bold text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>

        {open && (
          <div
            ref={panelRef}
            className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-[#E2E8F0] bg-white shadow-xl sm:w-96"
            style={{ zIndex: 100 }}
          >
            <div className="flex items-center justify-between border-b border-[#F1F5F9] px-4 py-3">
              <h3 className="text-sm font-bold text-[#0F172A]">
                Notifications
                {unreadCount > 0 && (
                  <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EF4444] px-1.5 text-[10px] font-bold text-white">
                    {unreadCount}
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    className="text-xs font-medium text-[#0b6cbf] hover:text-[#0a5fa8]"
                  >
                    Mark all read
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-xs font-medium text-[#94A3B8] hover:text-[#64748B]"
                  >
                    Clear all
                  </button>
                )}
              </div>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-[#94A3B8]">
                  <svg className="mb-2 h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  <span className="text-xs font-medium">No notifications</span>
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`group flex items-start gap-3 border-b border-[#F8FAFC] px-4 py-3 transition-colors last:border-b-0 ${
                      n.read ? 'bg-white' : 'bg-[#EFF6FF]'
                    } hover:bg-[#F1F5F9] cursor-pointer`}
                    onClick={() => handleNotificationClick(n.id, n.leadId)}
                  >
                    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${n.read ? 'bg-[#F1F5F9] text-[#94A3B8]' : 'bg-[#DBEAFE] text-[#2563EB]'}`}>
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm leading-tight ${n.read ? 'text-[#475569]' : 'font-medium text-[#0F172A]'}`}>
                        {n.message}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#94A3B8]">{timeAgo(n.receivedAt)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
                      className="mt-0.5 shrink-0 text-[#CBD5E1] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#64748B]"
                      aria-label="Dismiss"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {historyLeadId && (
        <LeadHistoryModal
          lead={{ lead_id: historyLeadId }}
          onClose={() => setHistoryLeadId(null)}
        />
      )}
    </>
  );
}
