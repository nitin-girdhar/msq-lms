import type { FastifyReply } from 'fastify';
import { getRulesForTenant, canViewUnassignedLeads } from '@lms/authz';
import type { LeadEvent } from '../transport/types.js';

export interface ConnectedClient {
  id: string;
  userId: string;
  orgId: string;
  tenantId: string;
  role: string;
  rank: number;
  reply: FastifyReply;
  keepaliveTimer: ReturnType<typeof setInterval>;
}

class ConnectionManager {
  private clients = new Map<string, ConnectedClient>();

  addClient(client: ConnectedClient): void {
    this.clients.set(client.id, client);
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      clearInterval(client.keepaliveTimer);
      this.clients.delete(id);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  broadcast(event: LeadEvent): void {
    for (const client of this.clients.values()) {
      const allowed = canSeeEvent(client, event);
      console.log(
        `[broadcast] client=${client.userId} role=${client.role} org=${client.orgId} | event.org=${event.org_id} event.assigned=${event.assigned_user_id} → ${allowed ? 'SEND' : 'SKIP'}`,
      );
      if (!allowed) continue;
      sendSSE(client.reply, event.type, {
        lead_id: event.lead_id,
        action: event.type.split(':')[1],
        actor_id: event.actor_id,
      });
    }
  }

  sendToUser(userId: string, eventType: string, data: Record<string, unknown>): boolean {
    let sent = false;
    for (const client of this.clients.values()) {
      if (client.userId === userId) {
        sendSSE(client.reply, eventType, data);
        sent = true;
      }
    }
    return sent;
  }

  close(): void {
    for (const client of this.clients.values()) {
      clearInterval(client.keepaliveTimer);
    }
    this.clients.clear();
  }
}

/**
 * Server-side security filter. Determines whether a connected client
 * is authorized to receive a given lead event. This mirrors the RLS
 * policies enforced at the database level.
 */
function canSeeEvent(client: ConnectedClient, event: LeadEvent): boolean {
  if (client.role === 'super_admin') return true;

  if (client.role === 'tenant_admin') {
    return client.tenantId === event.tenant_id;
  }

  if (client.orgId !== event.org_id) return false;

  if (client.role === 'org_admin') return true;

  // Unassigned leads: visible to roles that are allowed to see unassigned
  // leads at all (mirrors the same rule enforced in listLeads).
  if (event.assigned_user_id === null) {
    const rules = getRulesForTenant(client.tenantId);
    if (canViewUnassignedLeads(rules, client.rank)) return true;
  }

  // All other roles: must be the assigned user or the actor
  return (
    client.userId === event.assigned_user_id ||
    client.userId === event.actor_id
  );
}

function sendSSE(
  reply: FastifyReply,
  eventType: string,
  data: Record<string, unknown>,
): void {
  try {
    reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client disconnected — connection cleanup handled by request close handler
  }
}

export const connectionManager = new ConnectionManager();
