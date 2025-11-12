const mysqlClient = require('./mysqlClient');
const { logger } = require('../config/logger');

const STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS user_passkeys (
      id VARCHAR(32) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      credential_id VARCHAR(255) NOT NULL UNIQUE,
      public_key LONGTEXT NOT NULL,
      counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
      transports LONGTEXT NULL,
      device_type VARCHAR(64) NULL,
      backed_up TINYINT(1) NOT NULL DEFAULT 0,
      label VARCHAR(190) NULL,
      created_at DATETIME NULL,
      updated_at DATETIME NULL,
      last_used_at DATETIME NULL,
      INDEX idx_user_passkeys_user_id (user_id),
      CONSTRAINT fk_user_passkeys_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `,
];

const ensureSchema = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  for (const statement of STATEMENTS) {
    await mysqlClient.execute(statement);
  }
  logger.info('MySQL schema ensured');
};

module.exports = {
  ensureSchema,
};
