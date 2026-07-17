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
} as const;
