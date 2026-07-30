// ─────────────────────────────────────────────────────────────────────────────
// Builds a tenant's daily lead report and dispatches it through
// communication-service.
//
// Sends via POST /api/v1/communications/public-send — the service-to-service
// entry point (guarded by requireInternalSecret, tenant read from headers). The
// user-facing /communications/email route expects gateway-injected auth headers
// and is not callable from here or from the cron job.
//
// One caveat that matters: public-send does NOT apply the gateway's recipient
// allowlist (see communication.controller.ts — "enforced upstream at the
// gateway"). Recipients here are tenant_admins read straight from iam.users, so
// that is fine; an operator-supplied override address is not vetted at all,
// which is why the job warns loudly when --to= is used.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout, UpstreamTimeoutError } from '@platform/http';
import { AppError, HttpStatus } from '../errors.js';
import { config } from '../../config/index.js';
import * as repo from '../../api/v1/analytics/analytics.repository.js';
import { renderReportHtml, renderReportText, reportSubject } from './lead-report.render.js';
import { toBranchRow, toUserRow, type TenantReport } from './lead-report.types.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'] ?? '';

/** communication-service's own caps: 50 to/cc addresses, 20 bcc. */
const MAX_TO = 50;
const MAX_BCC = 20;

interface ChannelResult {
  channel: string;
  success: boolean;
  error?: string;
  data?: { messageId?: string; accepted?: string[]; rejected?: string[] };
}

/**
 * communication-service returns the per-channel results in one of TWO places,
 * depending on outcome:
 *   * 200, partial or full success -> { success: true, data: { results: [...] } }
 *   * 400, EVERY channel failed    -> { success: false, error: 'All communication
 *     channels failed', details: [...] }  (BadRequestError(msg, results))
 *
 * Reading only `data.results` therefore loses the actual reason on the failure
 * path — an operator reading the cron log would see "All communication channels
 * failed" and none of the SMTP detail that says why.
 */
interface CommsResponse {
  success?: boolean;
  error?: string;
  data?: { results?: ChannelResult[] };
  details?: ChannelResult[];
}

function findEmailResult(body: CommsResponse): ChannelResult | undefined {
  return (body.data?.results ?? body.details)?.find((r) => r.channel === 'email');
}

export interface SendReportResult {
  sent: boolean;
  recipients: number;
  /** Non-null when the send did not fully succeed. */
  error: string | null;
  usersOmitted: boolean;
}

/**
 * Reads the ACTUAL per-recipient outcome out of a communication-service reply.
 *
 * Necessary because the email channel is marked `success: true` whenever
 * nodemailer's sendMail did not throw — including when every address landed in
 * `rejected`. Trusting the outer flag would log a delivered report that nobody
 * received. Mirrors extractSendError in whatsapp.service.ts.
 */
export function extractEmailSendError(body: CommsResponse): string | null {
  const channel = findEmailResult(body);
  if (!channel) return body.error ?? 'Communication service returned no email result';
  if (!channel.success) return channel.error ?? 'Email send failed';

  const accepted = channel.data?.accepted ?? [];
  const rejected = channel.data?.rejected ?? [];
  if (accepted.length === 0) return 'Email send accepted no recipients';
  if (rejected.length > 0) return `Rejected recipients: ${rejected.join(', ')}`;
  return null;
}

/**
 * Fetches both report shapes for a tenant and normalises them.
 *
 * `tenantName` is passed in rather than read from the rows: the views cannot
 * join entity.tenants without breaking every non-service caller (see their
 * header comment in db_scripts/02_schema.sql). Callers that already have the
 * name — the job, from its tenant list — should pass it; the rest fall back to a
 * service-role lookup.
 */
export async function buildTenantReport(tenantId: string, tenantName?: string): Promise<TenantReport> {
  const [{ branches, users }, name] = await Promise.all([
    repo.getTenantReportForJob(tenantId),
    tenantName ? Promise.resolve(tenantName) : repo.resolveTenantName(tenantId),
  ]);
  const branchRows = branches.map(toBranchRow);
  const userRows = users.map(toUserRow);
  const rollup = branchRows.find((b) => b.is_total);

  return {
    tenant_id: tenantId,
    tenant_name: name,
    // The rollup's report_date is a MAX() over the branches' local dates, which
    // is the right label for a tenant spanning timezones.
    report_date: rollup?.report_date || branchRows[0]?.report_date || new Date().toISOString().slice(0, 10),
    branches: branchRows,
    users: userRows,
  };
}

export interface SendOptions {
  tenantId: string;
  /** Any org in the tenant — audit context for the x-org-id header only. */
  orgId?: string | null;
  userId?: string | null;
  /** Endpoint callers want an AppError; the job wants a result it can tally. */
  throwOnError?: boolean;
}

export async function sendTenantReport(
  report: TenantReport,
  to: string[],
  bcc: string[],
  opts: SendOptions,
): Promise<SendReportResult> {
  if (to.length === 0) {
    const message = 'No recipients for this report';
    if (opts.throwOnError) throw new AppError(message, HttpStatus.UNPROCESSABLE);
    return { sent: false, recipients: 0, error: message, usersOmitted: false };
  }

  const { html, usersOmitted } = renderReportHtml(report);
  const { text } = renderReportText(report);
  const subject = reportSubject(report.tenant_name, report.report_date);
  const recipients = to.slice(0, MAX_TO);
  const bccList = bcc.filter((e) => !recipients.includes(e)).slice(0, MAX_BCC);

  let response: Response;
  try {
    response = await fetchWithTimeout(`${config.communicationServiceUrl}/api/v1/communications/public-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
        // Audit context only — the email channel does not read org/user from here.
        'x-org-id': opts.orgId ?? '',
        'x-user-id': opts.userId ?? 'lead-report-job',
        'x-tenant-id': opts.tenantId,
      },
      body: JSON.stringify({
        subject,
        body: text,
        html,
        email_addresses: recipients,
        ...(bccList.length ? { bcc: bccList } : {}),
      }),
      timeoutMs: config.communicationServiceTimeoutMs,
      target: 'communication-service/public-send',
    });
  } catch (err) {
    // A timeout means the mail may well have gone out — say so rather than invite
    // a retry that double-sends the report.
    const timedOut = err instanceof UpstreamTimeoutError;
    const message = timedOut
      ? 'The communication service did not respond in time. The report may still have been sent.'
      : `Could not reach the communication service: ${(err as Error).message}`;
    if (opts.throwOnError) {
      throw new AppError(message, timedOut ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY);
    }
    return { sent: false, recipients: recipients.length, error: message, usersOmitted };
  }

  const body = (await response.json().catch(() => null)) as CommsResponse | null;

  if (!response.ok || !body) {
    // Prefer the email channel's own error over the generic envelope message:
    // "All communication channels failed" is useless in a cron log, whereas the
    // channel error carries the actionable reason (bad SMTP credential, refused
    // recipient, unconfigured mailer).
    const channelError = body ? findEmailResult(body)?.error : undefined;
    const message = channelError
      ?? body?.error
      ?? `Communication service returned ${response.status}`;
    if (opts.throwOnError) throw new AppError(message, HttpStatus.BAD_GATEWAY);
    return { sent: false, recipients: recipients.length, error: message, usersOmitted };
  }

  const sendError = extractEmailSendError(body);
  if (sendError && opts.throwOnError) {
    throw new AppError(`Report send failed: ${sendError}`, HttpStatus.BAD_GATEWAY);
  }

  return {
    // A partial rejection still reached somebody, so it is a warning rather than
    // an outright failure for the job's tally.
    sent: sendError === null || sendError.startsWith('Rejected recipients'),
    recipients: recipients.length,
    error: sendError,
    usersOmitted,
  };
}
