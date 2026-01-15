const mysqlClient = require('../database/mysqlClient');
const { settingsStore } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');

const DEFAULT_SETTINGS = {
  shopEnabled: true,
  peptideForumEnabled: true,
  researchDashboardEnabled: false,
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
  const raw = settings && typeof settings === 'object' ? settings : {};
  const merged = { ...DEFAULT_SETTINGS };
  merged.shopEnabled = Boolean(raw.shopEnabled ?? DEFAULT_SETTINGS.shopEnabled);
  merged.peptideForumEnabled = Boolean(
    raw.peptideForumEnabled ?? DEFAULT_SETTINGS.peptideForumEnabled,
  );
  merged.researchDashboardEnabled = Boolean(
    raw.researchDashboardEnabled ?? DEFAULT_SETTINGS.researchDashboardEnabled,
  );
  const stripeMode = typeof raw.stripeMode === 'string'
    ? raw.stripeMode.toLowerCase().trim()
    : null;
  merged.stripeMode = (stripeMode === 'test' || stripeMode === 'live') ? stripeMode : null;
  merged.salesBySalesRepCsvDownloadedAt =
    normalizeIsoTimestamp(raw.salesBySalesRepCsvDownloadedAt) ?? DEFAULT_SETTINGS.salesBySalesRepCsvDownloadedAt;
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

const getPeptideForumEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.peptideForumEnabled);
};

const getResearchDashboardEnabled = async () => {
  const settings = await getSettings();
  return Boolean(settings.researchDashboardEnabled);
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

module.exports = {
  getSettings,
  getShopEnabled,
  setShopEnabled,
  getPeptideForumEnabled,
  setPeptideForumEnabled,
  getResearchDashboardEnabled,
  setResearchDashboardEnabled,
  getStripeMode,
  getStripeModeSync,
  setStripeMode,
  getSalesBySalesRepCsvDownloadedAt,
  setSalesBySalesRepCsvDownloadedAt,
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
};
