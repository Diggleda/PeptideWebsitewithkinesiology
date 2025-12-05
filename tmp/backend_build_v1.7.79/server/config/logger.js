const pino = require('pino');
const { env, isProduction } = require('./env');

const usePretty = env.logPretty || !isProduction;

const logger = pino({
  name: 'peppro-backend',
  level: env.logLevel,
  transport: usePretty
    ? {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
    : undefined,
});

module.exports = { logger };
