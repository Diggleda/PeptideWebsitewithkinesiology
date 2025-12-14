const { initStorage } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const { ensureSchema } = require('../database/mysqlSchema');
const settingsService = require('../services/settingsService');

const bootstrap = async () => {
  initStorage();
  logger.info({ dataDir: env.dataDir }, 'Storage initialized');

  if (env.mysql?.enabled) {
    try {
      await mysqlClient.configure();
      await ensureSchema();
      logger.info(
        {
          host: env.mysql.host,
          database: env.mysql.database,
        },
        'MySQL client configured',
      );
    } catch (error) {
      logger.error(
        { err: error, host: env.mysql.host, port: env.mysql.port },
        'MySQL unavailable, disabling MySQL integration for this run',
      );
      // Fallback to in-memory/json stores for this process
      // eslint-disable-next-line no-param-reassign
      env.mysql.enabled = false;
    }
  } else {
    logger.warn(
      { mysqlEnabled: false },
      'MySQL disabled; profile images will NOT be persisted to MySQL users table',
    );
  }

  // Hydrate the local settings cache from MySQL (if enabled) so downstream services
  // can read from the file store without awaiting SQL on first request.
  try {
    await settingsService.getSettings();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to hydrate settings during bootstrap');
  }
};

module.exports = { bootstrap };
