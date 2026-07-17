import Fastify from 'fastify';
import { closeAllPools } from '@crm/db';
import { config } from './config/index.js';
import { streamRoutes } from './routes/stream.js';
import { PgNotifyTransport } from './transport/pg-notify.transport.js';
import { connectionManager } from './connections/manager.js';
import { startFollowUpChecker, stopFollowUpChecker } from './services/followup-checker.js';

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
