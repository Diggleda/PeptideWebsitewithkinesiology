const http = require('http');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { bootstrap } = require('./bootstrap');

process.on('uncaughtException', (err) => {
  // Ensure we see boot/runtime crashes even if logger transport is misconfigured under Passenger.
  // eslint-disable-next-line no-console
  console.error('[boot] uncaughtException', err);
  logger.fatal({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[boot] unhandledRejection', reason);
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
});

const assertSecureRuntimeConfig = () => {
  if (env.nodeEnv !== 'production') {
    return;
  }
  if (!process.env.JWT_SECRET || env.jwtSecret === 'your-secret-key-change-in-production') {
    throw new Error('JWT_SECRET must be set to a strong value in production');
  }
};

const tryListen = (app, port) => new Promise((resolve, reject) => {
  const server = http.createServer(app);
  const onError = (error) => {
    server.removeListener('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    server.removeListener('error', onError);
    resolve(server);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port);
});

const createServerWithPortFallback = async (app, startPort, attempts = 1) => {
  const failureCodes = [];
  for (let i = 0; i < attempts; i += 1) {
    const candidate = startPort + i;
    try {
      // eslint-disable-next-line no-await-in-loop
      const server = await tryListen(app, candidate);
      if (i > 0) {
        logger.warn({ tried: startPort, selected: candidate }, 'Port in use, using fallback');
      }
      return { server, port: candidate };
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : null;
      failureCodes.push(code);
      if (code !== 'EADDRINUSE' && code !== 'EPERM' && code !== 'EACCES') {
        throw error;
      }
    }
  }
  const distinctCodes = Array.from(new Set(failureCodes.filter(Boolean)));
  if (distinctCodes.length === 1 && (distinctCodes[0] === 'EPERM' || distinctCodes[0] === 'EACCES')) {
    throw new Error(
      `Unable to bind to ports starting at ${startPort} (${distinctCodes[0]}). `
      + 'Choose a different PORT or update host permissions.',
    );
  }
  throw new Error(`No available port found starting at ${startPort}`);
};

const start = async () => {
  try {
    // eslint-disable-next-line no-console
    console.log('[boot] start', new Date().toISOString(), {
      nodeEnv: env.nodeEnv,
      portEnv: process.env.PORT || null,
      resolvedPort: env.port,
      allowPortFallback: env.allowPortFallback,
    });
    assertSecureRuntimeConfig();
    // eslint-disable-next-line no-console
    console.log('[boot] bootstrap:begin');
    await bootstrap();
    // eslint-disable-next-line no-console
    console.log('[boot] bootstrap:done');

    const createApp = require('./app');
    // eslint-disable-next-line no-console
    console.log('[boot] app:require-done');
    const app = createApp();
    // eslint-disable-next-line no-console
    console.log('[boot] app:create-done');
    // eslint-disable-next-line no-console
    console.log('[boot] listen:begin', { port: env.port, allowPortFallback: env.allowPortFallback });
    const { server, port } = await createServerWithPortFallback(
      app,
      env.port,
      env.allowPortFallback ? 6 : 1,
    );
    // eslint-disable-next-line no-console
    console.log('[boot] listen:done', { port });

    logger.info(
      {
        service: 'peppro-backend',
        port,
        nodeEnv: env.nodeEnv,
      },
      'Backend server is ready',
    );
    setImmediate(() => {
      try {
        if (typeof app.prewarmApiModules === 'function') {
          app.prewarmApiModules();
          logger.debug('Background API route prewarm started');
        }
      } catch (error) {
        logger.warn({ err: error }, 'Background API route prewarm failed');
      }
    });
    try {
      const { startOrderSyncJob } = require('./services/orderService');
      startOrderSyncJob();
    } catch (error) {
      logger.error({ err: error }, 'Failed to start background order sync job');
    }
    try {
      const { startShipStationStatusSyncJob } = require('./services/shipStationSyncService');
      startShipStationStatusSyncJob();
    } catch (error) {
      logger.error({ err: error }, 'Failed to start ShipStation status sync job');
    }
    try {
      const { startSeamlessReconciliationJob } = require('./services/crmSeamlessService');
      startSeamlessReconciliationJob();
    } catch (error) {
      logger.error({ err: error }, 'Failed to start CRM Seamless reconciliation job');
    }

    server.on('error', (error) => {
      logger.error({ err: error }, 'HTTP server error');
      process.exitCode = 1;
    });

    return server;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[boot] failed to start', error);
    logger.fatal({ err: error }, 'Failed to start backend server');
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { start };
