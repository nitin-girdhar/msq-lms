'use client';

import { useEffect, useRef } from 'react';

interface RealtimeEvent {
  lead_id: string;
  action: string;
  actor_id: string;
}

interface FollowUpEvent {
  lead_id: string;
  message: string;
  scheduled_at: string;
}

export interface RealtimeCallbacks {
  onLeadCreated?: (leadId: string) => void;
  onLeadUpdated?: (leadId: string) => void;
  onLeadDeleted?: (leadId: string) => void;
  onFollowUpDue?: (data: FollowUpEvent) => void;
  onFollowUpMissed?: (data: FollowUpEvent) => void;
}

export function useRealtimeEvents(
  currentUserId: string | undefined,
  callbacks: RealtimeCallbacks,
): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!currentUserId) return;

    const es = new EventSource('/api/notifications/stream', { withCredentials: true });

    es.addEventListener('lead:created', (e) => {
      const data = JSON.parse(e.data) as RealtimeEvent;
      if (data.actor_id === currentUserId) return;
      callbacksRef.current.onLeadCreated?.(data.lead_id);
    });

    es.addEventListener('lead:updated', (e) => {
      const data = JSON.parse(e.data) as RealtimeEvent;
      if (data.actor_id === currentUserId) return;
      callbacksRef.current.onLeadUpdated?.(data.lead_id);
    });

    es.addEventListener('lead:deleted', (e) => {
      const data = JSON.parse(e.data) as RealtimeEvent;
      if (data.actor_id === currentUserId) return;
      callbacksRef.current.onLeadDeleted?.(data.lead_id);
    });

    es.addEventListener('followup:due', (e) => {
      const data = JSON.parse(e.data) as FollowUpEvent;
      callbacksRef.current.onFollowUpDue?.(data);
    });

    es.addEventListener('followup:missed', (e) => {
      const data = JSON.parse(e.data) as FollowUpEvent;
      callbacksRef.current.onFollowUpMissed?.(data);
    });

    return () => {
      es.close();
    };
  }, [currentUserId]);
}
