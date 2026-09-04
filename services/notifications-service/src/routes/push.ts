import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  saveSubscription,
  deleteSubscription,
  vapidPublicKey,
} from '@platform/web-push';
import { parseAuthContext } from '../lib/auth-context.js';

// Web Push device registration.
//
// ── Why these routes are NOT capability-gated ──────────────────────────────
// `.claude/CLAUDE.md` requires new code to go through capabilities. This is a
// deliberate, documented exception, matching how the gateway already treats the
// whole `/notifications` prefix in
// `msq-core/services/api-gateway/src/lib/product-map.ts` as ungated platform/
// shared surface.
//
// Registering your own device to receive your own notifications is self-service
// — the same category as `/users/me/photo`. The routes ARE authenticated:
// identity comes from the gateway-injected, HMAC-verified headers via
// `parseAuthContext`, exactly as `routes/stream.ts` does it. But there is no
// capability that could meaningfully gate "may this user be told about their
// own work" — gating it would only mean some users silently stop receiving
// alerts about leads they already own.
//
// ── Why the body is never trusted for identity ────────────────────────────
// The body carries the browser's `PushSubscription` (endpoint + keys) and
// NOTHING else. user/org/tenant come from `parseAuthContext`. A body field
// named `user_id` is ignored, not honoured: accepting one would let any
// authenticated caller register their handset as somebody else's device and
// receive that person's lead notifications on a locked phone.

// The `PushSubscription` shape the browser produces (`subscription.toJSON()`).
// Unknown keys are stripped by Zod, so a client that also posts a `user_id`
// cannot smuggle it past this point.
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.post('/notifications/push/subscribe', async (request, reply) => {
    const ctx = parseAuthContext(request, reply);
    if (!ctx) return;

    const parsed = subscriptionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        success: false,
        error: 'Invalid push subscription',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // parseAuthContext defaults tenant_id to '' when the gateway omits the
    // header (proxy.ts only sets X-Tenant-Id when userCtx.tenant_id is truthy),
    // and notify.push_subscriptions.tenant_id is NOT NULL uuid. Reject that
    // explicitly rather than letting an `invalid input syntax for type uuid`
    // surface as a 500. Not a client-fixable input, hence 401: the session
    // itself is not scoped to a tenant.
    if (!ctx.tenant_id) {
      return reply.status(401).send({ success: false, error: 'Session is not tenant-scoped' });
    }

    // Every id here is server-derived. Nothing from `request.body` reaches them.
    await saveSubscription({
      userId: ctx.user_id,
      orgId: ctx.org_id,
      tenantId: ctx.tenant_id,
      subscription: parsed.data,
      userAgent: (request.headers['user-agent'] as string | undefined)?.slice(0, 500),
    });

    request.log.info(
      { userId: ctx.user_id, orgId: ctx.org_id },
      'push subscription registered',
    );

    return reply.status(201).send({ success: true, data: { registered: true } });
  });

  app.delete('/notifications/push/subscribe', async (request, reply) => {
    const ctx = parseAuthContext(request, reply);
    if (!ctx) return;

    // The gateway forwards the DELETE body; the query string is accepted as a
    // fallback for clients (and `navigator.sendBeacon` paths on logout) that
    // cannot attach one.
    const source =
      request.body && Object.keys(request.body as object).length > 0
        ? request.body
        : request.query;

    const parsed = unsubscribeSchema.safeParse(source);
    if (!parsed.success) {
      return reply.status(422).send({
        success: false,
        error: 'Invalid endpoint',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Scoped to the acting user and org. An endpoint is opaque, but it is not a
    // secret we rely on: without this scope a caller holding somebody else's
    // endpoint could silence their notifications. A foreign endpoint deletes
    // nothing and still returns 204 — no existence oracle.
    const removed = await deleteSubscription(parsed.data.endpoint, {
      userId: ctx.user_id,
      orgId: ctx.org_id,
    });

    request.log.info({ userId: ctx.user_id, orgId: ctx.org_id, removed }, 'push subscription removed');

    return reply.status(204).send();
  });

  app.get('/notifications/push/public-key', async (request, reply) => {
    const ctx = parseAuthContext(request, reply);
    if (!ctx) return;

    return reply.send({ success: true, data: { public_key: vapidPublicKey() } });
  });
}
