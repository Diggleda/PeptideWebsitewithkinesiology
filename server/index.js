const http = require('http');
const net = require('net');
const createApp = require('./app');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { bootstrap } = require('./bootstrap');
const { startOrderSyncJob } = require('./services/orderService');

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

const isPortAvailable = async (port) => new Promise((resolve) => {
  const tester = net.createServer();

  const cleanup = (available) => {
    try {
      tester.close(() => resolve(available));
    } catch {
      resolve(available);
    }
  };

  tester.once('error', (err) => {
    // Retry on IPv4-only stacks; otherwise treat as unavailable.
    if (err && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      try {
        const ipv4Tester = net.createServer()
          .once('error', () => resolve(false))
          .once('listening', function onListening() {
            ipv4Tester.close(() => resolve(true));
          });
        ipv4Tester.listen(port, '0.0.0.0');
        return;
      } catch {
        resolve(false);
        return;
      }
    }
    resolve(false);
  });

  tester.once('listening', () => cleanup(true));

  // Match `server.listen(port)` behavior which prefers IPv6 dual-stack (`::`) when available.
  try {
    tester.listen({ port, host: '::' });
  } catch {
    // If the platform doesn't support IPv6, fall back to IPv4.
    try {
      tester.listen(port, '0.0.0.0');
    } catch {
      resolve(false);
    }
  }
});

const findAvailablePort = async (startPort, attempts = 5) => {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = startPort + i;
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(candidate);
    if (available) {
      if (i > 0) {
        logger.warn({ tried: startPort, selected: candidate }, 'Port in use, using fallback');
      }
      return candidate;
    }
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
    await bootstrap();

    let port = env.port;
    if (env.allowPortFallback) {
      port = await findAvailablePort(env.port, 6);
    } else {
      const available = await isPortAvailable(env.port);
      if (!available) {
        throw new Error(
          `Port ${env.port} is already in use. Stop the existing process or set PORT, or set ALLOW_PORT_FALLBACK=true.`,
        );
      }
    }

    const app = createApp();
    const server = http.createServer(app);

    server.listen(port, () => {
      logger.info(
        {
          service: 'peppro-backend',
          port,
          nodeEnv: env.nodeEnv,
        },
        'Backend server is ready',
      );
      startOrderSyncJob();
    });

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
