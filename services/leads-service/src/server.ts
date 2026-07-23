import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config/index.js';
import { v1Router } from './api/v1/index.js';
import { AppError, translatePgError } from './lib/errors.js';
import { closeAllPools, startCapabilityCache, assertDbEnv } from '@platform/db';

const app = Fastify({
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    ...(config.nodeEnv !== 'production' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  },
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof AppError) {
    const level = error.statusCode >= 500 ? 'error' : 'warn';
    app.log[level]({ err: error, path: request.url }, error.message);
    const body: Record<string, unknown> = { success: false, error: error.message };
    if (error.details !== undefined) body['details'] = error.details;
    return reply.status(error.statusCode).send(body);
  }
  if (error instanceof ZodError) {
    return reply.status(422).send({ success: false, error: 'Validation failed', details: error.flatten().fieldErrors });
  }
  // Backstop: translate known Postgres constraint/RAISE errors to a clean 4xx so a
  // raw DB error never leaks to the client as a 500. See Issue #3.
  const translated = translatePgError(error);
  if (translated) {
    app.log.warn({ err: error, path: request.url }, translated.message);
    return reply.status(translated.statusCode).send({ success: false, error: translated.message });
  }
  app.log.error({ err: error, path: request.url }, 'Unhandled error');
  return reply.status(500).send({ success: false, error: 'Internal server error' });
});

app.register(v1Router, { prefix: '/api/v1' });
app.get('/health', async () => ({ status: 'ok', service: 'leads-service' }));

const start = async () => {
  try {
    // Fail fast if a DB pool is unconfigured (e.g. missing DATABASE_URL_TENANT —
    // Issue #1), rather than 500-ing on the first tenant_admin request.
    assertDbEnv();
    // Tier C3: keep the in-memory capability matrix fresh via LISTEN/NOTIFY.
    await startCapabilityCache();
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const stop = async () => {
  app.log.info('Graceful shutdown initiated');
  await app.close();
  await closeAllPools();
  process.exit(0);
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start();
