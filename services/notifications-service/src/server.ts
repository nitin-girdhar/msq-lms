import Fastify from 'fastify';
import { closeAllPools } from '@platform/db';
import { config } from './config/index.js';
import { streamRoutes } from './routes/stream.js';
import { PgNotifyTransport } from './transport/pg-notify.transport.js';
import { connectionManager } from './connections/manager.js';
import { startFollowUpChecker, stopFollowUpChecker, setFollowUpCheckerLogger } from './services/followup-checker.js';
import { assertInternalServiceSecret } from '@platform/service-auth';

const app = Fastify({
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    ...(config.nodeEnv !== 'production' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  },
  keepAliveTimeout: 0,
});

app.get('/health', async () => ({ status: 'ok', service: 'notifications-service' }));
app.register(streamRoutes, { prefix: '/api/v1' });

const transport = new PgNotifyTransport();

const start = async () => {
  try {
    // Fail fast rather than accepting traffic we cannot authenticate: without
    // this secret every gateway-proxied request is rejected as unauthorized,
    // and in production a placeholder value is refused outright.
    assertInternalServiceSecret({ nodeEnv: config.nodeEnv, logPrefix: '[notifications-service] ' });

    // Hand the connection manager and the follow-up poller the real pino logger
    // before either can emit — both used console.* directly before this.
    connectionManager.setLogger(app.log);
    setFollowUpCheckerLogger(app.log);

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
