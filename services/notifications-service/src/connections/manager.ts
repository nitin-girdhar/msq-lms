import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { getRulesForTenant, canViewUnassignedLeads } from '@lms/authz';
import type { LeadEvent } from '../transport/types.js';

// Minimal logger surface so the manager can be constructed before the Fastify
// instance exists in tests, and so nothing here depends on the app object.
type Logger = Pick<FastifyBaseLogger, 'info' | 'debug' | 'warn'>;

// No-op until setLogger runs at startup. Previously this module used
// `console.log` directly, which bypassed pino entirely: unstructured, unfiltered
// by LOG_LEVEL, and — because it fired once per connected client per event —
// enough volume on its own to matter (200 clients = 200 stdout writes per lead
// update, each a synchronous write on the event loop).
const noopLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
};

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
  private log: Logger = noopLogger;

  /** Wire in the Fastify logger at startup, before any client connects. */
  setLogger(logger: Logger): void {
    this.log = logger;
  }

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
    let sent = 0;
    let skipped = 0;

    for (const client of this.clients.values()) {
      const allowed = canSeeEvent(client, event);

      // Per-client detail is a debug-level concern: it is the routing decision
      // for ONE recipient, useful when chasing "why did X not get an event" and
      // pure noise otherwise. At debug, pino also skips building the object
      // entirely when the level is off — the old console.log did not.
      this.log.debug(
        {
          clientUserId: client.userId,
          clientRole: client.role,
          clientOrgId: client.orgId,
          eventOrgId: event.org_id,
          eventAssignedUserId: event.assigned_user_id,
          decision: allowed ? 'send' : 'skip',
        },
        'broadcast routing decision',
      );

      if (!allowed) {
        skipped += 1;
        continue;
      }
      sendSSE(client.reply, event.type, {
        lead_id: event.lead_id,
        action: event.type.split(':')[1],
        actor_id: event.actor_id,
      });
      sent += 1;
    }

    // One structured line per broadcast rather than one per client.
    this.log.info(
      { eventType: event.type, leadId: event.lead_id, sent, skipped },
      'broadcast complete',
    );
  }

  /**
   * Deliver a targeted event to one user's live connections.
   *
   * Scoped by org, not just user id. A user mapped to several branches can hold
   * a connection opened under branch A while the event concerns branch B; before
   * this, matching on `userId` alone pushed the branch-B notification onto the
   * branch-A session — a cross-branch leak of the kind `canSeeEvent` is careful
   * to prevent on the broadcast path. `orgId` is optional so existing callers
   * that genuinely mean "any session of this user" keep working, but the
   * follow-up checker passes it.
   */
  sendToUser(
    userId: string,
    eventType: string,
    data: Record<string, unknown>,
    orgId?: string,
  ): boolean {
    let sent = false;
    for (const client of this.clients.values()) {
      if (client.userId !== userId) continue;
      if (orgId && client.orgId !== orgId) continue;
      sendSSE(client.reply, eventType, data);
      sent = true;
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
