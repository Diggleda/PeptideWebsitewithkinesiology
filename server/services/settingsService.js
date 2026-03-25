const mysqlClient = require('../database/mysqlClient');
const { settingsStore } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');

const DEFAULT_SETTINGS = {
  shopEnabled: true,
  betaServices: [],
  patientLinksEnabled: false,
  peptideForumEnabled: true,
  researchDashboardEnabled: false,
  crmEnabled: true,
  testPaymentsOverrideEnabled: false,
  stripeMode: null, // null = follow env
  salesBySalesRepCsvDownloadedAt: null, // ISO timestamp (admin report)
  salesLeadSalesBySalesRepCsvDownloadedAt: null, // ISO timestamp (sales lead report)
  taxesByStateCsvDownloadedAt: null, // ISO timestamp (admin report)
  productsCommissionCsvDownloadedAt: null, // ISO timestamp (admin report)
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const BETA_SERVICE_KEYS = new Set([
  'shop',
  'patientLinks',
  'crm',
  'forum',
  'research',
  'testPaymentsOverride',
]);

const normalizeIsoTimestamp = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
};

const normalizeSettings = (settings = {}) => {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const merged = { ...DEFAULT_SETTINGS };
  merged.shopEnabled = Boolean(raw.shopEnabled ?? DEFAULT_SETTINGS.shopEnabled);
  merged.betaServices = Array.from(new Set(
    (Array.isArray(raw.betaServices) ? raw.betaServices : [raw.betaServices])
      .map((value) => String(value || '').trim())
      .filter((value) => value && BETA_SERVICE_KEYS.has(value)),
  ));
  merged.patientLinksEnabled = Boolean(
    raw.patientLinksEnabled ?? DEFAULT_SETTINGS.patientLinksEnabled,
  );
  merged.peptideForumEnabled = Boolean(
    raw.peptideForumEnabled ?? DEFAULT_SETTINGS.peptideForumEnabled,
  );
  merged.researchDashboardEnabled = Boolean(
    raw.researchDashboardEnabled ?? DEFAULT_SETTINGS.researchDashboardEnabled,
  );
  merged.crmEnabled = Boolean(raw.crmEnabled ?? DEFAULT_SETTINGS.crmEnabled);
  merged.testPaymentsOverrideEnabled = Boolean(
    raw.testPaymentsOverrideEnabled ?? DEFAULT_SETTINGS.testPaymentsOverrideEnabled,
  );
  const stripeMode = typeof raw.stripeMode === 'string'
    ? raw.stripeMode.toLowerCase().trim()
    : null;
  merged.stripeMode = (stripeMode === 'test' || stripeMode === 'live') ? stripeMode : null;
  merged.salesBySalesRepCsvDownloadedAt =
    normalizeIsoTimestamp(raw.salesBySalesRepCsvDownloadedAt) ?? DEFAULT_SETTINGS.salesBySalesRepCsvDownloadedAt;
  merged.salesLeadSalesBySalesRepCsvDownloadedAt =
    normalizeIsoTimestamp(raw.salesLeadSalesBySalesRepCsvDownloadedAt)
    ?? DEFAULT_SETTINGS.salesLeadSalesBySalesRepCsvDownloadedAt;
  merged.taxesByStateCsvDownloadedAt =
    normalizeIsoTimestamp(raw.taxesByStateCsvDownloadedAt) ?? DEFAULT_SETTINGS.taxesByStateCsvDownloadedAt;
  merged.productsCommissionCsvDownloadedAt =
    normalizeIsoTimestamp(raw.productsCommissionCsvDownloadedAt) ?? DEFAULT_SETTINGS.productsCommissionCsvDownloadedAt;
  return merged;
};

const loadFromStore = () => normalizeSettings(settingsStore.read());

const persistToStore = (settings) => {
  settingsStore.write(normalizeSettings(settings));
};

const loadFromSql = async () => {
  if (!mysqlClient.isEnabled()) {
    return null;
  }

  try {
    const keysSql = SETTINGS_KEYS.map((key) => `"${key}"`).join(',');
    const rows = await mysqlClient.fetchAll?.(
      `SELECT \`key\`, \`value_json\` FROM settings WHERE \`key\` IN (${keysSql})`,
    );
    if (!rows || !Array.isArray(rows)) {
      return null;
    }
    const merged = { ...DEFAULT_SETTINGS };
    rows.forEach((row) => {
      if (!row || !row.key) return;
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) return;
      if (Object.prototype.hasOwnProperty.call(row, 'value_json')) {
        const raw = row.value_json;
        if (typeof raw === 'string') {
          try {
            merged[row.key] = JSON.parse(raw);
          } catch {
            merged[row.key] = raw;
          }
        } else {
          merged[row.key] = raw;
        }
      }
    });
    return normalizeSettings(merged);
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load settings from MySQL; falling back to file store');
    return null;
  }
};

const persistToSql = async (settings) => {
  if (!mysqlClient.isEnabled()) {
    logger.debug({ mysqlEnabled: false }, 'Settings persist skipped (MySQL disabled)');
    return;
  }
  const normalized = normalizeSettings(settings);
  try {
    logger.debug(
      { keys: SETTINGS_KEYS, mysqlEnabled: true },
      'Persisting settings to MySQL',
    );
    for (const key of SETTINGS_KEYS) {
      const valueJson = JSON.stringify(normalized[key]);
      // eslint-disable-next-line no-await-in-loop
      await mysqlClient.execute(
        `
          INSERT INTO settings (\`key\`, value_json, updated_at)
          VALUES (:key, :value_json, NOW())
          ON DUPLICATE KEY UPDATE
            updated_at = IF(value_json <=> VALUES(value_json), updated_at, NOW()),
            value_json = VALUES(value_json)
        `,
        { key, value_json: valueJson },
      );
      logger.debug({ key }, 'Settings key persisted to MySQL');
    }
  } catch (error) {
    logger.error(
      { err: error, keys: SETTINGS_KEYS, mysqlEnabled: true },
      'Failed to persist settings to MySQL',
    );
    throw error;
  }
};

const getSettings = async () => {
  const sqlSettings = await loadFromSql();
  if (sqlSettings) {
    persistToStore(sqlSettings);
    return sqlSettings;
  }
  return loadFromStore();
};

const getShopEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.shopEnabled);
};

const getBetaServices = async () => {
  const settings = await getSettings();
  return Array.isArray(settings.betaServices) ? settings.betaServices : [];
};

const getPeptideForumEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.peptideForumEnabled);
};

const getPatientLinksEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.patientLinksEnabled);
};

const getResearchDashboardEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.researchDashboardEnabled);
};

const getCrmEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.crmEnabled);
};

const getTestPaymentsOverrideEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.testPaymentsOverrideEnabled);
};

const setShopEnabled = async (enabled) => {
  const base = await getSettings();
  const next = normalizeSettings({ ...(base || loadFromStore()), shopEnabled: Boolean(enabled) });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Boolean(confirmed.shopEnabled);
  }
  persistToStore(next);
  return Boolean(next.shopEnabled);
};

const setBetaServices = async (services) => {
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    betaServices: services,
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Array.isArray(confirmed.betaServices) ? confirmed.betaServices : [];
  }
  persistToStore(next);
  return Array.isArray(next.betaServices) ? next.betaServices : [];
};

const setPeptideForumEnabled = async (enabled) => {
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    peptideForumEnabled: Boolean(enabled),
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Boolean(confirmed.peptideForumEnabled);
  }
  persistToStore(next);
  return Boolean(next.peptideForumEnabled);
};

const setPatientLinksEnabled = async (enabled) => {
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    patientLinksEnabled: Boolean(enabled),
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Boolean(confirmed.patientLinksEnabled);
  }
  persistToStore(next);
  return Boolean(next.patientLinksEnabled);
};

const setResearchDashboardEnabled = async (enabled) => {
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    researchDashboardEnabled: Boolean(enabled),
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Boolean(confirmed.researchDashboardEnabled);
  }
  persistToStore(next);
  return Boolean(next.researchDashboardEnabled);
};

const setCrmEnabled = async (enabled) => {
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    crmEnabled: Boolean(enabled),
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Boolean(confirmed.crmEnabled);
  }
  persistToStore(next);
  return Boolean(next.crmEnabled);
};

const setTestPaymentsOverrideEnabled = async (enabled) => {
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    testPaymentsOverrideEnabled: Boolean(enabled),
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return Boolean(confirmed.testPaymentsOverrideEnabled);
  }
  persistToStore(next);
  return Boolean(next.testPaymentsOverrideEnabled);
};

const resolveStripeMode = (settings) => {
  const override = settings?.stripeMode;
  if (override === 'test' || override === 'live') {
    return override;
  }
  const mode = String(env.stripe?.mode || 'test').toLowerCase().trim();
  return mode === 'live' ? 'live' : 'test';
};

const getStripeMode = async () => {
  const settings = await getSettings();
  return resolveStripeMode(settings);
};

const getStripeModeSync = () => resolveStripeMode(loadFromStore());

const setStripeMode = async (mode) => {
  const normalizedMode = String(mode || '').toLowerCase().trim();
  const value = normalizedMode === 'live' ? 'live' : 'test';
  const base = await getSettings();
  const next = normalizeSettings({ ...(base || loadFromStore()), stripeMode: value });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return resolveStripeMode(confirmed);
  }
  persistToStore(next);
  return resolveStripeMode(next);
};

const getSalesBySalesRepCsvDownloadedAt = async () => {
  const settings = await getSettings();
  return settings.salesBySalesRepCsvDownloadedAt || null;
};

const setSalesBySalesRepCsvDownloadedAt = async (downloadedAt) => {
  const normalized = normalizeIsoTimestamp(downloadedAt) || new Date().toISOString();
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    salesBySalesRepCsvDownloadedAt: normalized,
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return confirmed.salesBySalesRepCsvDownloadedAt || null;
  }
  persistToStore(next);
  return next.salesBySalesRepCsvDownloadedAt || null;
};

const getSalesLeadSalesBySalesRepCsvDownloadedAt = async () => {
  const settings = await getSettings();
  return settings.salesLeadSalesBySalesRepCsvDownloadedAt || null;
};

const setSalesLeadSalesBySalesRepCsvDownloadedAt = async (downloadedAt) => {
  const normalized = normalizeIsoTimestamp(downloadedAt) || new Date().toISOString();
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    salesLeadSalesBySalesRepCsvDownloadedAt: normalized,
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return confirmed.salesLeadSalesBySalesRepCsvDownloadedAt || null;
  }
  persistToStore(next);
  return next.salesLeadSalesBySalesRepCsvDownloadedAt || null;
};

const getTaxesByStateCsvDownloadedAt = async () => {
  const settings = await getSettings();
  return settings.taxesByStateCsvDownloadedAt || null;
};

const setTaxesByStateCsvDownloadedAt = async (downloadedAt) => {
  const normalized = normalizeIsoTimestamp(downloadedAt) || new Date().toISOString();
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    taxesByStateCsvDownloadedAt: normalized,
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return confirmed.taxesByStateCsvDownloadedAt || null;
  }
  persistToStore(next);
  return next.taxesByStateCsvDownloadedAt || null;
};

const getProductsCommissionCsvDownloadedAt = async () => {
  const settings = await getSettings();
  return settings.productsCommissionCsvDownloadedAt || null;
};

const setProductsCommissionCsvDownloadedAt = async (downloadedAt) => {
  const normalized = normalizeIsoTimestamp(downloadedAt) || new Date().toISOString();
  const base = await getSettings();
  const next = normalizeSettings({
    ...(base || loadFromStore()),
    productsCommissionCsvDownloadedAt: normalized,
  });
  if (mysqlClient.isEnabled()) {
    await persistToSql(next);
    const confirmed = (await loadFromSql()) || next;
    persistToStore(confirmed);
    return confirmed.productsCommissionCsvDownloadedAt || null;
  }
  persistToStore(next);
  return next.productsCommissionCsvDownloadedAt || null;
};

const DATABASE_VISUALIZER_DEFAULT_PAGE_SIZE = 25;
const DATABASE_VISUALIZER_MAX_PAGE_SIZE = 100;
const DATABASE_VISUALIZER_UPDATED_AT = '2026-03-25T14:00:00.000Z';

const databaseVisualizerMockTables = [
  {
    name: 'users',
    engine: 'InnoDB',
    dataBytes: 32768,
    indexBytes: 16384,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'varchar(36)', nullable: false, key: 'PRI', defaultValue: null, extra: null, position: 1 },
      { name: 'name', type: 'varchar(255)', nullable: false, key: null, defaultValue: null, extra: null, position: 2 },
      { name: 'email', type: 'varchar(255)', nullable: false, key: 'UNI', defaultValue: null, extra: null, position: 3 },
      { name: 'role', type: 'varchar(64)', nullable: false, key: 'MUL', defaultValue: 'doctor', extra: null, position: 4 },
      { name: 'status', type: 'varchar(32)', nullable: false, key: null, defaultValue: 'active', extra: null, position: 5 },
      { name: 'salesRepId', type: 'varchar(36)', nullable: true, key: 'MUL', defaultValue: null, extra: null, position: 6 },
      { name: 'lastLoginAt', type: 'datetime', nullable: true, key: null, defaultValue: null, extra: null, position: 7 },
      { name: 'createdAt', type: 'datetime', nullable: false, key: null, defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED', position: 8 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'users_email_unique', unique: true, columns: ['email'] },
      { name: 'users_role_idx', unique: false, columns: ['role'] },
      { name: 'users_sales_rep_idx', unique: false, columns: ['salesRepId'] },
    ],
    relationships: {
      imports: [],
      exports: [
        {
          constraintName: 'orders_user_id_fk',
          sourceTable: 'orders',
          sourceColumn: 'userId',
          referencedColumn: 'id',
          updateRule: 'CASCADE',
          deleteRule: 'SET NULL',
        },
      ],
    },
    createStatement: `CREATE TABLE \`users\` (
  \`id\` varchar(36) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`email\` varchar(255) NOT NULL,
  \`role\` varchar(64) NOT NULL DEFAULT 'doctor',
  \`status\` varchar(32) NOT NULL DEFAULT 'active',
  \`salesRepId\` varchar(36) DEFAULT NULL,
  \`lastLoginAt\` datetime DEFAULT NULL,
  \`createdAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`users_email_unique\` (\`email\`),
  KEY \`users_role_idx\` (\`role\`),
  KEY \`users_sales_rep_idx\` (\`salesRepId\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 'admin-001', name: 'Linden Mosk', email: 'linden@peppro.net', role: 'admin', status: 'active', salesRepId: null, lastLoginAt: '2026-03-25T13:42:00.000Z', createdAt: '2025-11-01T08:15:00.000Z' },
      { id: 'sales-014', name: 'Courtney Gillenwater', email: 'courtney@peppro.net', role: 'sales_rep', status: 'active', salesRepId: 'sales-014', lastLoginAt: '2026-03-25T12:11:00.000Z', createdAt: '2025-09-12T10:20:00.000Z' },
      { id: 'doctor-201', name: 'Avery Stone', email: 'avery.stone@example.com', role: 'doctor', status: 'active', salesRepId: 'sales-014', lastLoginAt: '2026-03-25T11:00:00.000Z', createdAt: '2026-01-05T15:31:00.000Z' },
      { id: 'doctor-202', name: 'Jordan Miles', email: 'jordan.miles@example.com', role: 'doctor', status: 'pending', salesRepId: 'sales-014', lastLoginAt: null, createdAt: '2026-02-08T09:04:00.000Z' },
      { id: 'doctor-203', name: 'Riley Quinn', email: 'riley.quinn@example.com', role: 'test_doctor', status: 'active', salesRepId: null, lastLoginAt: '2026-03-24T18:22:00.000Z', createdAt: '2026-02-14T17:40:00.000Z' },
    ],
  },
  {
    name: 'orders',
    engine: 'InnoDB',
    dataBytes: 49152,
    indexBytes: 16384,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'varchar(36)', nullable: false, key: 'PRI', defaultValue: null, extra: null, position: 1 },
      { name: 'orderNumber', type: 'varchar(32)', nullable: false, key: 'UNI', defaultValue: null, extra: null, position: 2 },
      { name: 'userId', type: 'varchar(36)', nullable: true, key: 'MUL', defaultValue: null, extra: null, position: 3 },
      { name: 'status', type: 'varchar(32)', nullable: false, key: 'MUL', defaultValue: 'processing', extra: null, position: 4 },
      { name: 'subtotal', type: 'decimal(10,2)', nullable: false, key: null, defaultValue: '0.00', extra: null, position: 5 },
      { name: 'paymentMethod', type: 'varchar(64)', nullable: true, key: null, defaultValue: null, extra: null, position: 6 },
      { name: 'createdAt', type: 'datetime', nullable: false, key: 'MUL', defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED', position: 7 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'orders_order_number_unique', unique: true, columns: ['orderNumber'] },
      { name: 'orders_user_idx', unique: false, columns: ['userId'] },
      { name: 'orders_status_created_idx', unique: false, columns: ['status', 'createdAt'] },
    ],
    relationships: {
      imports: [
        {
          constraintName: 'orders_user_id_fk',
          columnName: 'userId',
          referencedTable: 'users',
          referencedColumn: 'id',
          updateRule: 'CASCADE',
          deleteRule: 'SET NULL',
        },
      ],
      exports: [
        {
          constraintName: 'order_items_order_id_fk',
          sourceTable: 'order_items',
          sourceColumn: 'orderId',
          referencedColumn: 'id',
          updateRule: 'CASCADE',
          deleteRule: 'CASCADE',
        },
      ],
    },
    createStatement: `CREATE TABLE \`orders\` (
  \`id\` varchar(36) NOT NULL,
  \`orderNumber\` varchar(32) NOT NULL,
  \`userId\` varchar(36) DEFAULT NULL,
  \`status\` varchar(32) NOT NULL DEFAULT 'processing',
  \`subtotal\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`paymentMethod\` varchar(64) DEFAULT NULL,
  \`createdAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`orders_order_number_unique\` (\`orderNumber\`),
  KEY \`orders_user_idx\` (\`userId\`),
  KEY \`orders_status_created_idx\` (\`status\`,\`createdAt\`),
  CONSTRAINT \`orders_user_id_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 'ord-1001', orderNumber: 'PP-1001', userId: 'doctor-201', status: 'processing', subtotal: 349.5, paymentMethod: 'card', createdAt: '2026-03-23T14:11:00.000Z' },
      { id: 'ord-1002', orderNumber: 'PP-1002', userId: 'doctor-202', status: 'pending_payment', subtotal: 118, paymentMethod: 'zelle', createdAt: '2026-03-24T09:32:00.000Z' },
      { id: 'ord-1003', orderNumber: 'PP-1003', userId: 'doctor-201', status: 'complete', subtotal: 642.75, paymentMethod: 'bank_transfer', createdAt: '2026-03-24T16:48:00.000Z' },
      { id: 'ord-1004', orderNumber: 'PP-1004', userId: 'doctor-203', status: 'shipped', subtotal: 89, paymentMethod: 'card', createdAt: '2026-03-25T08:05:00.000Z' },
    ],
  },
  {
    name: 'order_items',
    engine: 'InnoDB',
    dataBytes: 24576,
    indexBytes: 8192,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'varchar(36)', nullable: false, key: 'PRI', defaultValue: null, extra: null, position: 1 },
      { name: 'orderId', type: 'varchar(36)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 2 },
      { name: 'sku', type: 'varchar(64)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 3 },
      { name: 'productName', type: 'varchar(255)', nullable: false, key: null, defaultValue: null, extra: null, position: 4 },
      { name: 'quantity', type: 'int', nullable: false, key: null, defaultValue: '1', extra: null, position: 5 },
      { name: 'unitPrice', type: 'decimal(10,2)', nullable: false, key: null, defaultValue: '0.00', extra: null, position: 6 },
      { name: 'createdAt', type: 'datetime', nullable: false, key: null, defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED', position: 7 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'order_items_order_idx', unique: false, columns: ['orderId'] },
      { name: 'order_items_sku_idx', unique: false, columns: ['sku'] },
    ],
    relationships: {
      imports: [
        {
          constraintName: 'order_items_order_id_fk',
          columnName: 'orderId',
          referencedTable: 'orders',
          referencedColumn: 'id',
          updateRule: 'CASCADE',
          deleteRule: 'CASCADE',
        },
      ],
      exports: [],
    },
    createStatement: `CREATE TABLE \`order_items\` (
  \`id\` varchar(36) NOT NULL,
  \`orderId\` varchar(36) NOT NULL,
  \`sku\` varchar(64) NOT NULL,
  \`productName\` varchar(255) NOT NULL,
  \`quantity\` int NOT NULL DEFAULT 1,
  \`unitPrice\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`createdAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`order_items_order_idx\` (\`orderId\`),
  KEY \`order_items_sku_idx\` (\`sku\`),
  CONSTRAINT \`order_items_order_id_fk\` FOREIGN KEY (\`orderId\`) REFERENCES \`orders\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 'item-01', orderId: 'ord-1001', sku: 'BPC-157-10MG', productName: 'BPC-157 10mg', quantity: 3, unitPrice: 49.5, createdAt: '2026-03-23T14:11:10.000Z' },
      { id: 'item-02', orderId: 'ord-1001', sku: 'TB-500-10MG', productName: 'TB-500 10mg', quantity: 2, unitPrice: 100.5, createdAt: '2026-03-23T14:11:12.000Z' },
      { id: 'item-03', orderId: 'ord-1003', sku: 'RETATRUTIDE-5MG', productName: 'Retatrutide 5mg', quantity: 5, unitPrice: 128.55, createdAt: '2026-03-24T16:48:20.000Z' },
      { id: 'item-04', orderId: 'ord-1004', sku: 'NAD-500MG', productName: 'NAD+ 500mg', quantity: 1, unitPrice: 89, createdAt: '2026-03-25T08:05:15.000Z' },
    ],
  },
  {
    name: 'settings_audit',
    engine: 'InnoDB',
    dataBytes: 16384,
    indexBytes: 8192,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'bigint', nullable: false, key: 'PRI', defaultValue: null, extra: 'auto_increment', position: 1 },
      { name: 'settingKey', type: 'varchar(128)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 2 },
      { name: 'changedByUserId', type: 'varchar(36)', nullable: true, key: 'MUL', defaultValue: null, extra: null, position: 3 },
      { name: 'oldValue', type: 'json', nullable: true, key: null, defaultValue: null, extra: null, position: 4 },
      { name: 'newValue', type: 'json', nullable: true, key: null, defaultValue: null, extra: null, position: 5 },
      { name: 'changedAt', type: 'datetime', nullable: false, key: 'MUL', defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED', position: 6 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'settings_audit_key_idx', unique: false, columns: ['settingKey'] },
      { name: 'settings_audit_user_idx', unique: false, columns: ['changedByUserId'] },
    ],
    relationships: {
      imports: [
        {
          constraintName: 'settings_audit_changed_by_fk',
          columnName: 'changedByUserId',
          referencedTable: 'users',
          referencedColumn: 'id',
          updateRule: 'CASCADE',
          deleteRule: 'SET NULL',
        },
      ],
      exports: [],
    },
    createStatement: `CREATE TABLE \`settings_audit\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`settingKey\` varchar(128) NOT NULL,
  \`changedByUserId\` varchar(36) DEFAULT NULL,
  \`oldValue\` json DEFAULT NULL,
  \`newValue\` json DEFAULT NULL,
  \`changedAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`settings_audit_key_idx\` (\`settingKey\`),
  KEY \`settings_audit_user_idx\` (\`changedByUserId\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 1, settingKey: 'shopEnabled', changedByUserId: 'admin-001', oldValue: '{"enabled":false}', newValue: '{"enabled":true}', changedAt: '2026-03-20T12:00:00.000Z' },
      { id: 2, settingKey: 'researchDashboardEnabled', changedByUserId: 'admin-001', oldValue: '{"enabled":false}', newValue: '{"enabled":true}', changedAt: '2026-03-22T17:44:00.000Z' },
      { id: 3, settingKey: 'patientLinksEnabled', changedByUserId: 'admin-001', oldValue: '{"enabled":true}', newValue: '{"enabled":false}', changedAt: '2026-03-24T08:31:00.000Z' },
    ],
  },
  {
    name: 'patient_link_audit_events_archive',
    engine: 'InnoDB',
    dataBytes: 20480,
    indexBytes: 8192,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'bigint', nullable: false, key: 'PRI', defaultValue: null, extra: 'auto_increment', position: 1 },
      { name: 'patientLinkId', type: 'varchar(36)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 2 },
      { name: 'eventType', type: 'varchar(64)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 3 },
      { name: 'payloadJson', type: 'json', nullable: true, key: null, defaultValue: null, extra: null, position: 4 },
      { name: 'createdAt', type: 'datetime', nullable: false, key: 'MUL', defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED', position: 5 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'patient_link_audit_events_archive_link_idx', unique: false, columns: ['patientLinkId'] },
      { name: 'patient_link_audit_events_archive_type_idx', unique: false, columns: ['eventType'] },
    ],
    relationships: { imports: [], exports: [] },
    createStatement: `CREATE TABLE \`patient_link_audit_events_archive\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`patientLinkId\` varchar(36) NOT NULL,
  \`eventType\` varchar(64) NOT NULL,
  \`payloadJson\` json DEFAULT NULL,
  \`createdAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`patient_link_audit_events_archive_link_idx\` (\`patientLinkId\`),
  KEY \`patient_link_audit_events_archive_type_idx\` (\`eventType\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 101, patientLinkId: 'plink-1001', eventType: 'invite_sent', payloadJson: '{"channel":"email","recipient":"patient@example.com"}', createdAt: '2026-03-23T09:20:00.000Z' },
      { id: 102, patientLinkId: 'plink-1001', eventType: 'intake_submitted', payloadJson: '{"status":"completed"}', createdAt: '2026-03-24T13:02:00.000Z' },
    ],
  },
  {
    name: 'sales_rep_commission_adjustment_history',
    engine: 'InnoDB',
    dataBytes: 24576,
    indexBytes: 12288,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'bigint', nullable: false, key: 'PRI', defaultValue: null, extra: 'auto_increment', position: 1 },
      { name: 'salesRepId', type: 'varchar(36)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 2 },
      { name: 'adjustmentType', type: 'varchar(64)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 3 },
      { name: 'amountDelta', type: 'decimal(10,2)', nullable: false, key: null, defaultValue: '0.00', extra: null, position: 4 },
      { name: 'reason', type: 'varchar(255)', nullable: true, key: null, defaultValue: null, extra: null, position: 5 },
      { name: 'createdAt', type: 'datetime', nullable: false, key: 'MUL', defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED', position: 6 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'sales_rep_commission_adjustment_history_rep_idx', unique: false, columns: ['salesRepId'] },
      { name: 'sales_rep_commission_adjustment_history_type_idx', unique: false, columns: ['adjustmentType'] },
    ],
    relationships: { imports: [], exports: [] },
    createStatement: `CREATE TABLE \`sales_rep_commission_adjustment_history\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`salesRepId\` varchar(36) NOT NULL,
  \`adjustmentType\` varchar(64) NOT NULL,
  \`amountDelta\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`reason\` varchar(255) DEFAULT NULL,
  \`createdAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`sales_rep_commission_adjustment_history_rep_idx\` (\`salesRepId\`),
  KEY \`sales_rep_commission_adjustment_history_type_idx\` (\`adjustmentType\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 201, salesRepId: 'sales-014', adjustmentType: 'manual_bonus', amountDelta: 125.0, reason: 'Quarter-end performance adjustment', createdAt: '2026-03-21T16:00:00.000Z' },
      { id: 202, salesRepId: 'sales-014', adjustmentType: 'chargeback_offset', amountDelta: -42.5, reason: 'Refund reversal correction', createdAt: '2026-03-24T10:15:00.000Z' },
    ],
  },
  {
    name: 'physician_network_invitation_delivery_queue',
    engine: 'InnoDB',
    dataBytes: 16384,
    indexBytes: 8192,
    updatedAt: DATABASE_VISUALIZER_UPDATED_AT,
    columns: [
      { name: 'id', type: 'varchar(36)', nullable: false, key: 'PRI', defaultValue: null, extra: null, position: 1 },
      { name: 'recipientEmail', type: 'varchar(255)', nullable: false, key: 'MUL', defaultValue: null, extra: null, position: 2 },
      { name: 'deliveryStatus', type: 'varchar(32)', nullable: false, key: 'MUL', defaultValue: 'queued', extra: null, position: 3 },
      { name: 'retryCount', type: 'int', nullable: false, key: null, defaultValue: '0', extra: null, position: 4 },
      { name: 'scheduledFor', type: 'datetime', nullable: true, key: null, defaultValue: null, extra: null, position: 5 },
    ],
    indexes: [
      { name: 'PRIMARY', unique: true, columns: ['id'] },
      { name: 'physician_network_invitation_delivery_queue_email_idx', unique: false, columns: ['recipientEmail'] },
      { name: 'physician_network_invitation_delivery_queue_status_idx', unique: false, columns: ['deliveryStatus'] },
    ],
    relationships: { imports: [], exports: [] },
    createStatement: `CREATE TABLE \`physician_network_invitation_delivery_queue\` (
  \`id\` varchar(36) NOT NULL,
  \`recipientEmail\` varchar(255) NOT NULL,
  \`deliveryStatus\` varchar(32) NOT NULL DEFAULT 'queued',
  \`retryCount\` int NOT NULL DEFAULT 0,
  \`scheduledFor\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`physician_network_invitation_delivery_queue_email_idx\` (\`recipientEmail\`),
  KEY \`physician_network_invitation_delivery_queue_status_idx\` (\`deliveryStatus\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    rows: [
      { id: 'queue-001', recipientEmail: 'clinic-admin@example.com', deliveryStatus: 'queued', retryCount: 0, scheduledFor: '2026-03-25T18:00:00.000Z' },
      { id: 'queue-002', recipientEmail: 'doctor-onboarding@example.com', deliveryStatus: 'retrying', retryCount: 2, scheduledFor: '2026-03-25T18:15:00.000Z' },
    ],
  },
];

const normalizePage = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const normalizePageSize = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DATABASE_VISUALIZER_DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(DATABASE_VISUALIZER_MAX_PAGE_SIZE, parsed));
};

const normalizeSortDirection = (value) => (String(value || '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc');

const compareValues = (left, right) => {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    if (left === right) return 0;
    return left ? 1 : -1;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
};

const serializeDatabaseVisualizerCell = (value) => ({
  value: value == null ? null : value,
  decrypted: false,
});

const getDatabaseVisualizerMockPayload = ({
  tableName = null,
  page = 1,
  pageSize = DATABASE_VISUALIZER_DEFAULT_PAGE_SIZE,
  sortColumn = null,
  sortDirection = 'asc',
  searchTerm = null,
} = {}) => {
  const normalizedRequestedTable = String(tableName || '').trim();
  const tables = databaseVisualizerMockTables.map((table) => ({
    name: table.name,
    rowCount: table.rows.length,
    columnCount: table.columns.length,
    engine: table.engine,
    dataBytes: table.dataBytes,
    indexBytes: table.indexBytes,
    updatedAt: table.updatedAt,
  }));

  const selectedSource =
    databaseVisualizerMockTables.find((table) => table.name === normalizedRequestedTable)
    || databaseVisualizerMockTables[0]
    || null;

  if (!selectedSource) {
    return {
      mysqlEnabled: false,
      databaseName: 'PepPro Mock',
      hostScope: 'local',
      refreshedAt: new Date().toISOString(),
      tables,
      selectedTable: null,
    };
  }

  const normalizedPage = normalizePage(page);
  const normalizedPageSize = normalizePageSize(pageSize);
  const normalizedSearchTerm = String(searchTerm || '').trim();
  const selectedColumnNames = selectedSource.columns.map((column) => column.name);
  const searchableColumns = selectedColumnNames.slice();
  const defaultSortColumn = selectedColumnNames[0] || null;
  const normalizedSortColumn = selectedColumnNames.includes(String(sortColumn || '').trim())
    ? String(sortColumn || '').trim()
    : defaultSortColumn;
  const normalizedSortDirection = normalizeSortDirection(sortDirection);

  const filteredRows = normalizedSearchTerm
    ? selectedSource.rows.filter((row) =>
        searchableColumns.some((columnName) =>
          String(row[columnName] == null ? '' : row[columnName])
            .toLowerCase()
            .includes(normalizedSearchTerm.toLowerCase()),
        ))
    : selectedSource.rows.slice();

  filteredRows.sort((left, right) => {
    const comparison = compareValues(left[normalizedSortColumn], right[normalizedSortColumn]);
    return normalizedSortDirection === 'desc' ? comparison * -1 : comparison;
  });

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / normalizedPageSize));
  const currentPage = Math.min(normalizedPage, totalPages);
  const offset = (currentPage - 1) * normalizedPageSize;
  const visibleRows = filteredRows.slice(offset, offset + normalizedPageSize);

  return {
    mysqlEnabled: false,
    databaseName: 'PepPro Mock',
    hostScope: 'local',
    refreshedAt: new Date().toISOString(),
    tables,
    selectedTable: {
      name: selectedSource.name,
      rowCount: selectedSource.rows.length,
      columnCount: selectedSource.columns.length,
      engine: selectedSource.engine,
      dataBytes: selectedSource.dataBytes,
      indexBytes: selectedSource.indexBytes,
      updatedAt: selectedSource.updatedAt,
      columns: selectedSource.columns,
      indexes: selectedSource.indexes,
      relationships: selectedSource.relationships,
      createStatement: selectedSource.createStatement,
      preview: {
        page: currentPage,
        pageSize: normalizedPageSize,
        totalRowCount: selectedSource.rows.length,
        filteredRowCount: filteredRows.length,
        totalPages,
        sortColumn: normalizedSortColumn,
        sortDirection: normalizedSortDirection,
        searchTerm: normalizedSearchTerm || null,
        searchableColumns,
        rows: visibleRows.map((row, index) => ({
          rowNumber: offset + index + 1,
          values: Object.fromEntries(
            selectedColumnNames.map((columnName) => [
              columnName,
              serializeDatabaseVisualizerCell(row[columnName]),
            ]),
          ),
        })),
      },
    },
  };
};

module.exports = {
  getSettings,
  getShopEnabled,
  setShopEnabled,
  getBetaServices,
  setBetaServices,
  getPatientLinksEnabled,
  setPatientLinksEnabled,
  getPeptideForumEnabled,
  setPeptideForumEnabled,
  getResearchDashboardEnabled,
  setResearchDashboardEnabled,
  getCrmEnabled,
  setCrmEnabled,
  getTestPaymentsOverrideEnabled,
  setTestPaymentsOverrideEnabled,
  getStripeMode,
  getStripeModeSync,
  setStripeMode,
  getSalesBySalesRepCsvDownloadedAt,
  setSalesBySalesRepCsvDownloadedAt,
  getSalesLeadSalesBySalesRepCsvDownloadedAt,
  setSalesLeadSalesBySalesRepCsvDownloadedAt,
  getTaxesByStateCsvDownloadedAt,
  setTaxesByStateCsvDownloadedAt,
  getProductsCommissionCsvDownloadedAt,
  setProductsCommissionCsvDownloadedAt,
  getDatabaseVisualizerMockPayload,
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
};
