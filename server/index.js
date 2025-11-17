const http = require('http');
const net = require('net');
const createApp = require('./app');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { bootstrap } = require('./bootstrap');

const findAvailablePort = async (startPort, attempts = 5) => {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = startPort + i;
    // eslint-disable-next-line no-await-in-loop
    const available = await new Promise((resolve) => {
      const tester = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => tester.close(() => resolve(true)))
        .listen(candidate, '0.0.0.0');
    });
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
    await bootstrap();

    const port = await findAvailablePort(env.port, 6);
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
