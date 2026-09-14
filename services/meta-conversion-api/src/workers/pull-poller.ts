import { sql } from 'drizzle-orm';
import { withServiceTx, withTenantConfigTx } from '@platform/db';
import { config } from '../config/index.js';
import { runPull, type PullRunRow, type PullCounts } from '../services/lead-pull.service.js';
import { applyRun, type ClaimedApplyRun } from '../services/lead-apply.service.js';
import type { LeadSyncLogger } from '../services/lead-sync.service.js';

// ── The lead-pull worker ────────────────────────────────────────────────────
//
// There is NO job/queue infrastructure in this repo — no bullmq, pg-boss,
// agenda, node-cron, Redis or worker process (verified). The only background
// pattern that exists is notifications-service's followup-checker: a
// setInterval poller with a `running` boolean overlap guard. This follows it
// rather than inventing infrastructure for one feature.
//
// The run ROW is the queue. POST /meta/lead-pull/runs inserts 'queued' and
// returns run_id in one fast transaction, so nothing rides on the gateway
// timeout, and this poller claims the work.
//
// TWO GUARDS, AND BOTH ARE NEEDED:
//   * `running` stops a tick starting on top of a slow one. A pull that
//     outlasts the interval would otherwise multiply DB and Graph load exactly
//     when load is already the reason it is slow — followup-checker's own
//     comment, and it applies with more force here because the load lands on
//     Meta's rate limiter, not just on Postgres.
//   * FOR UPDATE SKIP LOCKED is the one that survives a SECOND REPLICA, which
//     the boolean cannot: it lives in one process's memory. Compose runs a
//     single instance today, so SKIP LOCKED buys nothing right now — it buys
//     that scaling this service later does not silently double-run every pull.
//
// THE REAPER IS NOT OPTIONAL. It is the whole reason for a claimed queue rather
// than a floating `void doPull()` promise. POST /runs refuses with 409 while a
// run is queued/running/applying, so a deploy landing mid-pull would strand the
// run in 'running' forever and that tenant could NEVER start another one. The
// reaper is what turns "the process died" into a failed run somebody can retry.

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

let log: LeadSyncLogger & { error: (obj: Record<string, unknown>, msg?: string) => void } = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface ClaimedRunRow extends PullRunRow {
  status: string;
}

/**
 * Claims the oldest queued run, or returns null.
 *
 * RUNS ON withServiceTx (BYPASSRLS) — a documented system operation, and the
 * one place in this feature where that is unavoidable. The claim is CROSS-
 * TENANT by nature: the poller cannot pin `app.current_tenant_id` before
 * reading, because which tenant's run is next is precisely what it is asking.
 * Everything the claim leads to — loading the mappings, staging the leads,
 * writing the heartbeat and the final counts — runs under `withTenantConfigTx`
 * pinned to the tenant named on the claimed row, so scratch.meta_pull_*'s
 * admin_tenant_config_policy is what fences every row this worker writes.
 */
async function claimQueuedRun(): Promise<ClaimedRunRow | null> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      WITH candidate AS (
        SELECT id FROM scratch.meta_pull_runs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE scratch.meta_pull_runs r
      SET status       = 'running',
          started_at   = NOW(),
          heartbeat_at = NOW(),
          updated_at   = NOW()
      FROM candidate c
      WHERE r.id = c.id
      RETURNING r.id, r.tenant_id, r.created_by, r.filters, r.status
    `)) as unknown as ClaimedRunRow[];
    return rows[0] ?? null;
  });
}

/**
 * Claims the oldest queued APPLY, or returns null.
 *
 * Same shape and same justification as claimQueuedRun: cross-tenant by nature,
 * so withServiceTx, and everything the claim leads to (applyRun) runs under
 * withTenantConfigTx pinned to the tenant on the claimed row. The actor is the
 * user who pressed Apply, falling back to the run's creator when that account
 * has since been removed (applied_by is ON DELETE SET NULL).
 */
async function claimQueuedApply(): Promise<ClaimedApplyRun | null> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      WITH candidate AS (
        SELECT id FROM scratch.meta_pull_runs
        WHERE status = 'apply_queued'
        ORDER BY updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE scratch.meta_pull_runs r
      SET status       = 'applying',
          heartbeat_at = NOW(),
          updated_at   = NOW()
      FROM candidate c
      WHERE r.id = c.id
      RETURNING r.id, r.tenant_id, COALESCE(r.applied_by, r.created_by) AS applied_by
    `)) as unknown as ClaimedApplyRun[];
    return rows[0] ?? null;
  });
}

/**
 * Recovers every claimed run whose heartbeat has gone stale.
 *
 * A stalled PULL is failed: its staged rows are partial and the only remedy is
 * a new pull. A stalled APPLY goes back to `completed` instead: every row it
 * applied is recorded on the row and the rest are still `pending`, so pressing
 * Apply again carries on — failing it would strand those rows, because a failed
 * run can never be applied.
 *
 * Cross-tenant by nature, for the same reason as the claim: a stranded run
 * could belong to any tenant. `heartbeat_at IS NULL` is included because a
 * process that dies between the claim and its first page would otherwise never
 * be reaped — the claim sets it, but a clock skew or a failed update should not
 * be the difference between recoverable and permanently stuck.
 *
 * Every CASE below reads the row's OLD status: Postgres evaluates all SET
 * expressions against the pre-update row.
 */
async function reapStaleRuns(): Promise<number> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE scratch.meta_pull_runs
      SET status      = CASE WHEN status = 'applying' THEN 'completed' ELSE 'failed' END,
          error_text  = CASE
            WHEN status = 'applying' THEN
              'Apply was interrupted: no heartbeat for ' || ${config.leadPullStaleRunMinutes}::text
                || ' minutes (most likely a restart or redeploy). Rows already applied are kept — '
                || 'press Apply again to continue with the rest.'
            ELSE COALESCE(
              error_text,
              'Run abandoned: no heartbeat for ' || ${config.leadPullStaleRunMinutes}::text
                || ' minutes. The service was most likely restarted or redeployed mid-run. '
                || 'Start a new pull — nothing was written to LMS unless Apply had already run.'
            )
          END,
          finished_at = CASE WHEN status = 'applying' THEN finished_at ELSE COALESCE(finished_at, NOW()) END,
          updated_at  = NOW()
      WHERE status IN ('running', 'applying')
        AND COALESCE(heartbeat_at, started_at, created_at)
            < NOW() - make_interval(mins => ${config.leadPullStaleRunMinutes}::int)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  });
}

async function writeHeartbeat(run: PullRunRow): Promise<void> {
  await withTenantConfigTx({ actorUserId: run.created_by, tenantId: run.tenant_id }, (tx) =>
    tx.execute(sql`
      UPDATE scratch.meta_pull_runs
      SET heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = ${run.id}::uuid
    `),
  );
}

async function finishRun(run: PullRunRow, counts: PullCounts): Promise<void> {
  await withTenantConfigTx({ actorUserId: run.created_by, tenantId: run.tenant_id }, (tx) =>
    tx.execute(sql`
      UPDATE scratch.meta_pull_runs
      SET status       = 'completed',
          counts       = ${JSON.stringify(counts)}::jsonb,
          finished_at  = NOW(),
          heartbeat_at = NOW(),
          updated_at   = NOW()
      WHERE id = ${run.id}::uuid
        -- Only while this worker still owns it: a run the reaper has already
        -- failed must not be flipped back to completed over its reason.
        AND status = 'running'
    `),
  );
}

async function failRun(run: PullRunRow, message: string): Promise<void> {
  await withTenantConfigTx({ actorUserId: run.created_by, tenantId: run.tenant_id }, (tx) =>
    tx.execute(sql`
      UPDATE scratch.meta_pull_runs
      SET status      = 'failed',
          error_text  = ${message},
          finished_at = NOW(),
          updated_at  = NOW()
      WHERE id = ${run.id}::uuid
        AND status = 'running'
    `),
  );
}

/**
 * Runs one queued Apply. Serialised with pulls by the same `running` guard: on
 * a single instance an Apply briefly holds the worker, which is the same
 * trade-off pulls already make with each other and keeps both off Meta's and
 * leads-service's backs at once.
 */
async function runQueuedApply(): Promise<boolean> {
  const apply = await claimQueuedApply();
  if (!apply) return false;

  log.info(
    { evt: 'lead_pull.apply_claimed', runId: apply.id, tenantId: apply.tenant_id },
    'Claimed a Meta lead pull Apply',
  );

  try {
    const result = await applyRun(apply, { log });
    log.info(
      {
        evt: 'lead_pull.applied',
        runId: apply.id,
        tenantId: apply.tenant_id,
        attempted: result.attempted,
        applied: result.applied,
        alreadySynced: result.already_synced,
        skipped: result.skipped,
        failed: result.failed,
      },
      'Meta lead pull applied',
    );
  } catch (err) {
    // applyRun has already returned the run to `completed` with the reason.
    log.error({ evt: 'lead_pull.apply_failed', err, runId: apply.id, tenantId: apply.tenant_id }, 'Meta lead pull Apply failed');
  }
  return true;
}

async function tick(): Promise<void> {
  const reaped = await reapStaleRuns();
  if (reaped > 0) {
    log.warn({ evt: 'lead_pull.runs_reaped', count: reaped }, 'Failed pull runs with a stale heartbeat');
  }

  const run = await claimQueuedRun();
  if (!run) {
    // No pull waiting — take a queued Apply instead. Pulls go first because a
    // pull is what an admin is watching a spinner for; an Apply already has its
    // staged rows and loses nothing by starting a tick later.
    await runQueuedApply();
    return;
  }

  log.info(
    { evt: 'lead_pull.claimed', runId: run.id, tenantId: run.tenant_id },
    'Claimed a Meta lead pull run',
  );

  try {
    const counts = await runPull(run, {
      log,
      onPageComplete: () => writeHeartbeat(run),
    });
    await finishRun(run, counts);
    log.info(
      {
        evt: 'lead_pull.completed',
        runId: run.id,
        tenantId: run.tenant_id,
        pagesWalked: counts.pages_walked,
        formsWalked: counts.forms_walked,
        leadsStaged: counts.leads_staged,
        truncated: counts.truncated,
        pageErrors: counts.page_errors.length,
      },
      'Meta lead pull completed',
    );
  } catch (err) {
    // The run must never be left in 'running' — POST /runs' 409 guard would
    // lock this tenant out until the reaper caught up, for a failure we already
    // know about right now.
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ evt: 'lead_pull.failed', err, runId: run.id, tenantId: run.tenant_id }, 'Meta lead pull failed');
    await failRun(run, message).catch(() => undefined);
  }
}

/** Copied verbatim from followup-checker's runGuarded — see the header. */
async function runGuarded(): Promise<void> {
  if (running) {
    log.warn({ evt: 'lead_pull.tick_skipped' }, 'Lead pull still running when the next tick fired; skipping this one');
    return;
  }
  running = true;
  try {
    await tick();
  } catch (err) {
    log.error({ evt: 'lead_pull.tick_failed', err }, 'Lead pull tick failed');
  } finally {
    running = false;
  }
}

export function startLeadPullPoller(logger: typeof log): void {
  log = logger;
  void runGuarded();
  intervalHandle = setInterval(() => void runGuarded(), config.leadPullPollIntervalMs);
}

export function stopLeadPullPoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
