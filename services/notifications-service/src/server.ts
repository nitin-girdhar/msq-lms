import Fastify from 'fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { closeAllPools } from '@platform/db';
import { config } from './config/index.js';
import { streamRoutes } from './routes/stream.js';
import { pushRoutes } from './routes/push.js';
import { PgNotifyTransport } from './transport/pg-notify.transport.js';
import { connectionManager } from './connections/manager.js';
import { startFollowUpChecker, stopFollowUpChecker, setFollowUpCheckerLogger } from './services/followup-checker.js';
import { assertInternalServiceSecret } from '@platform/service-auth';
import { createLoggerOptions } from '@platform/logger';
import { assertWebPushEnv, setWebPushLogger } from '@platform/web-push';

const app = Fastify({
  logger: createLoggerOptions({
    service: 'notifications-service',
    nodeEnv: config.nodeEnv,
    level: config.logLevel,
  }),
  keepAliveTimeout: 0,
});

// Every other service in the platform sets one of these; this service did not,
// and the gap was not cosmetic. Fastify's default handler answers an unhandled
// throw with { statusCode, error: 'Internal Server Error', message: <the raw
// error> } — so when notify.push_subscriptions was missing from a server, the
// browser received `relation "notify.push_subscriptions" does not exist`
// verbatim. A DB error message names schemas, tables and constraints; it
// belongs in the log, never in a response body.
//
// The client's other half of the same bug: createApiClient reads `error`, not
// `message`, so the UI showed a bare "Internal Server error" and the cause was
// invisible from both ends at once.
app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode < 500) {
    // Fastify's own 4xx (bad JSON body, unsupported media type). The message is
    // about the request, not our internals, so it is safe to return.
    request.log.warn({ err: error, path: request.url }, error.message);
    return reply.status(statusCode).send({ success: false, error: error.message });
  }
  request.log.error({ err: error, path: request.url }, 'Unhandled error');
  return reply.status(500).send({ success: false, error: 'Internal server error' });
});

app.get('/health', async () => ({ status: 'ok', service: 'notifications-service' }));
app.register(streamRoutes, { prefix: '/api/v1' });
// Web Push device registration. Authenticated (gateway headers) but deliberately
// not capability-gated — see the comment at the top of routes/push.ts.
app.register(pushRoutes, { prefix: '/api/v1' });

const transport = new PgNotifyTransport();

const start = async () => {
  try {
    // Fail fast rather than accepting traffic we cannot authenticate: without
    // this secret every gateway-proxied request is rejected as unauthorized,
    // and in production a placeholder value is refused outright.
    assertInternalServiceSecret({ nodeEnv: config.nodeEnv, logPrefix: '[notifications-service] ' });

    // Fail fast on missing VAPID config too. Deferred to the first send, this
    // surfaces as "the phones just stopped buzzing" inside a poller tick nobody
    // is watching, rather than as a failed boot.
    assertWebPushEnv();

    // Hand the connection manager and the follow-up poller the real pino logger
    // before either can emit — both used console.* directly before this.
    connectionManager.setLogger(app.log);
    setFollowUpCheckerLogger(app.log);
    setWebPushLogger(app.log);

    await transport.subscribe((event) => {
      app.log.info(
        { eventType: event.type, leadId: event.lead_id, orgId: event.org_id, clients: connectionManager.getClientCount() },
        'PG NOTIFY received — broadcasting',
      );
      connectionManager.broadcast(event);
    });
    app.log.info('PG LISTEN on crm_events channel established');

    startFollowUpChecker();
    app.log.info('Follow-up due checker started');

    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const stop = async () => {
  app.log.info('Graceful shutdown initiated');
  stopFollowUpChecker();
  connectionManager.close();
  await transport.close();
  await app.close();
  await closeAllPools();
  process.exit(0);
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start();
