import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// The security property under test is the one that cannot be caught by reading
// the code six months from now: user/org/tenant come from the gateway-injected
// headers, and a body field named `user_id` is INERT. If that ever regresses,
// any authenticated caller can register their own handset as somebody else's
// device and receive that person's lead notifications on a locked phone.

// vi.mock is hoisted above the imports, so its factory cannot close over
// ordinary consts declared below. vi.hoisted lifts these with it.
//
// The env assignment rides along for the same reason: lib/auth-context.ts reads
// INTERNAL_SERVICE_SECRET at module scope, so it must be set before the import
// below is evaluated — set it afterwards and every request 401s.
const { saveSubscription, deleteSubscription, vapidPublicKey } = vi.hoisted(() => {
  process.env['INTERNAL_SERVICE_SECRET'] = 'test-secret';
  return {
    saveSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    vapidPublicKey: vi.fn(() => 'PUB-KEY-XYZ'),
  };
});

vi.mock('@platform/web-push', () => ({ saveSubscription, deleteSubscription, vapidPublicKey }));

import { pushRoutes } from '../push.js';

const HEADERS = {
  'x-internal-secret': 'test-secret',
  'x-org-id': 'org-real',
  'x-user-id': 'user-real',
  'x-platform-role': 'sales_rep',
  'x-tenant-id': 'tenant-real',
};

const SUBSCRIPTION = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) },
};

async function buildApp() {
  const app = Fastify();
  await app.register(pushRoutes, { prefix: '/api/v1' });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveSubscription.mockResolvedValue(undefined);
  deleteSubscription.mockResolvedValue(0);
  vapidPublicKey.mockReturnValue('PUB-KEY-XYZ');
});

describe('POST /notifications/push/subscribe', () => {
  it('ignores a forged user_id/org_id/tenant_id in the body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/push/subscribe',
      headers: HEADERS,
      payload: { ...SUBSCRIPTION, user_id: 'ATTACKER', org_id: 'other-org', tenant_id: 'other-tenant' },
    });

    expect(res.statusCode).toBe(201);
    expect(saveSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-real', orgId: 'org-real', tenantId: 'tenant-real' }),
    );
    // Zod strips the unknown keys, so nothing forged survives into the row.
    const [input] = saveSubscription.mock.calls[0] as [{ subscription: Record<string, unknown> }];
    expect(Object.keys(input.subscription).sort()).toEqual(['endpoint', 'keys']);
    await app.close();
  });

  it('rejects a request without the internal secret', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/push/subscribe',
      headers: { ...HEADERS, 'x-internal-secret': 'wrong' },
      payload: SUBSCRIPTION,
    });

    expect(res.statusCode).toBe(401);
    expect(saveSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a malformed subscription with 422', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/push/subscribe',
      headers: HEADERS,
      payload: { endpoint: 'not-a-url' },
    });

    expect(res.statusCode).toBe(422);
    expect(saveSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a tenant-less session rather than casting an empty string to uuid', async () => {
    const app = await buildApp();
    const { 'x-tenant-id': _drop, ...noTenant } = HEADERS;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/push/subscribe',
      headers: noTenant,
      payload: SUBSCRIPTION,
    });

    expect(res.statusCode).toBe(401);
    expect(saveSubscription).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('DELETE /notifications/push/subscribe', () => {
  it('scopes the delete to the acting user and org', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications/push/subscribe',
      headers: HEADERS,
      payload: { endpoint: SUBSCRIPTION.endpoint },
    });

    expect(res.statusCode).toBe(204);
    expect(deleteSubscription).toHaveBeenCalledWith(SUBSCRIPTION.endpoint, {
      userId: 'user-real',
      orgId: 'org-real',
    });
    await app.close();
  });

  it('accepts the endpoint from the query string when no body is attached', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notifications/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`,
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(204);
    expect(deleteSubscription).toHaveBeenCalledWith(SUBSCRIPTION.endpoint, expect.anything());
    await app.close();
  });
});

describe('GET /notifications/push/public-key', () => {
  it('returns the VAPID public key', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/push/public-key',
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { public_key: 'PUB-KEY-XYZ' } });
    await app.close();
  });

  it('requires auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/push/public-key' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
