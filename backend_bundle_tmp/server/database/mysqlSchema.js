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
  `
    CREATE TABLE IF NOT EXISTS sales_prospects (
      id VARCHAR(64) PRIMARY KEY,
      sales_rep_id VARCHAR(32) NOT NULL,
      doctor_id VARCHAR(32) NULL,
      referral_id VARCHAR(64) NULL,
      contact_form_id VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      notes LONGTEXT NULL,
      is_manual TINYINT(1) NOT NULL DEFAULT 0,
      contact_name VARCHAR(190) NULL,
      contact_email VARCHAR(190) NULL,
      contact_phone VARCHAR(32) NULL,
      reseller_permit_exempt TINYINT(1) NOT NULL DEFAULT 0,
      reseller_permit_file_path VARCHAR(255) NULL,
      reseller_permit_file_name VARCHAR(255) NULL,
      reseller_permit_uploaded_at DATETIME NULL,
      created_at DATETIME NULL,
      updated_at DATETIME NULL,
      UNIQUE KEY uniq_sales_rep_doctor (sales_rep_id, doctor_id),
      UNIQUE KEY uniq_sales_rep_referral (sales_rep_id, referral_id),
      UNIQUE KEY uniq_sales_rep_contact_form (sales_rep_id, contact_form_id)
    ) CHARACTER SET utf8mb4
  `,
];

const ensureUserColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }

  const columns = [
    {
      name: 'npi_number',
      ddl: `
        ALTER TABLE users
        ADD COLUMN npi_number VARCHAR(20) NULL
      `,
    },
    {
      name: 'npi_provider_name',
      ddl: `
        ALTER TABLE users
        ADD COLUMN npi_provider_name VARCHAR(255) NULL
      `,
    },
    {
      name: 'npi_clinic_name',
      ddl: `
        ALTER TABLE users
        ADD COLUMN npi_clinic_name VARCHAR(255) NULL
      `,
    },
    {
      name: 'npi_verification_status',
      ddl: `
        ALTER TABLE users
        ADD COLUMN npi_verification_status VARCHAR(32) NULL
      `,
    },
    {
      name: 'npi_verified_at',
      ddl: `
        ALTER TABLE users
        ADD COLUMN npi_verified_at DATETIME NULL
      `,
    },
    {
      name: 'is_tax_exempt',
      ddl: `
        ALTER TABLE users
        ADD COLUMN is_tax_exempt TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'tax_exempt_source',
      ddl: `
        ALTER TABLE users
        ADD COLUMN tax_exempt_source VARCHAR(64) NULL
      `,
    },
    {
      name: 'tax_exempt_reason',
      ddl: `
        ALTER TABLE users
        ADD COLUMN tax_exempt_reason VARCHAR(255) NULL
      `,
    },
    {
      name: 'profile_image_url',
      ddl: `
        ALTER TABLE users
        ADD COLUMN profile_image_url LONGTEXT NULL
      `,
      expectedDataType: 'longtext',
      alter: `
        ALTER TABLE users
        MODIFY COLUMN profile_image_url LONGTEXT NULL
      `,
    },
  ];

  for (const column of columns) {
    try {
      const existing = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME, DATA_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'users'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL users table column added');
      } else if (
        column.expectedDataType
        && column.alter
        && typeof existing.DATA_TYPE === 'string'
        && existing.DATA_TYPE.toLowerCase() !== column.expectedDataType.toLowerCase()
      ) {
        await mysqlClient.execute(column.alter);
        logger.info(
          { column: column.name, from: existing.DATA_TYPE, to: column.expectedDataType },
          'MySQL users table column altered',
        );
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL users table column');
    }
  }
};

const ensureOrderColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'Payment Details',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN \`Payment Details\` VARCHAR(255) NULL AFTER status
      `,
    },
  ];
  for (const column of columns) {
    try {
      const existing = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'peppro_orders'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL peppro_orders column added');
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL peppro_orders column');
    }
  }
};

const ensureSalesProspectColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'reseller_permit_exempt',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN reseller_permit_exempt TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'reseller_permit_file_path',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN reseller_permit_file_path VARCHAR(255) NULL
      `,
    },
    {
      name: 'reseller_permit_file_name',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN reseller_permit_file_name VARCHAR(255) NULL
      `,
    },
    {
      name: 'reseller_permit_uploaded_at',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN reseller_permit_uploaded_at DATETIME NULL
      `,
    },
  ];
  for (const column of columns) {
    try {
      const existing = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'sales_prospects'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL sales_prospects column added');
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL sales_prospects column');
    }
  }
};

const ensureSchema = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  for (const statement of STATEMENTS) {
    await mysqlClient.execute(statement);
  }
  await ensureUserColumns();
  await ensureOrderColumns();
  await ensureSalesProspectColumns();
  logger.info('MySQL schema ensured');
};

module.exports = {
  ensureSchema,
};
