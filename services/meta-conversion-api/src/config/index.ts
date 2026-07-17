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
  internalServiceSecret: requireEnv('INTERNAL_SERVICE_SECRET'),
  allowUnsignedWebhooks,
  encryptionKey,
} as const;
