const { env } = require('../config/env');
const { logger } = require('../config/logger');

let pool = null;
let loggedDisabled = false;
let mysqlModule = null;

const mysqlTlsError = (message) => {
  const error = new Error(message);
  error.code = 'MYSQL_TLS_REQUIRED';
  return error;
};

const getMysqlModule = () => {
  if (!mysqlModule) {
    // Lazily require mysql2 so local/dev runs with MYSQL disabled do not pay
    // the module startup cost or get stuck in mysql2 initialization.
    // This keeps backend boot fast when the app is using JSON/local storage only.
    // eslint-disable-next-line global-require
    mysqlModule = require('mysql2/promise');
  }
  return mysqlModule;
};

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

const verifyTlsNegotiated = async (activePool) => {
  if (!env.mysql?.ssl) {
    return true;
  }
  const [rows] = await activePool.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  const cipher = String(rows?.[0]?.Value || '').trim();
  if (cipher) {
    return true;
  }
  if (!env.mysql?.sslRequireNegotiated) {
    logger.warn(
      {
        host: env.mysql.host,
        port: env.mysql.port,
      },
      'MYSQL_SSL=true requested TLS, but the MySQL session did not negotiate TLS; continuing because MYSQL_SSL_ENFORCE is not enabled',
    );
    return false;
  }
  throw mysqlTlsError(
    "MYSQL_SSL=true was configured, but the MySQL session did not negotiate TLS "
    + "(SHOW SESSION STATUS LIKE 'Ssl_cipher' returned empty).",
  );
};

const configure = async () => {
  if (!isEnabled()) {
    pool = null;
    return;
  }
  if (pool) {
    return;
  }
  const mysql = getMysqlModule();
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
  try {
    await verifyTlsNegotiated(pool);
  } catch (error) {
    try {
      await pool.end();
    } catch (_closeError) {
      // ignore close failures on startup validation
    }
    pool = null;
    throw error;
  }
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
