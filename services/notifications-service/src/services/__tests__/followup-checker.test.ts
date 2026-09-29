import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two properties this file exists to protect:
//
//  1. A due follow-up pushes even when NOBODY holds an open SSE stream. The
//     poller used to `return` early on clientCount === 0, which made push work
//     in dev (where a tab is always open) and do nothing on a closed phone —
//     the exact situation push exists for.
//  2. The next tick does NOT re-notify. The per-lead+schedule dedupe set is
//     what stops a phone buzzing every FOLLOWUP_CHECK_INTERVAL_MS. It is now
//     load-bearing for a physical device, not just an in-app toast.

const { rows, sendToUser, sseSendToUser, getClientCount } = vi.hoisted(() => {
  process.env['DATABASE_URL'] = 'postgres://stub';
  process.env['DATABASE_URL_SERVICE'] = 'postgres://stub';
  process.env['FOLLOWUP_CHECK_INTERVAL_MS'] = '60000';
  process.env['FOLLOWUP_LOOKAHEAD_MINUTES'] = '15';
  return {
    rows: { current: [] as unknown[] },
    sendToUser: vi.fn(),
    sseSendToUser: vi.fn(),
    getClientCount: vi.fn(),
  };
});

vi.mock('@platform/db', () => ({
  // The poller uses serviceDb() as a tagged template — invoking it returns the
  // queued rows regardless of the SQL text.
  serviceDb: () => (async () => rows.current) as unknown,
}));

vi.mock('@platform/web-push', () => ({ sendToUser }));

vi.mock('../../connections/manager.js', () => ({
  connectionManager: { getClientCount, sendToUser: sseSendToUser },
}));

import { checkFollowUpsForTest, resetDedupeForTest } from '../followup-checker.js';

const LEAD = {
  id: 'lead-1',
  assigned_user_id: 'user-1',
  // Two minutes out: due-soon, not overdue.
  scheduled_at: new Date(Date.now() + 2 * 60_000).toISOString(),
  org_id: 'org-a',
  tenant_id: 'tenant-1',
  lead_name: 'Asha',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetDedupeForTest();
  rows.current = [LEAD];
  getClientCount.mockReturnValue(0);
  sseSendToUser.mockReturnValue(false);
  sendToUser.mockResolvedValue({ sent: 1, pruned: 0 });
});

describe('checkFollowUps', () => {
  it('pushes with NO SSE client connected', async () => {
    await checkFollowUpsForTest();

    expect(sendToUser).toHaveBeenCalledOnce();
    const [userId, orgId, payload] = sendToUser.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(userId).toBe('user-1');
    expect(orgId).toBe('org-a');
    expect(payload['title']).toBe('Follow-up due');
    expect(payload['leadId']).toBe('lead-1');
  });

  it('does not re-notify on the next tick', async () => {
    await checkFollowUpsForTest();
    await checkFollowUpsForTest();
    await checkFollowUpsForTest();

    expect(sendToUser).toHaveBeenCalledOnce();
    expect(sseSendToUser).toHaveBeenCalledOnce();
  });

  it('passes the lead org, so a branch-B lead cannot target a branch-A registration', async () => {
    rows.current = [{ ...LEAD, org_id: 'org-b' }];

    await checkFollowUpsForTest();

    expect(sendToUser).toHaveBeenCalledWith('user-1', 'org-b', expect.anything());
  });

  it('still delivers SSE, and still processes later rows, when a push throws', async () => {
    rows.current = [LEAD, { ...LEAD, id: 'lead-2', lead_name: 'Bina' }];
    sendToUser.mockRejectedValueOnce(new Error('push service exploded'));

    await checkFollowUpsForTest();

    expect(sseSendToUser).toHaveBeenCalledTimes(2);
    expect(sendToUser).toHaveBeenCalledTimes(2);
  });

  it('keeps SSE delivery alongside push for a connected user', async () => {
    getClientCount.mockReturnValue(1);
    sseSendToUser.mockReturnValue(true);

    await checkFollowUpsForTest();

    expect(sseSendToUser).toHaveBeenCalledOnce();
    expect(sendToUser).toHaveBeenCalledOnce();
  });

  it('marks an overdue follow-up as overdue', async () => {
    rows.current = [{ ...LEAD, scheduled_at: new Date(Date.now() - 60_000).toISOString() }];

    await checkFollowUpsForTest();

    const [, , payload] = sendToUser.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(payload['title']).toBe('Follow-up overdue');
  });

  it('deep-links to a route that exists under the /lms basePath', async () => {
    await checkFollowUpsForTest();

    const [, , payload] = sendToUser.mock.calls[0] as [string, string, Record<string, unknown>];
    // lms-web still has no per-lead detail ROUTE; /lms/dashboard/leads/<id>
    // would 404 on the user's phone. The follow-ups grid takes `?leadId=`
    // instead and opens that lead on arrival, so the notification lands on the
    // lead it is about rather than an undifferentiated list.
    expect(payload['url']).toBe('/lms/dashboard/follow-ups?leadId=lead-1');
  });
});
