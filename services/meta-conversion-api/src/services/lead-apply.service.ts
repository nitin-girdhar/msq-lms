import { sql } from 'drizzle-orm';
import { withTenantConfigTx, sqlTextArr, type DrizzleTx } from '@platform/db';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { assertTenantExists } from '../lib/admin-tenant.js';
import { getIntegrationByTenantId } from './integration.service.js';
import { IMPORTABLE_VERDICTS } from './lead-reconcile.service.js';
import {
  syncLeadToDatabase,
  isMetaTestLead,
  type MetaLeadFieldData,
  type MetaLeadPlatform,
  type RawMetaLead,
  type LeadSyncLogger,
} from './lead-sync.service.js';
import type { AdminTenantScope } from './page-org-map.admin.service.js';

// ── Apply: staged rows → real leads, through the CANONICAL write path ───────
//
// This module writes NO leads itself. It calls `syncLeadToDatabase` once per
// importable staged row — the same function the live webhook calls — and that
// choice is what buys almost everything this feature is required to guarantee:
//
//   * IDEMPOTENCY comes for free. syncLeadToDatabase re-checks
//     ext.meta_leads.meta_lead_id before doing anything AND again inside its
//     transaction for concurrent retries. That IS the "check if not exists,
//     then insert" requirement, and crucially it runs AT APPLY TIME AGAINST
//     LIVE DATA rather than against a staging snapshot that may be hours old —
//     the same reasoning as import_downloaded_leads.py, which re-classifies
//     instead of trusting its own dump. Pressing Apply twice inserts nothing
//     the second time: every row comes back isDuplicate.
//
//   * CAMPAIGN TYPING AND POOL ROUTING apply automatically, because that
//     function delegates lms.marketing_leads creation to leads-service's
//     intake endpoint. A lead applied through this screen is routed exactly
//     like one that arrived on the webhook.
//
//   * Every ext.meta_lead_* child table is written.
//
// FOUR THINGS ABOUT THAT FUNCTION BITE, and each is handled explicitly below:
//   1. it takes (orgId, lead, orgFieldMappings?) and NO tenant_id — the tenant
//      travels in syncContext instead;
//   2. it THROWS on a missing phone and on a non-numeric lead id, so every call
//      is wrapped per row and a failure is recorded rather than aborting the
//      batch;
//   3. isMetaTestLead is exported but NOT called inside it — the caller must
//      apply it, which is how 20 test leads reached production through the
//      Python path;
//   4. its intake call sits BETWEEN the pre-check and the in-transaction
//      re-check, so a race can leave an orphan lms.marketing_leads row. This
//      module does not make that worse: rows are applied SEQUENTIALLY, and the
//      run-level SKIP LOCKED claim means there is only ever one applier.

export interface ApplyResult {
  /** Importable rows this pass attempted. */
  attempted: number;
  /** New leads created. */
  applied: number;
  /** syncLeadToDatabase reported the Meta lead was already synced. */
  already_synced: number;
  /** Not importable: unmapped form, or a test lead the verdict missed. */
  skipped: number;
  /** Threw. The row carries the message; the batch carried on. */
  failed: number;
}

/** A run the poller has moved `apply_queued` → `applying` and now owns. */
export interface ClaimedApplyRun {
  id: string;
  tenant_id: string;
  /** Who pressed Apply — stamped when it was queued; the run's creator if that user is gone. */
  applied_by: string;
}

interface StagedRowForApply {
  id: string;
  org_id: string | null;
  meta_lead_id: string;
  page_id: string | null;
  form_id: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  platform: MetaLeadPlatform | null;
  lead_created_at: string | null;
  raw_field_data: MetaLeadFieldData[] | null;
}

export interface QueuedApply {
  run_id: string;
  status: 'apply_queued';
}

/**
 * Queues a completed run for Apply, or refuses. Returns at once.
 *
 * APPLY IS NOT DONE IN THE REQUEST. It makes one leads-service intake call per
 * importable row, and the gateway abandons a proxied request after 30s — so an
 * inline Apply of any real size answered 504 while the server kept writing, the
 * UI re-enabled the button, and a second press got 409 'applying'. The work now
 * runs on the same claimed queue as the pull itself (workers/pull-poller.ts),
 * with the same heartbeat and reaper, and the screen polls GET /runs/:id.
 *
 * `FOR UPDATE SKIP LOCKED` plus the status predicate is still the double-click
 * guard: a second press finds the row locked or no longer `completed`, matches
 * nothing, and is answered 409 — rather than queueing the same rows twice.
 *
 * A run belonging to another tenant is invisible under
 * admin_tenant_config_policy and is reported as "not found", which is the right
 * answer: distinguishing it would confirm the existence of another tenant's run.
 */
export async function queueApply(scope: AdminTenantScope, runId: string): Promise<QueuedApply> {
  return withTenantConfigTx(scope, async (tx) => {
    await assertTenantExists(tx, scope.tenantId);

    const claimed = (await tx.execute(sql`
      WITH candidate AS (
        SELECT id FROM scratch.meta_pull_runs
        WHERE id = ${runId}::uuid AND status = 'completed'
        FOR UPDATE SKIP LOCKED
      )
      UPDATE scratch.meta_pull_runs r
      SET status     = 'apply_queued',
          applied_by = ${scope.actorUserId}::uuid,
          -- A previous interrupted Apply left its reason here; this press starts
          -- a fresh attempt.
          error_text = NULL,
          updated_at = NOW()
      FROM candidate c
      WHERE r.id = c.id
      RETURNING r.id
    `)) as unknown as Array<{ id: string }>;

    if (claimed[0]) return { run_id: claimed[0].id, status: 'apply_queued' };

    // Nothing claimed. Say WHICH of the three reasons it was, because the remedy
    // differs: wait, re-pull, or check the id.
    const existing = (await tx.execute(sql`
      SELECT status FROM scratch.meta_pull_runs WHERE id = ${runId}::uuid LIMIT 1
    `)) as unknown as Array<{ status: string }>;

    if (!existing[0]) throw new NotFoundError('Pull run not found');
    if (existing[0].status === 'applied') {
      throw new ConflictError('This run has already been applied');
    }
    throw new ConflictError(
      `A run in status '${existing[0].status}' cannot be applied — only a completed run can`,
    );
  });
}

async function loadImportableRows(tx: DrizzleTx, runId: string): Promise<StagedRowForApply[]> {
  const rows = await tx.execute(sql`
    SELECT id,
           org_id,
           meta_lead_id::text    AS meta_lead_id,
           page_id::text         AS page_id,
           form_id::text         AS form_id,
           campaign_id::text     AS campaign_id,
           adset_id::text        AS adset_id,
           ad_id::text           AS ad_id,
           platform,
           lead_created_at,
           raw_field_data
    FROM scratch.meta_pull_leads
    WHERE run_id = ${runId}::uuid
      AND verdict = ANY(${sqlTextArr([...IMPORTABLE_VERDICTS])})
      AND applied_status = 'pending'
    ORDER BY lead_created_at NULLS LAST, id
  `);
  return rows as unknown as StagedRowForApply[];
}

async function recordOutcome(
  tx: DrizzleTx,
  rowId: string,
  status: 'applied' | 'skipped' | 'failed',
  leadId: string | null,
  error: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE scratch.meta_pull_leads
    SET applied_status  = ${status},
        applied_lead_id = ${leadId}::uuid,
        applied_error   = ${error}
    WHERE id = ${rowId}::uuid
  `);
}

/**
 * Every non-importable row is marked in ONE statement rather than in the loop.
 *
 * Rows with a NULL org_id are the `unmapped_form` verdict and can never be
 * applied — the lead has no branch to land in, and guessing one is exactly what
 * the mapping table exists to prevent (a single Page here is shared by eight
 * branch orgs). They stay VISIBLE in the summary with their reason, because
 * "go create the mapping" is the action the screen is asking for.
 */
async function markNonImportable(tx: DrizzleTx, runId: string): Promise<number> {
  const rows = await tx.execute(sql`
    UPDATE scratch.meta_pull_leads
    SET applied_status = 'skipped',
        applied_error  = COALESCE(reason, verdict)
    WHERE run_id = ${runId}::uuid
      AND applied_status = 'pending'
      AND (verdict IS NULL OR NOT (verdict = ANY(${sqlTextArr([...IMPORTABLE_VERDICTS])})))
    RETURNING id
  `);
  return (rows as unknown as Array<{ id: string }>).length;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export interface ApplyOptions {
  log?: LeadSyncLogger | undefined;
}

/** Heartbeat cadence during apply, so the reaper can tell slow from dead. */
const HEARTBEAT_EVERY_ROWS = 25;

/**
 * Applies one CLAIMED run's importable rows. Called by the lead-pull poller,
 * never from a request — see queueApply for why.
 *
 * The tenant is the one named on the claimed run row: the tenant the operator
 * selected when they queued it, validated then under admin_tenant_config_policy.
 * It is not the boundary here either — every statement below still runs under
 * withTenantConfigTx pinned to it, so scratch.meta_pull_*'s policy fences the
 * rows in the database.
 *
 * Resumable by construction: only rows still `pending` are loaded, and every
 * row's outcome is written as it goes, so an Apply interrupted part-way (a
 * deploy, an error) returns the run to `completed` and the next press carries
 * on with whatever is left.
 */
export async function applyRun(
  run: ClaimedApplyRun,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const scope: AdminTenantScope = { actorUserId: run.applied_by, tenantId: run.tenant_id };

  const integration = await getIntegrationByTenantId(run.tenant_id);

  const result: ApplyResult = { attempted: 0, applied: 0, already_synced: 0, skipped: 0, failed: 0 };

  try {
    result.skipped += await withTenantConfigTx(scope, (tx) => markNonImportable(tx, run.id));

    const rows = await withTenantConfigTx(scope, (tx) => loadImportableRows(tx, run.id));
    result.attempted = rows.length;

    let processed = 0;
    for (const row of rows) {
      processed += 1;
      const fieldData = row.raw_field_data ?? [];

      // Belt and braces on a stale classification, and the gap the Python path
      // actually fell through: isMetaTestLead is exported by
      // lead-sync.service.ts but never called inside syncLeadToDatabase, which
      // is how 20 Lead Ads Testing Tool submissions reached production as real
      // leads. The caller applies it, every time.
      if (isMetaTestLead(fieldData)) {
        await withTenantConfigTx(scope, (tx) =>
          recordOutcome(tx, row.id, 'skipped', null, 'Meta Lead Ads Testing Tool placeholder data'),
        );
        result.skipped += 1;
        continue;
      }

      // Defensive: markNonImportable already skipped these, since unmapped_form
      // is not an importable verdict. Re-checked because applying a lead into a
      // guessed branch is the one failure this screen must never produce.
      if (!row.org_id) {
        await withTenantConfigTx(scope, (tx) =>
          recordOutcome(tx, row.id, 'skipped', null, 'unmapped_form'),
        );
        result.skipped += 1;
        continue;
      }

      const lead: RawMetaLead = {
        id: row.meta_lead_id,
        form_id: row.form_id,
        page_id: row.page_id ?? '',
        platform: row.platform ?? 'fb',
        field_data: fieldData,
        ...(row.lead_created_at
          // RawMetaLead.created_time is UNIX SECONDS (syncLeadToDatabase does
          // `created_time * 1000`), while the staged column is a timestamptz.
          ? { created_time: Math.floor(new Date(row.lead_created_at).getTime() / 1000) }
          : {}),
        ...(row.campaign_id ? { campaign_id: row.campaign_id } : {}),
        ...(row.adset_id ? { adset_id: row.adset_id } : {}),
        ...(row.ad_id ? { ad_id: row.ad_id } : {}),
      };

      try {
        const synced = await syncLeadToDatabase(row.org_id, lead, integration?.field_mappings ?? null, {
          // syncLeadToDatabase has never taken a tenant_id — it is keyed on org
          // — so the tenant travels here, which is what lets it resolve the
          // campaign type and therefore route to the right pool.
          tenantId: run.tenant_id,
          ...(integration?.access_token ? { accessToken: integration.access_token } : {}),
          ...(integration?.graph_api_version ? { graphApiVersion: integration.graph_api_version } : {}),
          ...(options.log ? { log: options.log } : {}),
        });

        await withTenantConfigTx(scope, (tx) =>
          recordOutcome(tx, row.id, 'applied', synced.marketingLeadId, null),
        );
        if (synced.isDuplicate) result.already_synced += 1;
        else result.applied += 1;
      } catch (err) {
        // PER ROW, never the batch. syncLeadToDatabase throws on a missing
        // phone and on a non-numeric lead id, and a single such row in a pull
        // of thousands must not discard every lead after it.
        options.log?.warn(
          { evt: 'lead_apply.row_failed', err, runId: run.id, stagedRowId: row.id },
          'Staged lead could not be applied; recorded and continuing',
        );
        await withTenantConfigTx(scope, (tx) =>
          recordOutcome(tx, row.id, 'failed', null, errorMessage(err)),
        );
        result.failed += 1;
      }

      if (processed % HEARTBEAT_EVERY_ROWS === 0) {
        await withTenantConfigTx(scope, (tx) =>
          tx.execute(sql`
            UPDATE scratch.meta_pull_runs
            SET heartbeat_at = NOW(), updated_at = NOW()
            WHERE id = ${run.id}::uuid
          `),
        );
      }
    }

    await withTenantConfigTx(scope, (tx) =>
      tx.execute(sql`
        UPDATE scratch.meta_pull_runs
        SET status      = 'applied',
            applied_at  = NOW(),
            -- This PASS's tallies. After a resumed Apply the per-row
            -- applied_status counts (apply_summary on GET /runs/:id) are the
            -- whole-run truth; this is what the last pass did.
            counts      = counts || ${JSON.stringify({ apply: result })}::jsonb,
            error_text  = NULL,
            heartbeat_at = NOW(),
            updated_at  = NOW()
        WHERE id = ${run.id}::uuid
          -- Only the owner of the claim may finish it. If the reaper already
          -- returned a stalled run to completed, this must not overwrite that.
          AND status = 'applying'
      `),
    );
  } catch (err) {
    // Back to `completed`, NOT `failed`. Every row that was applied is recorded
    // and the rest are still `pending`, so the run is still applicable — and a
    // `failed` run can never be applied again, which used to leave the admin
    // with no option but to re-pull the whole thing.
    await withTenantConfigTx(scope, (tx) =>
      tx.execute(sql`
        UPDATE scratch.meta_pull_runs
        SET status     = 'completed',
            error_text = ${`Apply stopped: ${errorMessage(err)}. Rows already applied are kept — press Apply again to continue with the rest.`},
            updated_at = NOW()
        WHERE id = ${run.id}::uuid
          AND status = 'applying'
      `),
    ).catch(() => undefined);
    throw err;
  }

  return result;
}
