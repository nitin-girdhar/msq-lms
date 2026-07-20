import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolveMemberRole } from '@platform/db';
import { parseAuthContext } from '../lib/auth-context.js';
import { connectionManager } from '../connections/manager.js';
import { config } from '../config/index.js';

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications/stream', async (request, reply) => {
    const ctx = parseAuthContext(request, reply);
    if (!ctx) return;

    // P1.3: resolve the LMS product rank server-side for lead-event visibility
    // filtering (canViewUnassignedLeads). Non-LMS members resolve to -1 and simply
    // won't receive LMS unassigned-lead broadcasts. When other products emit
    // notifications, they'll resolve their own product rank the same way.
    const { rank } = await resolveMemberRole('lms', ctx.user_id, ctx.org_id);

    const connId = randomUUID();

    // Take over the response — Fastify must not manage headers or body after this
    reply.hijack();

    // Disable socket timeouts — SSE connections must stay open indefinitely
    request.raw.socket.setTimeout(0);
    request.raw.socket.setKeepAlive(true, 30_000);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ connId })}\n\n`);

    const keepaliveTimer = setInterval(() => {
      try {
        reply.raw.write(`:keepalive ${Date.now()}\n\n`);
      } catch {
        connectionManager.removeClient(connId);
      }
    }, config.keepaliveIntervalMs);

    connectionManager.addClient({
      id: connId,
      userId: ctx.user_id,
      orgId: ctx.org_id,
      tenantId: ctx.tenant_id,
      role: ctx.role,
      rank,
      reply,
      keepaliveTimer,
    });

    request.log.info({ connId, userId: ctx.user_id, orgId: ctx.org_id, role: ctx.role }, 'SSE client connected');

    request.raw.on('close', () => {
      connectionManager.removeClient(connId);
      request.log.info({ connId }, 'SSE client disconnected');
    });
  });
}
