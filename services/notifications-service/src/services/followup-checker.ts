import type { FastifyBaseLogger } from 'fastify';
import { serviceDb } from '@platform/db';
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

  const clientCount = connectionManager.getClientCount();
  if (clientCount === 0) return;

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

    // Recorded whether or not the user was reachable. This was previously
    // `if (sent)`, so a row whose owner happened to be offline was never marked
    // seen and was reprocessed on EVERY subsequent tick — the dedupe set only
    // ever suppressed work for users who were already connected. A missed push
    // is recovered from the follow-ups grid on next load, which is the right
    // fallback for a transient notification.
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
    { rows: rows.length, clients: clientCount, notified, deduped, offline },
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

export function stopFollowUpChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
