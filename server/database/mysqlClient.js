const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

let pool = null;
let loggedDisabled = false;

const logDisabledOnce = () => {
  if (!loggedDisabled) {
    logger.warn(
      { mysqlEnabled: false, envMysqlEnabled: env.mysql?.enabled },
      'MySQL is disabled; database writes are skipped',
    );
    loggedDisabled = true;
  }
};

const isEnabled = () => Boolean(env.mysql?.enabled);

const configure = async () => {
  if (!isEnabled()) {
    pool = null;
    return;
  }
  if (pool) {
    return;
  }
  pool = mysql.createPool({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    waitForConnections: true,
    connectionLimit: env.mysql.connectionLimit || 8,
    queueLimit: 0,
    charset: 'utf8mb4',
    namedPlaceholders: true,
    timezone: env.mysql.timezone || 'Z',
    ssl: env.mysql.ssl ? {} : undefined,
  });
  logger.info(
    {
      host: env.mysql.host,
      database: env.mysql.database,
      connectionLimit: env.mysql.connectionLimit,
    },
    'MySQL connection pool configured',
  );
};

const requirePool = () => {
  if (!pool) {
    throw new Error('MySQL pool is not configured');
  }
  return pool;
};

const execute = async (query, params = {}) => {
  if (!isEnabled()) {
    logDisabledOnce();
    return null;
  }
  const [result] = await requirePool().execute(query, params);
  return result;
};

const fetchOne = async (query, params = {}) => {
  if (!isEnabled()) {
    logDisabledOnce();
    return null;
  }
  const [rows] = await requirePool().execute(query, params);
  return rows[0] || null;
};

const fetchAll = async (query, params = {}) => {
  if (!isEnabled()) {
    logDisabledOnce();
    return [];
  }
  const [rows] = await requirePool().execute(query, params);
  return rows;
};

module.exports = {
  configure,
  execute,
  fetchOne,
  fetchAll,
  isEnabled,
};
