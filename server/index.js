const http = require('http');
const net = require('net');
const createApp = require('./app');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { bootstrap } = require('./bootstrap');
const { startOrderSyncJob } = require('./services/orderService');

const assertSecureRuntimeConfig = () => {
  if (env.nodeEnv !== 'production') {
    return;
  }
  if (!process.env.JWT_SECRET || env.jwtSecret === 'your-secret-key-change-in-production') {
    throw new Error('JWT_SECRET must be set to a strong value in production');
  }
};

const isPortAvailable = async (port) => new Promise((resolve) => {
  const tester = net.createServer()
    .once('error', () => resolve(false))
    .once('listening', () => tester.close(() => resolve(true)))
    .listen(port, '0.0.0.0');
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
    logger.fatal({ err: error }, 'Failed to start backend server');
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { start };
