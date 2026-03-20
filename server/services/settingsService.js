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
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
};
