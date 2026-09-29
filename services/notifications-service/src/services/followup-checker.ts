import type { FastifyBaseLogger } from 'fastify';
import { serviceDb } from '@platform/db';
import * as webPush from '@platform/web-push';
import { connectionManager } from '../connections/manager.js';
import { config } from '../config/index.js';

interface FollowUpLead {
  id: string;
  assigned_user_id: string;
  scheduled_at: string;
  org_id: string;
  tenant_id: string;
  lead_name: string;
}

type Logger = Pick<FastifyBaseLogger, 'info' | 'debug' | 'warn' | 'error'>;

const noopLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

let log: Logger = noopLogger;

/** Wire in the Fastify logger at startup, replacing the previous console.* use. */
export function setFollowUpCheckerLogger(logger: Logger): void {
  log = logger;
}

// lms.marketing_leads.scheduled_at is the single source of truth for a lead's next follow-up
// due time (kept in sync on every create/reschedule/complete). This poller only ever reads it —
// overdue vs. due-soon is a pure comparison against NOW(), never a row mutation.
//
// This is a NOTIFICATION path only. The follow-ups grid and pipeline are served
// by leads-service (/follow-ups, /leads/:id/follow-ups) and are unaffected by
// anything here — including the lookback bound below, which limits how far back
// a PUSH notification is worth sending, not what the UI can display.
//
// KNOWN LIMITATION (accepted, not a bug to fix in passing): these sets live in
// process memory and are lost on restart, so a mid-morning deploy can re-notify
// the day's follow-ups once. Now that push is wired in, that means one extra
// buzz per affected lead, not just a duplicate toast. Moving the sets to a
// table is the remedy if it ever becomes a complaint; until then the cost of a
// rare duplicate is lower than the cost of the extra write path.
const notifiedDueKeys = new Set<string>();
const notifiedMissedKeys = new Set<string>();
let lastResetDate = '';

/**
 * Today's date in the configured zone, as YYYY-MM-DD.
 *
 * `toISOString()` would give UTC, so the daily dedupe reset fired at 05:30 IST
 * for an India-based tenant — mid working morning, re-notifying everything that
 * had already been dismissed. `en-CA` is used purely because it formats as
 * YYYY-MM-DD.
 */
function localDateKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.followupResetTimeZone });
}

function resetIfNewDay(): void {
  const today = localDateKey();
  if (today !== lastResetDate) {
    notifiedDueKeys.clear();
    notifiedMissedKeys.clear();
    lastResetDate = today;
  }
}

async function checkFollowUps(): Promise<void> {
  resetIfNewDay();

  // Kept for the debug line at the bottom only. This used to be
  // `if (clientCount === 0) return;`, which short-circuited the entire check
  // whenever nobody held an open SSE stream — precisely the situation Web Push
  // exists to serve. It made push work in dev, where a browser tab is always
  // open, and do nothing on a closed phone. Do not reinstate it.
  const clientCount = connectionManager.getClientCount();

  const db = serviceDb();
  const rows = (await db`
    SELECT
      ml.id,
      ml.assigned_user_id,
      ml.scheduled_at,
      ml.org_id,
      COALESCE(o.tenant_id::text, '') AS tenant_id,
      COALESCE(ml.full_name, ml.first_name || ' ' || ml.last_name, 'Unknown') AS lead_name
    FROM lms.marketing_leads ml
    JOIN lms.lead_stage lstg ON lstg.id = ml.stage_id
    JOIN entity.organizations o ON o.id = ml.org_id
    WHERE lstg.followup_required
      AND ml.scheduled_at IS NOT NULL
      AND ml.scheduled_at <= NOW() + make_interval(mins => ${config.followupLookaheadMinutes})
      -- Lower bound. Without it this set was every lead ever scheduled and never
      -- completed: a set that only grows, re-scanned on every tick.
      AND ml.scheduled_at >= NOW() - make_interval(mins => ${config.followupLookbackMinutes})
      AND ml.assigned_user_id IS NOT NULL
      AND ml.is_deleted = false
    -- Most overdue first, so a backlog past the cap still surfaces the items
    -- that have been waiting longest rather than an arbitrary slice.
    ORDER BY ml.scheduled_at
    LIMIT ${config.followupMaxRowsPerTick}
  ` as unknown as FollowUpLead[]);

  let notified = 0;
  let deduped = 0;
  let offline = 0;
  let pushed = 0;
  let pruned = 0;

  for (const row of rows) {
    const scheduledIso = new Date(row.scheduled_at).toISOString();
    const key = `${row.id}:${scheduledIso}`;
    const isOverdue = new Date(row.scheduled_at).getTime() < Date.now();
    const seen = isOverdue ? notifiedMissedKeys : notifiedDueKeys;
    if (seen.has(key)) {
      deduped += 1;
      continue;
    }

    const eventType = isOverdue ? 'followup:missed' : 'followup:due';
    const message = isOverdue
      ? `Follow-up overdue for ${row.lead_name}`
      : `Follow-up due for ${row.lead_name}`;

    // Scoped to the lead's own org: a user mapped to several branches should not
    // get a branch-B follow-up pushed onto a session opened in branch A.
    const sent = connectionManager.sendToUser(
      row.assigned_user_id,
      eventType,
      { lead_id: row.id, message, scheduled_at: row.scheduled_at },
      row.org_id,
    );

    // Web Push, additive to the SSE above — never a replacement for it. SSE
    // stays the in-app channel for open tabs; push covers closed ones. A user
    // with the tab open may get both, which is correct: the service worker
    // tags the notification per lead so they do not stack up.
    //
    // org_id is passed for the same reason it is passed to sendToUser above,
    // and @platform/web-push filters registrations on it: a rep mapped to
    // several branches must not have a branch-B follow-up land on a handset
    // registered in branch A.
    try {
      const result = await webPush.sendToUser(row.assigned_user_id, row.org_id, {
        title: isOverdue ? 'Follow-up overdue' : 'Follow-up due',
        body: message,
        // Deep link to the lead itself. There is still no per-lead ROUTE —
        // `/dashboard/leads` has no `[id]` segment, so `/lms/dashboard/leads/<id>`
        // would open a 404 on the user's phone. Instead the follow-ups grid
        // takes `?leadId=` and opens that lead's history on arrival (see
        // FollowUpsShell's `focusLeadId`), which is what makes "tapping the
        // notification opens that lead" actually true.
        //
        // The id is a hint, not an authorization: the grid matches it against
        // the follow-ups the API already scoped to this actor and ignores
        // anything else, so the URL cannot be used to pull a foreign lead.
        url: `/lms/dashboard/follow-ups?leadId=${row.id}`,
        leadId: row.id,
      });
      pushed += result.sent;
      pruned += result.pruned;
    } catch (err) {
      // sendToUser already swallows and logs its own failures, so this is a
      // belt-and-braces guard against an unexpected throw (a bad payload, a
      // pool error). One user's dead handset must not abort the loop and
      // starve every later row in the tick.
      log.warn({ err, leadId: row.id, userId: row.assigned_user_id }, 'push notification failed');
    }

    // Recorded whether or not the user was reachable. This was previously
    // `if (sent)`, so a row whose owner happened to be offline was never marked
    // seen and was reprocessed on EVERY subsequent tick — the dedupe set only
    // ever suppressed work for users who were already connected. A missed push
    // is recovered from the follow-ups grid on next load, which is the right
    // fallback for a transient notification.
    //
    // This applies to push identically, and is what stops a phone buzzing on
    // every tick: the key is recorded once per lead+schedule per local day, so
    // both channels fire at most once for it.
    seen.add(key);
    if (sent) notified += 1;
    else offline += 1;
  }

  // Surfaced explicitly: if this fires persistently the backlog is outgrowing
  // the poller, and the interval or the cap needs revisiting.
  if (rows.length >= config.followupMaxRowsPerTick) {
    log.warn(
      { rows: rows.length, cap: config.followupMaxRowsPerTick },
      'follow-up checker hit its per-tick row cap; older due follow-ups deferred to the next tick',
    );
  }

  log.debug(
    { rows: rows.length, clients: clientCount, notified, deduped, offline, pushed, pruned },
    'follow-up check complete',
  );
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
// Guards against overlapping runs. setInterval does not wait for an async
// callback, so a check slower than the interval would previously start again on
// top of itself — multiplying DB load exactly when the DB was already the reason
// it was slow.
let running = false;

async function runGuarded(): Promise<void> {
  if (running) {
    log.warn('follow-up check still running when the next tick fired; skipping this one');
    return;
  }
  running = true;
  try {
    await checkFollowUps();
  } catch (err) {
    log.error({ err }, 'follow-up check failed');
  } finally {
    running = false;
  }
}

export function startFollowUpChecker(): void {
  void runGuarded();
  intervalHandle = setInterval(() => void runGuarded(), config.followupCheckIntervalMs);
}

// ── Test seams ─────────────────────────────────────────────────────────────
// Exported for src/services/__tests__/followup-checker.test.ts only. The two
// behaviours worth pinning are that a due follow-up pushes with NO SSE client
// connected, and that the next tick does not re-notify — neither is reachable
// through startFollowUpChecker without a timer and a live pool.

/** Run one tick synchronously. */
export async function checkFollowUpsForTest(): Promise<void> {
  return checkFollowUps();
}

/** Forget everything the dedupe sets have seen. */
export function resetDedupeForTest(): void {
  notifiedDueKeys.clear();
  notifiedMissedKeys.clear();
  lastResetDate = localDateKey();
}

export function stopFollowUpChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
