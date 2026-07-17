export interface LeadEvent {
  type: string;
  lead_id: string;
  org_id: string;
  tenant_id: string;
  assigned_user_id: string | null;
  actor_id: string;
  changes?: Record<string, unknown>;
  ts: number;
}

export interface EventTransport {
  subscribe(handler: (event: LeadEvent) => void): Promise<void>;
  close(): Promise<void>;
}
