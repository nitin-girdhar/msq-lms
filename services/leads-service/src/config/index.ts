import { timeoutFromEnv } from '@platform/http';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[leads-service] Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: parseInt(process.env['LEADS_SERVICE_PORT'] ?? '4002', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  databaseUrl: requireEnv('DATABASE_URL'),
  databaseUrlService: requireEnv('DATABASE_URL_SERVICE'),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  metaServiceUrl: process.env['META_SERVICE_URL'] ?? 'http://localhost:4003',
  communicationServiceUrl: process.env['COMMUNICATION_SERVICE_URL'] ?? 'http://localhost:4005',
  // WhatsApp sends proxy through communication-service, which in turn calls
  // Interakt. Budget must exceed INTERAKT_TIMEOUT_MS or this side gives up while
  // the downstream call is still in flight — leaving the message sent but the
  // caller told it failed.
  communicationServiceTimeoutMs: timeoutFromEnv('LEADS_COMMUNICATION_SERVICE_TIMEOUT_MS', 15_000),
} as const;
