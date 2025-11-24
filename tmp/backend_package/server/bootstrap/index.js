const { initStorage } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const { ensureSchema } = require('../database/mysqlSchema');

const bootstrap = async () => {
  initStorage();
  logger.info({ dataDir: env.dataDir }, 'Storage initialized');

  if (env.mysql?.enabled) {
    await mysqlClient.configure();
    await ensureSchema();
    logger.info(
      {
        host: env.mysql.host,
        database: env.mysql.database,
      },
      'MySQL client configured',
    );
  }
};

module.exports = { bootstrap };
