const mysqlClient = require('../database/mysqlClient');
const { settingsStore } = require('../storage');
const { logger } = require('../config/logger');

const DEFAULT_SETTINGS = {
  shopEnabled: true,
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

const normalizeSettings = (settings = {}) => {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  merged.shopEnabled = Boolean(merged.shopEnabled);
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
    const rows = await mysqlClient.fetchAll?.(
      'SELECT `key`, `value_json` FROM settings WHERE `key` IN ("shopEnabled")',
    );
    if (!rows || !Array.isArray(rows)) {
      return null;
    }
    const merged = { ...DEFAULT_SETTINGS };
    rows.forEach((row) => {
      if (!row || !row.key) return;
      if (row.value_json && Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) {
        merged[row.key] = row.value_json;
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
    return;
  }
  const normalized = normalizeSettings(settings);
  try {
    await mysqlClient.execute(
      `
        INSERT INTO settings (\`key\`, value_json, updated_at)
        VALUES (:key, :value_json, NOW())
        ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = NOW()
      `,
      { key: 'shopEnabled', value_json: normalized.shopEnabled },
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist settings to MySQL');
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

module.exports = {
  getSettings,
  getShopEnabled,
  setShopEnabled,
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
};
