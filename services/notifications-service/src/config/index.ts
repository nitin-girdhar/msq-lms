function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[notifications-service] Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: parseInt(process.env['NOTIFICATIONS_SERVICE_PORT'] ?? '4004', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  databaseUrl: requireEnv('DATABASE_URL'),
  databaseUrlService: requireEnv('DATABASE_URL_SERVICE'),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  keepaliveIntervalMs: 30_000,
  followupCheckIntervalMs: parseInt(requireEnv('FOLLOWUP_CHECK_INTERVAL_MS'), 10),
  followupLookaheadMinutes: parseInt(requireEnv('FOLLOWUP_LOOKAHEAD_MINUTES'), 10),
  // How far BACK the poller looks. The query previously had an upper bound only
  // (`scheduled_at <= NOW() + lookahead`), so every lead ever scheduled and not
  // completed came back on every tick, forever — a set that only grows, scanned
  // every FOLLOWUP_CHECK_INTERVAL_MS. A missed follow-up is worth surfacing for
  // a while, not indefinitely: nobody acts on a notification for something due
  // three weeks ago, and the row is still visible in the follow-ups grid, which
  // is a separate query and unaffected by this bound.
  followupLookbackMinutes: parseInt(process.env['FOLLOWUP_LOOKBACK_MINUTES'] ?? '1440', 10),
  // Hard ceiling on rows per tick, so a backlog degrades throughput instead of
  // memory. Ordered by scheduled_at so the most overdue are always handled first.
  followupMaxRowsPerTick: parseInt(process.env['FOLLOWUP_MAX_ROWS_PER_TICK'] ?? '500', 10),
  // IANA zone the "new day" dedupe reset is computed in. The reset used
  // `toISOString()`, i.e. UTC — which for an India-based tenant fires at 05:30
  // local, mid-morning rather than overnight.
  followupResetTimeZone: process.env['FOLLOWUP_RESET_TIMEZONE'] ?? 'Asia/Kolkata',
} as const;
