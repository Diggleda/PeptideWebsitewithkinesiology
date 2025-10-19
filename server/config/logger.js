const pino = require('pino');
const { env, isProduction } = require('./env');

const logger = pino({
  name: 'protixa-backend',
  level: env.logLevel,
  transport: isProduction
    ? undefined
    : {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
});

module.exports = { logger };
