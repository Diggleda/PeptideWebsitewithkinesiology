const http = require('http');
const createApp = require('./app');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { bootstrap } = require('./bootstrap');

const start = async () => {
  try {
    await bootstrap();

    const app = createApp();
    const server = http.createServer(app);

    server.listen(env.port, () => {
      logger.info(
        {
          service: 'protixa-backend',
          port: env.port,
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
