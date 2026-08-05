// ─────────────────────────────────────────────────────────────────────────────
// Daily lead report email job.
//
// Run:
//   pnpm --filter @crm/leads-service send-lead-report                        # every LMS tenant
//   pnpm --filter @crm/leads-service send-lead-report -- --dry-run
//   pnpm --filter @crm/leads-service send-lead-report -- --tenant=<uuid>[,<uuid>]
//   pnpm --filter @crm/leads-service send-lead-report -- --to=ops@example.com
// or, from msq-lms/:   make send-lead-report ARGS="--dry-run --tenant=<uuid>"
//
// For each active tenant entitled to LMS, sends one email containing:
//   * a per-branch table (every branch under the tenant, plus an ALL BRANCHES
//     rollup row), and
//   * a per-assignee table with an explicit Unassigned bucket per branch,
// over the seven metrics defined by lms.vw_lead_report_branch /
// lms.vw_lead_report_user (see db_scripts/02_schema.sql for their semantics).
//
// Recipients: the tenant's own tenant_admins (To) plus platform super_admins
// (Bcc, so one tenant's admins never see the operator list). Set
// LEAD_REPORT_INCLUDE_SUPER_ADMINS=false to drop the Bcc.
//
// Also upserts today's per-branch/assignee counts into lms.lead_report_snapshot
// (skipped on --dry-run), which is what lets the public lead report page
// (GET /public/v1/lead-report) show a day-over-day comparison — the live views
// only ever compute "now", so without this write there would be no history to
// compare against.
//
// Reads as root_service (withServiceTx, BYPASSRLS) and scopes every query on
// tenant_id explicitly — there is no actor session to drive RLS from.
//
// Failure isolation: one tenant's failure (bad data, SMTP refusal, timeout) is
// logged and counted, and the run continues with the next tenant. The process
// exits non-zero if anything failed, so cron/monitoring notices.
//
// There is deliberately no --date flag: the views read NOW() server-side, so a
// date flag could only relabel the subject while the numbers stayed live.
// ─────────────────────────────────────────────────────────────────────────────

import { closeAllPools } from '@platform/db';
import { config } from '../config/index.js';
import * as repo from '../api/v1/analytics/analytics.repository.js';
import { buildTenantReport, sendTenantReport } from '../lib/reports/lead-report.mailer.js';
import { renderReportText, reportSubject } from '../lib/reports/lead-report.render.js';
import type { TenantReport } from '../lib/reports/lead-report.types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOG = '[send-lead-report]';

interface Args {
  tenantIds: string[] | null;
  to: string[] | null;
  dryRun: boolean;
}

function flagValue(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function parseArgs(argv: string[]): Args {
  const tenantRaw = flagValue(argv, 'tenant');
  const toRaw = flagValue(argv, 'to');

  const tenantIds = tenantRaw
    ? tenantRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  for (const id of tenantIds ?? []) {
    if (!UUID_RE.test(id)) throw new Error(`Invalid --tenant uuid: ${id}`);
  }

  const to = toRaw ? toRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  for (const email of to ?? []) {
    if (!EMAIL_RE.test(email)) throw new Error(`Invalid --to address: ${email}`);
  }

  return { tenantIds, to, dryRun: argv.includes('--dry-run') };
}

function printDryRun(report: TenantReport, to: string[], bcc: string[]): void {
  const subject = reportSubject(report.tenant_name, report.report_date);
  const { text } = renderReportText(report);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`To:      ${to.join(', ')}`);
  console.log(`Bcc:     ${bcc.length ? bcc.join(', ') : '(none)'}`);
  console.log(`Subject: ${subject}`);
  console.log(`${'-'.repeat(78)}\n${text}\n${'='.repeat(78)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `${LOG} start: tenants=${args.tenantIds?.join(',') ?? 'all-lms'} ` +
    `dryRun=${args.dryRun} recipientOverride=${args.to ? 'yes' : 'no'}`,
  );

  if (args.to) {
    // public-send does not apply the gateway's recipient allowlist, so an
    // override address is relayed as given. Make that visible in the log.
    console.warn(
      `${LOG} WARNING: --to overrides the tenant_admin lookup and is NOT checked ` +
      `against the platform's recipient allowlist. Sending tenant lead data to: ${args.to.join(', ')}`,
    );
  }

  const tenants = await repo.listReportTenants(args.tenantIds);
  if (tenants.length === 0) {
    console.warn(`${LOG} no active LMS tenants matched — nothing to send`);
    await closeAllPools();
    return;
  }

  // Loaded once per run, not per tenant: the super_admin set is global.
  const superAdmins = args.to || !config.reportIncludeSuperAdmins
    ? []
    : await repo.listSuperAdminEmails();

  let sent = 0;
  let skipped = 0;
  const failures: Array<{ tenant: string; error: string }> = [];

  for (const tenant of tenants) {
    try {
      const report = await buildTenantReport(tenant.tenant_id, tenant.tenant_name);

      // Side-effect, not the job's main purpose: a dry run must stay
      // side-effect-free, and a failure here must never block the email —
      // the report data was already computed correctly either way.
      if (!args.dryRun) {
        try {
          await repo.upsertReportSnapshot(report);
        } catch (err) {
          console.warn(`${LOG} ${tenant.tenant_name}: snapshot write failed —`, err);
        }
      }

      const to = args.to ?? (await repo.listTenantAdminEmails(tenant.tenant_id));

      if (to.length === 0) {
        // An empty email_addresses array is a 400 from communication-service, so
        // skip explicitly and say so — otherwise "sent nothing" has to be
        // inferred from a cryptic error in a log nobody reads.
        console.warn(`${LOG} ${tenant.tenant_name}: no active tenant_admin with an email — skipped`);
        skipped += 1;
        continue;
      }

      const bcc = superAdmins.filter((e) => !to.includes(e));

      if (args.dryRun) {
        printDryRun(report, to, bcc);
        sent += 1;
        continue;
      }

      // The report read has already committed and closed its transaction; never
      // hold one open across an outbound HTTP call.
      const orgId = await repo.resolveAnyOrgIdForTenant(tenant.tenant_id);
      const result = await sendTenantReport(report, to, bcc, {
        tenantId: tenant.tenant_id,
        orgId,
        userId: 'lead-report-job',
      });

      if (!result.sent) {
        failures.push({ tenant: tenant.tenant_name, error: result.error ?? 'unknown send failure' });
        console.error(`${LOG} ${tenant.tenant_name}: FAILED — ${result.error}`);
        continue;
      }

      if (result.error) {
        // Partial rejection: some admins got it. A warning, not a failure.
        console.warn(`${LOG} ${tenant.tenant_name}: partial — ${result.error}`);
      }
      if (result.usersOmitted) {
        console.warn(`${LOG} ${tenant.tenant_name}: assignee breakdown omitted (report too large for email)`);
      }
      console.log(`${LOG} ${tenant.tenant_name}: sent to ${result.recipients} recipient(s), ${bcc.length} bcc`);
      sent += 1;
    } catch (err) {
      // Per-tenant isolation: one unreachable SMTP host or one malformed tenant
      // must not stop the remaining tenants' reports.
      const message = (err as Error).message;
      failures.push({ tenant: tenant.tenant_name, error: message });
      console.error(`${LOG} ${tenant.tenant_name}: FAILED —`, err);
    }
  }

  console.log(
    `${LOG} complete: tenants=${tenants.length} sent=${sent} skipped=${skipped} failed=${failures.length}`,
  );
  for (const f of failures) console.error(`${LOG}   failed: ${f.tenant} — ${f.error}`);

  await closeAllPools();
  if (failures.length > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(`${LOG} FAILED:`, err);
  await closeAllPools();
  process.exit(1);
});
