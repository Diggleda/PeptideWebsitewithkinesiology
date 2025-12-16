const mysqlClient = require('../database/mysqlClient');
const { settingsStore } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');

const DEFAULT_SETTINGS = {
  shopEnabled: true,
  stripeMode: null, // null = follow env
  salesBySalesRepCsvDownloadedAt: null, // ISO timestamp (admin report)
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

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
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  merged.shopEnabled = Boolean(merged.shopEnabled);
  const stripeMode = typeof merged.stripeMode === 'string'
    ? merged.stripeMode.toLowerCase().trim()
    : null;
  merged.stripeMode = (stripeMode === 'test' || stripeMode === 'live') ? stripeMode : null;
  merged.salesBySalesRepCsvDownloadedAt = normalizeIsoTimestamp(
    merged.salesBySalesRepCsvDownloadedAt,
  );
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

const setShopEnabled = async (enabled) => {
  const next = normalizeSettings({ ...loadFromStore(), shopEnabled: Boolean(enabled) });
  persistToStore(next);
  await persistToSql(next);
  return next.shopEnabled;
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
  const next = normalizeSettings({ ...loadFromStore(), stripeMode: value });
  persistToStore(next);
  await persistToSql(next);
  return resolveStripeMode(next);
};

const getSalesBySalesRepCsvDownloadedAt = async () => {
  const settings = await getSettings();
  return settings.salesBySalesRepCsvDownloadedAt || null;
};

const setSalesBySalesRepCsvDownloadedAt = async (downloadedAt) => {
  const normalized = normalizeIsoTimestamp(downloadedAt) || new Date().toISOString();
  const next = normalizeSettings({
    ...loadFromStore(),
    salesBySalesRepCsvDownloadedAt: normalized,
  });
  persistToStore(next);
  await persistToSql(next);
  return next.salesBySalesRepCsvDownloadedAt;
};

module.exports = {
  getSettings,
  getShopEnabled,
  setShopEnabled,
  getStripeMode,
  getStripeModeSync,
  setStripeMode,
  getSalesBySalesRepCsvDownloadedAt,
  setSalesBySalesRepCsvDownloadedAt,
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
};
