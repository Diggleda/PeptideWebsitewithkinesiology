const mysqlClient = require('./mysqlClient');
const { logger } = require('../config/logger');

const STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(64) NOT NULL PRIMARY KEY,
      value_json JSON NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
  `,
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
  `
    CREATE TABLE IF NOT EXISTS peppro_orders (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      woo_order_id BIGINT NULL,
      shipstation_order_id VARCHAR(64) NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_carrier VARCHAR(120) NULL,
      shipping_service VARCHAR(120) NULL,
      physician_certified TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      payload LONGTEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_peppro_orders_user (user_id),
      INDEX idx_peppro_orders_woo (woo_order_id),
      INDEX idx_peppro_orders_shipstation (shipstation_order_id)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS contact_forms (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(64) NULL,
      source VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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
