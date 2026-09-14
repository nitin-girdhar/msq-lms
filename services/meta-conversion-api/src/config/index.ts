import { timeoutFromEnv } from '@platform/http';
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[meta-conversion-api] Missing required env var: ${name}`);
  return value;
}

const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const isProduction = nodeEnv === 'production';

// Webhook signature verification may only be skipped when explicitly allowed,
// never implicitly because NODE_ENV happens to be non-production.
const allowUnsignedWebhooks = process.env['ALLOW_UNSIGNED_WEBHOOKS'] === 'true';
if (allowUnsignedWebhooks && isProduction) {
  throw new Error('[meta-conversion-api] ALLOW_UNSIGNED_WEBHOOKS must not be enabled in production');
}

const encryptionKey = process.env['META_ENCRYPTION_KEY'];
if (isProduction && !encryptionKey) {
  throw new Error('[meta-conversion-api] META_ENCRYPTION_KEY is required in production to encrypt Meta credentials at rest');
}

export const config = {
  port: parseInt(process.env['META_SERVICE_PORT'] ?? '4003', 10),
  nodeEnv,
  isProduction,
  databaseUrl: requireEnv('DATABASE_URL'),
  databaseUrlService: requireEnv('DATABASE_URL_SERVICE'),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  leadsServiceUrl: process.env['LEADS_SERVICE_URL'] ?? 'http://localhost:4002',
  // Kept short: this call sits inside Meta's webhook delivery window, and a slow
  // response makes Meta retry the same delivery. See lib/internal-leads-client.ts.
  leadsServiceTimeoutMs: timeoutFromEnv('META_LEADS_SERVICE_TIMEOUT_MS', 10_000),
  // The reclassify fan-out walks every branch that ran a campaign and reassigns
  // its leads, so it is nothing like the single-lead intake call above and does
  // not sit inside Meta's webhook delivery window — an admin pressed Confirm and
  // is watching a spinner. See lib/internal-leads-client.ts::reclassifyCampaign.
  leadsReclassifyTimeoutMs: timeoutFromEnv('META_LEADS_RECLASSIFY_TIMEOUT_MS', 60_000),
  internalServiceSecret: requireEnv('INTERNAL_SERVICE_SECRET'),
  allowUnsignedWebhooks,
  encryptionKey,

  // ── Meta lead pull (the run row IS the queue; see workers/pull-poller.ts) ──
  //
  // How often the poller looks for a queued run. This is a latency figure, not
  // a throughput one: a pull takes minutes, and the only cost of a short
  // interval is one indexed partial-index probe that finds nothing.
  leadPullPollIntervalMs: parseInt(process.env['META_LEAD_PULL_POLL_INTERVAL_MS'] ?? '10000', 10),
  // Hard cap on Graph pages fetched per FORM (100 leads each), mirroring
  // download_page_leads.py's --max-pages. Hitting it surfaces a LOUD `truncated`
  // warning on the run rather than a silent short read.
  leadPullMaxGraphPagesPerForm: parseInt(process.env['META_LEAD_PULL_MAX_PAGES'] ?? '50', 10),
  // A claimed run whose heartbeat is older than this is reaped as 'failed'.
  // Without the reaper a deploy mid-pull strands the run in 'running' forever,
  // and POST /runs' 409 guard then locks that tenant out permanently. Generous
  // relative to the per-page heartbeat, because a single slow page being
  // backed off must not look like a dead process.
  leadPullStaleRunMinutes: parseInt(process.env['META_LEAD_PULL_STALE_MINUTES'] ?? '15', 10),
} as const;
