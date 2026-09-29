import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config/index.js';
import { v1Router } from './api/v1/index.js';
import { AppError, translatePgError } from './lib/errors.js';
import { startLeadPullPoller, stopLeadPullPoller } from './workers/pull-poller.js';
import { closeAllPools } from '@platform/db';
import { assertInternalServiceSecret } from '@platform/service-auth';
import { createLoggerOptions } from '@platform/logger';

const app = Fastify({
  logger: createLoggerOptions({
    service: 'meta-conversion-api',
    nodeEnv: config.nodeEnv,
    level: config.logLevel,
  }),
});

// Capture raw body for HMAC verification on webhook POST routes.
// Fastify parses JSON by default; we override to also keep the raw bytes.
app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    try {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const parsed = JSON.parse(buf.toString('utf-8'));
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

app.setErrorHandler((error, request, reply) => {
  // A raw constraint violation that no call site translated is still a 4xx, not
  // a 500 whose body would carry drizzle's "Failed query: ...params: ..." — and
  // those params are lead/tenant identifiers. Resolved before the AppError
  // branch reads `error`, so the rest of the handler sees one shape.
  const translated = translatePgError(error);
  const err = translated ?? error;

  if (err instanceof AppError) {
    const level = err.statusCode >= 500 ? 'error' : 'warn';
    request.log[level]({ evt: 'request.failed', err, statusCode: err.statusCode }, err.message);
    const body: Record<string, unknown> = { success: false, error: err.message };
    if (err.details !== undefined) body['details'] = err.details;
    return reply.status(err.statusCode).send(body);
  }
  if (error instanceof ZodError) {
    const fieldErrors = error.flatten().fieldErrors;
    // Log field NAMES only. Zod messages can quote the rejected value (enum and
    // custom-refine messages do), and the rejected value here is submitted lead
    // data. The response still carries `details` because @platform/ui-kit's
    // client renders those messages for the user who submitted them.
    request.log.warn({ evt: 'request.validation_failed', fields: Object.keys(fieldErrors) }, 'Validation failed');
    return reply.status(422).send({ success: false, error: 'Validation failed', details: fieldErrors });
  }
  request.log.error({ evt: 'request.unhandled_error', err: error }, 'Unhandled error');
  return reply.status(500).send({ success: false, error: 'Internal server error' });
});

app.register(v1Router, { prefix: '/api/v1' });
app.get('/health', async () => ({ status: 'ok', service: 'meta-conversion-api' }));

const start = async () => {
  try {
    // Fail fast rather than accepting traffic we cannot authenticate: without
    // this secret every gateway-proxied request is rejected as unauthorized,
    // and in production a placeholder value is refused outright.
    assertInternalServiceSecret({ nodeEnv: config.nodeEnv, logPrefix: '[meta-conversion-api] ' });
    await app.listen({ port: config.port, host: '0.0.0.0' });

    // The Meta lead-pull worker. Started AFTER listen so a failure to bind the
    // port is not competing with a claimed run for the shutdown path, and so
    // /health is answering before the first tick does any Graph work.
    //
    // Its first act on every tick is the REAPER, which is what recovers runs
    // this very deploy just interrupted: without it a run stranded in 'running'
    // blocks that tenant behind POST /runs' 409 guard forever.
    startLeadPullPoller(app.log);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const stop = async () => {
  app.log.info('Graceful shutdown initiated');
  // Stops the timer, not an in-flight pull: a run mid-walk is abandoned and the
  // reaper fails it once its heartbeat goes stale, which is the designed
  // recovery. Waiting for it here would hold the container open for minutes.
  stopLeadPullPoller();
  await app.close();
  await closeAllPools();
  process.exit(0);
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start();
