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
      is_tax_exempt TINYINT(1) NOT NULL DEFAULT 0,
      tax_exempt_source VARCHAR(64) NULL,
      tax_exempt_reason VARCHAR(255) NULL,
      reseller_permit_file_path VARCHAR(255) NULL,
      reseller_permit_file_name VARCHAR(255) NULL,
      reseller_permit_uploaded_at DATETIME NULL,
      woo_order_id BIGINT NULL,
      shipstation_order_id VARCHAR(64) NULL,
      items_subtotal DECIMAL(12,2) NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_carrier VARCHAR(120) NULL,
      shipping_service VARCHAR(120) NULL,
      facility_pickup TINYINT(1) NOT NULL DEFAULT 0,
      fulfillment_method VARCHAR(32) NULL,
      physician_certified TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      order_placed_at DATETIME NULL,
      shipped_at DATETIME NULL,
      ups_tracking_status VARCHAR(32) NULL,
      status_normalized VARCHAR(64)
        GENERATED ALWAYS AS (LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-')))
        STORED,
      payload LONGTEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_peppro_orders_user (user_id),
      INDEX idx_peppro_orders_user_created (user_id, created_at),
      INDEX idx_peppro_orders_status_norm_created (status_normalized, created_at),
      INDEX idx_peppro_orders_woo (woo_order_id),
      INDEX idx_peppro_orders_shipstation (shipstation_order_id)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS contact_forms (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name LONGTEXT NOT NULL,
      email LONGTEXT NOT NULL,
      phone LONGTEXT NULL,
      email_blind_index CHAR(64) NULL,
      source VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_contact_forms_email_blind (email_blind_index),
      INDEX idx_contact_forms_created_at (created_at)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS sales_reps (
      id VARCHAR(32) PRIMARY KEY,
      legacy_user_id VARCHAR(32) NULL,
      name VARCHAR(190) NOT NULL,
      email VARCHAR(190) NULL UNIQUE,
      phone VARCHAR(32) NULL,
      territory VARCHAR(120) NULL,
      initials VARCHAR(10) NULL,
      sales_code VARCHAR(8) NULL UNIQUE,
      role VARCHAR(32) NOT NULL DEFAULT 'sales_rep',
      is_partner TINYINT(1) NOT NULL DEFAULT 0,
      jurisdiction VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0,
      total_referrals INT NOT NULL DEFAULT 0,
      first_order_bonus_granted_at DATETIME NULL,
      total_revenue_to_date DECIMAL(12,2) NOT NULL DEFAULT 0,
      total_revenue_updated_at DATETIME NULL,
      created_at DATETIME NULL,
      updated_at DATETIME NULL
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS bugs_reported (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NULL,
      name LONGTEXT NULL,
      email LONGTEXT NULL,
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
      contact_emails_json JSON NULL,
      contact_phones_json JSON NULL,
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
      INDEX idx_sales_prospects_doctor_updated (doctor_id, updated_at, created_at),
      INDEX idx_sales_prospects_referral_id (referral_id),
      INDEX idx_sales_prospects_contact_form_id (contact_form_id),
      INDEX idx_sales_prospects_source_system (source_system),
      INDEX idx_sales_prospects_source_external_id (source_external_id),
      INDEX idx_sales_prospects_status (status),
      INDEX idx_sales_prospects_last_synced_at (last_synced_at)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS sales_prospect_quotes (
      id VARCHAR(64) PRIMARY KEY,
      prospect_id VARCHAR(64) NOT NULL,
      sales_rep_id VARCHAR(64) NOT NULL,
      revision_number INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'draft',
      title VARCHAR(190) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'USD',
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      quote_payload_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      exported_at DATETIME NULL,
      UNIQUE KEY uniq_sales_prospect_quote_revision (prospect_id, revision_number),
      INDEX idx_sales_prospect_quotes_prospect (prospect_id, created_at),
      INDEX idx_sales_prospect_quotes_prospect_status (prospect_id, status, updated_at),
      INDEX idx_sales_prospect_quotes_sales_rep (sales_rep_id, updated_at)
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
      event_end_date DATETIME NULL,
      event_end_date_raw VARCHAR(96) NULL,
      event_end_time_raw VARCHAR(48) NULL,
      duration_minutes INT NULL,
      description LONGTEXT NULL,
      link LONGTEXT NULL,
      recording LONGTEXT NULL,
      sync_token VARCHAR(32) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_peptide_forum_event_date (event_date),
      INDEX idx_peptide_forum_sync_token (sync_token)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS tax_tracking (
      state_code CHAR(2) PRIMARY KEY,
      state_name VARCHAR(64) NOT NULL UNIQUE,
      economic_nexus_revenue_usd DECIMAL(12,2) NULL,
      economic_nexus_transactions INT NULL,
      collect_tax_default TINYINT(1) NOT NULL DEFAULT 0,
      research_reagent_taxable TINYINT(1) NOT NULL DEFAULT 1,
      university_exemption_allowed TINYINT(1) NOT NULL DEFAULT 1,
      resale_certificate_allowed TINYINT(1) NOT NULL DEFAULT 1,
      woo_tax_class VARCHAR(32) NULL,
      notes VARCHAR(255) NULL,
      avg_combined_tax_rate DECIMAL(7,5) NULL,
      example_tax_on_100k_sales DECIMAL(12,2) NULL,
      tax_collection_required_after_nexus TINYINT(1) NOT NULL DEFAULT 0,
      buffered_tax_rate DECIMAL(7,5) NULL,
      example_tax_on_100k_sales_buffered DECIMAL(12,2) NULL,
      tax_nexus_applied TINYINT(1) NOT NULL DEFAULT 0,
      tracking_year SMALLINT NOT NULL DEFAULT 0,
      current_year_revenue_usd DECIMAL(12,2) NOT NULL DEFAULT 0,
      current_year_order_count INT NOT NULL DEFAULT 0,
      last_synced_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tax_tracking_year (tracking_year),
      INDEX idx_tax_tracking_state_name (state_name)
    ) CHARACTER SET utf8mb4
  `,
  `
    CREATE TABLE IF NOT EXISTS state_sales_totals (
      state VARCHAR(64) NOT NULL,
      state_code CHAR(2) PRIMARY KEY,
      trailing_12mo_revenue DECIMAL(12,2) NOT NULL DEFAULT 0,
      transaction_count INT NOT NULL DEFAULT 0,
      nexus_triggered TINYINT(1) NOT NULL DEFAULT 0,
      window_start_at DATETIME NULL,
      window_end_at DATETIME NULL,
      last_synced_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_state_sales_totals_state (state),
      INDEX idx_state_sales_totals_nexus (nexus_triggered),
      INDEX idx_state_sales_totals_state_name (state)
    ) CHARACTER SET utf8mb4
  `,
];

const ensureIndex = async (tableName, indexName, ddl) => {
  try {
    const existing = await mysqlClient.fetchOne(
      `
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :tableName
          AND INDEX_NAME = :indexName
        LIMIT 1
      `,
      { tableName, indexName },
    );
    if (!existing) {
      await mysqlClient.execute(ddl);
      logger.info({ table: tableName, index: indexName }, 'MySQL index added');
    }
  } catch (error) {
    logger.error(
      { err: error, table: tableName, index: indexName },
      'Failed to ensure MySQL index',
    );
  }
};

const dropIndexIfExists = async (tableName, indexName) => {
  try {
    const existing = await mysqlClient.fetchOne(
      `
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :tableName
          AND INDEX_NAME = :indexName
        LIMIT 1
      `,
      { tableName, indexName },
    );
    if (existing) {
      await mysqlClient.execute(`ALTER TABLE ${tableName} DROP INDEX ${indexName}`);
      logger.info({ table: tableName, index: indexName }, 'MySQL index dropped');
    }
  } catch (error) {
    logger.error(
      { err: error, table: tableName, index: indexName },
      'Failed to drop MySQL index',
    );
  }
};

const dropColumnIfExists = async (tableName, columnName) => {
  try {
    const existing = await mysqlClient.fetchOne(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :tableName
          AND COLUMN_NAME = :columnName
        LIMIT 1
      `,
      { tableName, columnName },
    );
    if (existing) {
      await mysqlClient.execute(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
      logger.info({ table: tableName, column: columnName }, 'MySQL column dropped');
    }
  } catch (error) {
    logger.error(
      { err: error, table: tableName, column: columnName },
      'Failed to drop MySQL column',
    );
  }
};

const copyLegacyCiphertext = async ({ tableName, baseColumn, legacyColumn, placeholder = null }) => {
  try {
    const baseExists = await mysqlClient.fetchOne(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :tableName
          AND COLUMN_NAME = :columnName
        LIMIT 1
      `,
      { tableName, columnName: baseColumn },
    );
    const legacyExists = await mysqlClient.fetchOne(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :tableName
          AND COLUMN_NAME = :columnName
        LIMIT 1
      `,
      { tableName, columnName: legacyColumn },
    );
    if (!baseExists || !legacyExists) {
      return;
    }
    const params = {};
    let condition = `(${baseColumn} IS NULL OR ${baseColumn} = '')`;
    if (placeholder !== null) {
      params.placeholder = placeholder;
      condition = `(${baseColumn} IS NULL OR ${baseColumn} = '' OR ${baseColumn} = :placeholder)`;
    }
    await mysqlClient.execute(
      `
        UPDATE ${tableName}
        SET ${baseColumn} = ${legacyColumn}
        WHERE ${legacyColumn} IS NOT NULL
          AND ${condition}
      `,
      params,
    );
  } catch (error) {
    logger.error(
      { err: error, table: tableName, baseColumn, legacyColumn },
      'Failed to migrate legacy ciphertext inline',
    );
  }
};

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
      name: 'reseller_permit_file_path',
      ddl: `
        ALTER TABLE users
        ADD COLUMN reseller_permit_file_path VARCHAR(255) NULL
      `,
    },
    {
      name: 'reseller_permit_file_name',
      ddl: `
        ALTER TABLE users
        ADD COLUMN reseller_permit_file_name VARCHAR(255) NULL
      `,
    },
    {
      name: 'reseller_permit_uploaded_at',
      ddl: `
        ALTER TABLE users
        ADD COLUMN reseller_permit_uploaded_at DATETIME NULL
      `,
    },
    {
      name: 'reseller_permit_approved_by_rep',
      ddl: `
        ALTER TABLE users
        ADD COLUMN reseller_permit_approved_by_rep TINYINT(1) NOT NULL DEFAULT 0
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
      name: 'profile_onboarding',
      ddl: `
        ALTER TABLE users
        ADD COLUMN profile_onboarding TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'reseller_permit_onboarding_presented',
      ddl: `
        ALTER TABLE users
        ADD COLUMN reseller_permit_onboarding_presented TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'greater_area',
      ddl: `
        ALTER TABLE users
        ADD COLUMN greater_area VARCHAR(190) NULL
      `,
    },
    {
      name: 'study_focus',
      ddl: `
        ALTER TABLE users
        ADD COLUMN study_focus VARCHAR(190) NULL
      `,
    },
    {
      name: 'bio',
      ddl: `
        ALTER TABLE users
        ADD COLUMN bio TEXT NULL
      `,
    },
    {
      name: 'network_presence_agreement',
      ddl: `
        ALTER TABLE users
        ADD COLUMN network_presence_agreement TINYINT(1) NOT NULL DEFAULT 1
      `,
    },
    {
      name: 'delegate_logo_url',
      ddl: `
        ALTER TABLE users
        ADD COLUMN delegate_logo_url LONGTEXT NULL
      `,
      expectedDataType: 'longtext',
      alter: `
        ALTER TABLE users
        MODIFY COLUMN delegate_logo_url LONGTEXT NULL
      `,
    },
    {
      name: 'delegate_secondary_color',
      ddl: `
        ALTER TABLE users
        ADD COLUMN delegate_secondary_color VARCHAR(16) NULL
      `,
    },
    {
      name: 'delegate_links_enabled',
      ddl: `
        ALTER TABLE users
        ADD COLUMN delegate_links_enabled TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'research_terms_agreement',
      ddl: `
        ALTER TABLE users
        ADD COLUMN research_terms_agreement TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'delegate_opt_in',
      ddl: `
        ALTER TABLE users
        ADD COLUMN delegate_opt_in TINYINT(1) NOT NULL DEFAULT 0
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
    {
      name: 'email_normalized',
      ddl: `
        ALTER TABLE users
        ADD COLUMN email_normalized VARCHAR(255)
          GENERATED ALWAYS AS (LOWER(TRIM(COALESCE(email, ''))))
          STORED
      `,
    },
    {
      name: 'cart',
      ddl: `
        ALTER TABLE users
        ADD COLUMN cart JSON NULL
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
  await ensureIndex(
    'users',
    'idx_users_email_normalized',
    'ALTER TABLE users ADD INDEX idx_users_email_normalized (email_normalized)',
  );
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
      name: 'is_tax_exempt',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN is_tax_exempt TINYINT(1) NOT NULL DEFAULT 0 AFTER pricing_mode
      `,
    },
    {
      name: 'tax_exempt_source',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN tax_exempt_source VARCHAR(64) NULL AFTER is_tax_exempt
      `,
    },
    {
      name: 'tax_exempt_reason',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN tax_exempt_reason VARCHAR(255) NULL AFTER tax_exempt_source
      `,
    },
    {
      name: 'reseller_permit_file_path',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN reseller_permit_file_path VARCHAR(255) NULL AFTER tax_exempt_reason
      `,
    },
    {
      name: 'reseller_permit_file_name',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN reseller_permit_file_name VARCHAR(255) NULL AFTER reseller_permit_file_path
      `,
    },
    {
      name: 'reseller_permit_uploaded_at',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN reseller_permit_uploaded_at DATETIME NULL AFTER reseller_permit_file_name
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
      name: 'status_normalized',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN status_normalized VARCHAR(64)
          GENERATED ALWAYS AS (LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-')))
          STORED
      `,
    },
    {
      name: 'order_placed_at',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN order_placed_at DATETIME NULL AFTER status
      `,
    },
    {
      name: 'shipped_at',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN shipped_at DATETIME NULL AFTER order_placed_at
      `,
    },
    {
      name: 'ups_tracking_status',
      ddl: `
        ALTER TABLE peppro_orders
        ADD COLUMN ups_tracking_status VARCHAR(32) NULL AFTER shipped_at
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
  await ensureIndex(
    'peppro_orders',
    'idx_peppro_orders_user_created',
    'ALTER TABLE peppro_orders ADD INDEX idx_peppro_orders_user_created (user_id, created_at)',
  );
  await ensureIndex(
    'peppro_orders',
    'idx_peppro_orders_status_norm_created',
    'ALTER TABLE peppro_orders ADD INDEX idx_peppro_orders_status_norm_created (status_normalized, created_at)',
  );
  await copyLegacyCiphertext({
    tableName: 'peppro_orders',
    baseColumn: 'payload',
    legacyColumn: 'payload_encrypted',
  });
  await dropColumnIfExists('peppro_orders', 'payload_encrypted');
  await dropColumnIfExists('peppro_orders', 'phi_payload_ref');
  for (const columnName of ['pickup_ready_notice', 'pickup_location']) {
    try {
      const existing = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'peppro_orders'
            AND COLUMN_NAME = :columnName
        `,
        { columnName },
      );
      if (existing) {
        await mysqlClient.execute(`ALTER TABLE peppro_orders DROP COLUMN ${columnName}`);
        logger.info({ column: columnName }, 'MySQL peppro_orders legacy column dropped');
      }
    } catch (error) {
      logger.error({ err: error, column: columnName }, 'Failed to drop legacy MySQL peppro_orders column');
    }
  }
};

const ensureSalesRepColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'is_partner',
      ddl: `
        ALTER TABLE sales_reps
        ADD COLUMN is_partner TINYINT(1) NOT NULL DEFAULT 0
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
            AND TABLE_NAME = 'sales_reps'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL sales_reps column added');
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL sales_reps column');
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
    {
      name: 'contact_emails_json',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN contact_emails_json JSON NULL
      `,
    },
    {
      name: 'contact_phones_json',
      ddl: `
        ALTER TABLE sales_prospects
        ADD COLUMN contact_phones_json JSON NULL
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
  await ensureIndex(
    'sales_prospects',
    'idx_sales_prospects_doctor_updated',
    'ALTER TABLE sales_prospects ADD INDEX idx_sales_prospects_doctor_updated (doctor_id, updated_at, created_at)',
  );
  await ensureIndex(
    'sales_prospects',
    'idx_sales_prospects_referral_id',
    'ALTER TABLE sales_prospects ADD INDEX idx_sales_prospects_referral_id (referral_id)',
  );
  await ensureIndex(
    'sales_prospects',
    'idx_sales_prospects_contact_form_id',
    'ALTER TABLE sales_prospects ADD INDEX idx_sales_prospects_contact_form_id (contact_form_id)',
  );
  await copyLegacyCiphertext({
    tableName: 'sales_prospects',
    baseColumn: 'source_payload_json',
    legacyColumn: 'source_payload_encrypted',
  });
  try {
    const hasLegacyContactEmail = await mysqlClient.fetchOne(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'sales_prospects'
          AND COLUMN_NAME = 'contact_email'
      `,
    );
    if (hasLegacyContactEmail) {
      await mysqlClient.execute(
        `
          UPDATE sales_prospects
          SET contact_emails_json = JSON_ARRAY(LOWER(TRIM(contact_email)))
          WHERE contact_emails_json IS NULL
            AND contact_email IS NOT NULL
            AND TRIM(contact_email) <> ''
        `,
      );
    }
    const hasLegacyContactPhone = await mysqlClient.fetchOne(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'sales_prospects'
          AND COLUMN_NAME = 'contact_phone'
      `,
    );
    if (hasLegacyContactPhone) {
      await mysqlClient.execute(
        `
          UPDATE sales_prospects
          SET contact_phones_json = JSON_ARRAY(TRIM(contact_phone))
          WHERE contact_phones_json IS NULL
            AND contact_phone IS NOT NULL
            AND TRIM(contact_phone) <> ''
        `,
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to backfill MySQL sales_prospects contact arrays');
  }
  await dropIndexIfExists('sales_prospects', 'idx_sales_prospects_contact_email_norm');
  await dropColumnIfExists('sales_prospects', 'contact_email_normalized');
  await dropColumnIfExists('sales_prospects', 'contact_email');
  await dropColumnIfExists('sales_prospects', 'contact_phone');
  await dropColumnIfExists('sales_prospects', 'source_payload_encrypted');
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
        ADD COLUMN name LONGTEXT NULL AFTER user_id
      `,
    },
    {
      name: 'email',
      ddl: `
        ALTER TABLE bugs_reported
        ADD COLUMN email LONGTEXT NULL AFTER name
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
  try {
    await mysqlClient.execute('ALTER TABLE bugs_reported MODIFY COLUMN name LONGTEXT NULL');
    await mysqlClient.execute('ALTER TABLE bugs_reported MODIFY COLUMN email LONGTEXT NULL');
  } catch (error) {
    logger.error({ err: error }, 'Failed to widen bugs_reported inline ciphertext columns');
  }
  await copyLegacyCiphertext({
    tableName: 'bugs_reported',
    baseColumn: 'name',
    legacyColumn: 'name_encrypted',
  });
  await copyLegacyCiphertext({
    tableName: 'bugs_reported',
    baseColumn: 'email',
    legacyColumn: 'email_encrypted',
  });
  await copyLegacyCiphertext({
    tableName: 'bugs_reported',
    baseColumn: 'report',
    legacyColumn: 'report_encrypted',
    placeholder: '[ENCRYPTED]',
  });
  await dropColumnIfExists('bugs_reported', 'name_encrypted');
  await dropColumnIfExists('bugs_reported', 'email_encrypted');
  await dropColumnIfExists('bugs_reported', 'report_encrypted');
};

const ensureTaxTrackingColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'avg_combined_tax_rate',
      ddl: `
        ALTER TABLE tax_tracking
        ADD COLUMN avg_combined_tax_rate DECIMAL(7,5) NULL
      `,
    },
    {
      name: 'example_tax_on_100k_sales',
      ddl: `
        ALTER TABLE tax_tracking
        ADD COLUMN example_tax_on_100k_sales DECIMAL(12,2) NULL
      `,
    },
    {
      name: 'tax_collection_required_after_nexus',
      ddl: `
        ALTER TABLE tax_tracking
        ADD COLUMN tax_collection_required_after_nexus TINYINT(1) NOT NULL DEFAULT 0
      `,
    },
    {
      name: 'buffered_tax_rate',
      ddl: `
        ALTER TABLE tax_tracking
        ADD COLUMN buffered_tax_rate DECIMAL(7,5) NULL
      `,
    },
    {
      name: 'example_tax_on_100k_sales_buffered',
      ddl: `
        ALTER TABLE tax_tracking
        ADD COLUMN example_tax_on_100k_sales_buffered DECIMAL(12,2) NULL
      `,
    },
    {
      name: 'tax_nexus_applied',
      ddl: `
        ALTER TABLE tax_tracking
        ADD COLUMN tax_nexus_applied TINYINT(1) NOT NULL DEFAULT 0
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
            AND TABLE_NAME = 'tax_tracking'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL tax_tracking column added');
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL tax_tracking column');
    }
  }
};

const ensureContactFormIndexes = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'email_blind_index',
      ddl: 'ALTER TABLE contact_forms ADD COLUMN email_blind_index CHAR(64) NULL',
    },
  ];
  for (const column of columns) {
    try {
      const existing = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'contact_forms'
            AND COLUMN_NAME = :columnName
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL contact_forms column added');
      }
    } catch (error) {
      logger.error({ err: error, column: column.name }, 'Failed to ensure MySQL contact_forms column');
    }
  }
  try {
    await mysqlClient.execute('ALTER TABLE contact_forms MODIFY COLUMN name LONGTEXT NOT NULL');
    await mysqlClient.execute('ALTER TABLE contact_forms MODIFY COLUMN email LONGTEXT NOT NULL');
    await mysqlClient.execute('ALTER TABLE contact_forms MODIFY COLUMN phone LONGTEXT NULL');
  } catch (error) {
    logger.error({ err: error }, 'Failed to widen contact_forms inline ciphertext columns');
  }
  await dropIndexIfExists('contact_forms', 'idx_contact_forms_email');
  await copyLegacyCiphertext({
    tableName: 'contact_forms',
    baseColumn: 'name',
    legacyColumn: 'name_encrypted',
    placeholder: '[ENCRYPTED]',
  });
  await copyLegacyCiphertext({
    tableName: 'contact_forms',
    baseColumn: 'email',
    legacyColumn: 'email_encrypted',
    placeholder: '[ENCRYPTED]',
  });
  await copyLegacyCiphertext({
    tableName: 'contact_forms',
    baseColumn: 'phone',
    legacyColumn: 'phone_encrypted',
  });
  await dropColumnIfExists('contact_forms', 'name_encrypted');
  await dropColumnIfExists('contact_forms', 'email_encrypted');
  await dropColumnIfExists('contact_forms', 'phone_encrypted');
  await ensureIndex(
    'contact_forms',
    'idx_contact_forms_email_blind',
    'ALTER TABLE contact_forms ADD INDEX idx_contact_forms_email_blind (email_blind_index)',
  );
  await ensureIndex(
    'contact_forms',
    'idx_contact_forms_created_at',
    'ALTER TABLE contact_forms ADD INDEX idx_contact_forms_created_at (created_at)',
  );
};

const ensurePeptideForumColumns = async () => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const columns = [
    {
      name: 'event_end_date',
      ddl: 'ALTER TABLE peptide_forum_items ADD COLUMN event_end_date DATETIME NULL',
    },
    {
      name: 'event_end_date_raw',
      ddl: 'ALTER TABLE peptide_forum_items ADD COLUMN event_end_date_raw VARCHAR(96) NULL',
    },
    {
      name: 'event_end_time_raw',
      ddl: 'ALTER TABLE peptide_forum_items ADD COLUMN event_end_time_raw VARCHAR(48) NULL',
    },
    {
      name: 'duration_minutes',
      ddl: 'ALTER TABLE peptide_forum_items ADD COLUMN duration_minutes INT NULL',
    },
  ];

  for (const column of columns) {
    try {
      const existing = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'peptide_forum_items'
            AND COLUMN_NAME = :columnName
          LIMIT 1
        `,
        { columnName: column.name },
      );
      if (!existing) {
        await mysqlClient.execute(column.ddl);
        logger.info({ column: column.name }, 'MySQL peptide_forum_items column added');
      }
    } catch (error) {
      logger.error(
        { err: error, column: column.name },
        'Failed to ensure MySQL peptide_forum_items column',
      );
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
  await ensureSalesRepColumns();
  await ensureOrderColumns();
  await ensureSalesProspectColumns();
  await ensureBugReportColumns();
  await ensureTaxTrackingColumns();
  await ensureContactFormIndexes();
  await ensurePeptideForumColumns();
  logger.info('MySQL schema ensured');
};

module.exports = {
  ensureSchema,
};
