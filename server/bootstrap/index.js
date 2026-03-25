const { initStorage } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const { ensureSchema } = require('../database/mysqlSchema');
const settingsService = require('../services/settingsService');

const configureMysql = async () => {
  if (!env.mysql?.enabled) {
    logger.warn(
      { mysqlEnabled: false },
      'MySQL disabled; profile images will NOT be persisted to MySQL users table',
    );
    return false;
  }

  try {
    await mysqlClient.configure();
    return true;
  } catch (error) {
    if (error && error.code === 'MYSQL_TLS_REQUIRED') {
      throw error;
    }
    logger.error(
      { err: error, host: env.mysql.host, port: env.mysql.port },
      'MySQL unavailable, disabling MySQL integration for this run',
    );
    // Fallback to in-memory/json stores for this process
    // eslint-disable-next-line no-param-reassign
    env.mysql.enabled = false;
    return false;
  }
};

const finishMysqlBootstrap = async () => {
  if (!env.mysql?.enabled) {
    return;
  }

  try {
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
      'MySQL schema bootstrap failed; disabling MySQL integration for this run',
    );
    // eslint-disable-next-line no-param-reassign
    env.mysql.enabled = false;
  }
};

const hydrateSettings = async () => {
  try {
    await settingsService.getSettings();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to hydrate settings during bootstrap');
  }
};

const bootstrap = async ({ deferNonCritical = env.nodeEnv !== 'production' } = {}) => {
  initStorage();
  logger.info({ dataDir: env.dataDir }, 'Storage initialized');

  const mysqlReady = await configureMysql();

  const runDeferred = async () => {
    if (mysqlReady) {
      await finishMysqlBootstrap();
    }
    await hydrateSettings();
  };

  if (deferNonCritical) {
    return { runDeferred };
  }

  await runDeferred();
  return { runDeferred: null };
};

module.exports = { bootstrap };
