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
      pricing_mode VARCHAR(16) NOT NULL DEFAULT 'wholesale',
      woo_order_id BIGINT NULL,
      shipstation_order_id VARCHAR(64) NULL,
      items_subtotal DECIMAL(12,2) NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_carrier VARCHAR(120) NULL,
      shipping_service VARCHAR(120) NULL,
      facility_pickup TINYINT(1) NOT NULL DEFAULT 0,
      fulfillment_method VARCHAR(32) NULL,
      pickup_location VARCHAR(255) NULL,
      pickup_ready_notice VARCHAR(255) NULL,
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
    CREATE TABLE IF NOT EXISTS bugs_reported (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NULL,
      name VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      report LONGTEXT NOT NULL,
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
      source_system VARCHAR(32) NULL,
      source_external_id VARCHAR(128) NULL,
      source_payload_json LONGTEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      notes LONGTEXT NULL,
      is_manual TINYINT(1) NOT NULL DEFAULT 0,
      contact_name VARCHAR(190) NULL,
      contact_email VARCHAR(190) NULL,
      contact_phone VARCHAR(32) NULL,
      assigned_by_rule_id VARCHAR(64) NULL,
      assigned_at DATETIME NULL,
      last_synced_at DATETIME NULL,
      sync_hash VARCHAR(64) NULL,
      reseller_permit_exempt TINYINT(1) NOT NULL DEFAULT 0,
      reseller_permit_file_path VARCHAR(255) NULL,
      reseller_permit_file_name VARCHAR(255) NULL,
      reseller_permit_uploaded_at DATETIME NULL,
      created_at DATETIME NULL,
      updated_at DATETIME NULL,
      UNIQUE KEY uniq_sales_rep_doctor (sales_rep_id, doctor_id),
      UNIQUE KEY uniq_sales_rep_referral (sales_rep_id, referral_id),
      UNIQUE KEY uniq_sales_rep_contact_form (sales_rep_id, contact_form_id),
      INDEX idx_sales_prospects_source_system (source_system),
      INDEX idx_sales_prospects_source_external_id (source_external_id),
      INDEX idx_sales_prospects_status (status),
      INDEX idx_sales_prospects_last_synced_at (last_synced_at)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS crm_lead_activity (
      id VARCHAR(64) PRIMARY KEY,
      prospect_id VARCHAR(64) NOT NULL,
      actor_id VARCHAR(64) NULL,
      event_type VARCHAR(64) NOT NULL,
      event_payload_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_crm_lead_activity_prospect_created (prospect_id, created_at),
      INDEX idx_crm_lead_activity_event_type (event_type)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS crm_assignment_rules (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      priority INT NOT NULL DEFAULT 100,
      conditions_json LONGTEXT NULL,
      assignee_sales_rep_id VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_crm_assignment_rules_enabled_priority (enabled, priority)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS crm_sync_checkpoint (
      source_system VARCHAR(64) NOT NULL,
      checkpoint_key VARCHAR(64) NOT NULL DEFAULT 'default',
      cursor_value VARCHAR(255) NULL,
      cursor_timestamp DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (source_system, checkpoint_key)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS seamless (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_system VARCHAR(64) NOT NULL DEFAULT 'seamless',
      trigger VARCHAR(64) NOT NULL DEFAULT 'webhook',
      actor_id VARCHAR(64) NULL,
      payload_json LONGTEXT NOT NULL,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_seamless_created_at (created_at),
      INDEX idx_seamless_trigger_created_at (trigger, created_at)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS peptide_forum_items (
      id VARCHAR(64) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      event_date DATETIME NULL,
      event_date_raw VARCHAR(96) NULL,
      event_time_raw VARCHAR(48) NULL,
      description LONGTEXT NULL,
      link LONGTEXT NULL,
      recording LONGTEXT NULL,
      sync_token VARCHAR(32) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_peptide_forum_event_date (event_date),
      INDEX idx_peptide_forum_sync_token (sync_token)
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
    {
      name: 'dev_commission',
      ddl: `
        ALTER TABLE users
        ADD COLUMN dev_commission TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'receive_client_order_update_emails',
      ddl: `
        ALTER TABLE users
        ADD COLUMN receive_client_order_update_emails TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'hand_delivered',
      ddl: `
        ALTER TABLE users
        ADD COLUMN hand_delivered TINYINT(1) NOT NULL DEFAULT 0
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
    {
      name: 'pricing_mode',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN pricing_mode VARCHAR(16) NOT NULL DEFAULT 'wholesale' AFTER user_id
      `,
    },
    {
      name: 'items_subtotal',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN items_subtotal DECIMAL(12,2) NULL AFTER shipstation_order_id
      `,
    },
    {
      name: 'facility_pickup',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN facility_pickup TINYINT(1) NOT NULL DEFAULT 0 AFTER shipping_service
      `,
    },
    {
      name: 'fulfillment_method',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN fulfillment_method VARCHAR(32) NULL AFTER facility_pickup
      `,
    },
    {
      name: 'pickup_location',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN pickup_location VARCHAR(255) NULL AFTER fulfillment_method
      `,
    },
    {
      name: 'pickup_ready_notice',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN pickup_ready_notice VARCHAR(255) NULL AFTER pickup_location
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
      name: 'source_system',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN source_system VARCHAR(32) NULL
      `,
    },
    {
      name: 'source_external_id',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN source_external_id VARCHAR(128) NULL
      `,
    },
    {
      name: 'source_payload_json',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN source_payload_json LONGTEXT NULL
      `,
    },
    {
      name: 'assigned_by_rule_id',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN assigned_by_rule_id VARCHAR(64) NULL
      `,
    },
    {
      name: 'assigned_at',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN assigned_at DATETIME NULL
      `,
    },
    {
      name: 'last_synced_at',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN last_synced_at DATETIME NULL
      `,
    },
    {
      name: 'sync_hash',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN sync_hash VARCHAR(64) NULL
      `,
    },
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

const ensureBugReportColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'user_id',
      ddl: `
        ALTER TABLE bugs_reported
        ADD COLUMN user_id VARCHAR(64) NULL AFTER id
      `,
    },
    {
      name: 'name',
      ddl: `
        ALTER TABLE bugs_reported
        ADD COLUMN name VARCHAR(255) NULL AFTER user_id
      `,
    },
    {
      name: 'email',
      ddl: `
        ALTER TABLE bugs_reported
        ADD COLUMN email VARCHAR(255) NULL AFTER name
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
            AND TABLE_NAME = 'bugs_reported'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL bugs_reported column added');
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL bugs_reported column');
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
  await ensureBugReportColumns();
  logger.info('MySQL schema ensured');
};

module.exports = {
  ensureSchema,
};
