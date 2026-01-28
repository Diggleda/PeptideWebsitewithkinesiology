const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const {
  getShopEnabled,
  setShopEnabled,
  getStripeMode,
  setStripeMode,
  getSalesBySalesRepCsvDownloadedAt,
  setSalesBySalesRepCsvDownloadedAt,
} = require('../services/settingsService');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const userRepository = require('../repositories/userRepository');

const router = Router();

const normalizeRole = (role) => (role || '').toLowerCase();
const isAdmin = (role) => normalizeRole(role) === 'admin';

const requireAdmin = (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = userRepository.findById(userId);
  const role = normalizeRole(user?.role);
  if (!isAdmin(role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.currentUser = user;
  return next();
};

const resolvePublishableKey = (mode) => {
  const normalized = String(mode || '').toLowerCase().trim() === 'live' ? 'live' : 'test';
  const liveKey = env.stripe?.livePublishableKey || env.stripe?.publishableKey || '';
  const testKey = env.stripe?.testPublishableKey || '';
  if (normalized === 'live') {
    return liveKey;
  }
  return testKey || liveKey;
};

router.get('/shop', async (_req, res) => {
  const enabled = await getShopEnabled();
  res.json({ shopEnabled: enabled });
});

router.put('/shop', authenticate, requireAdmin, async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const updated = await setShopEnabled(enabled);
  res.json({ shopEnabled: updated });
});

router.get('/stripe', async (_req, res) => {
  const mode = await getStripeMode();
  logger.debug({ mode, mysqlEnabled: mysqlClient.isEnabled() }, 'Stripe settings requested');
  res.json({
    stripeMode: mode,
    stripeTestMode: mode === 'test',
    onsiteEnabled: Boolean(env.stripe?.onsiteEnabled),
    publishableKey: resolvePublishableKey(mode),
    publishableKeyLive: env.stripe?.livePublishableKey || '',
    publishableKeyTest: env.stripe?.testPublishableKey || '',
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

router.get('/reports', authenticate, requireAdmin, async (_req, res) => {
  const downloadedAt = await getSalesBySalesRepCsvDownloadedAt();
  res.json({ salesBySalesRepCsvDownloadedAt: downloadedAt });
});

router.put('/reports', authenticate, requireAdmin, async (req, res) => {
  const downloadedAt = req.body?.salesBySalesRepCsvDownloadedAt || req.body?.downloadedAt;
  const updated = await setSalesBySalesRepCsvDownloadedAt(downloadedAt);
  res.json({ salesBySalesRepCsvDownloadedAt: updated });
});

router.put('/stripe', authenticate, requireAdmin, async (req, res) => {
  const rawMode = req.body?.mode;
  const testMode = req.body?.testMode;
  const mode = typeof rawMode === 'string'
    ? rawMode
    : (testMode === true ? 'test' : 'live');
  logger.info(
    {
      requestedMode: mode,
      mysqlEnabled: mysqlClient.isEnabled(),
      userId: req.user?.id || null,
    },
    'Stripe settings update requested',
  );
  const updated = await setStripeMode(mode);
  res.json({
    stripeMode: updated,
    stripeTestMode: updated === 'test',
    onsiteEnabled: Boolean(env.stripe?.onsiteEnabled),
    publishableKey: resolvePublishableKey(updated),
    publishableKeyLive: env.stripe?.livePublishableKey || '',
    publishableKeyTest: env.stripe?.testPublishableKey || '',
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

const parseActivityWindow = (raw) => {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'hour' || normalized === '1h' || normalized === 'last_hour') return 'hour';
  if (normalized === 'day' || normalized === '1d' || normalized === 'last_day') return 'day';
  if (normalized === '3days' || normalized === '3d' || normalized === '3_days') return '3days';
  if (normalized === 'week' || normalized === '7d' || normalized === 'last_week') return 'week';
  if (normalized === 'month' || normalized === '30d' || normalized === 'last_month') return 'month';
  if (normalized === '6months' || normalized === '6mo' || normalized === 'half_year') return '6months';
  if (normalized === 'year' || normalized === '12mo' || normalized === '365d' || normalized === 'last_year') return 'year';
  return 'day';
};

const windowMs = (windowKey) => {
  switch (windowKey) {
    case 'hour':
      return 60 * 60 * 1000;
    case 'day':
      return 24 * 60 * 60 * 1000;
    case '3days':
      return 3 * 24 * 60 * 60 * 1000;
    case 'week':
      return 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return 30 * 24 * 60 * 60 * 1000;
    case '6months':
      return 182 * 24 * 60 * 60 * 1000;
    case 'year':
      return 365 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
};

const normalizeUserRole = (role) => String(role || '').trim().toLowerCase() || 'unknown';

router.get('/user-activity', authenticate, requireAdmin, async (req, res) => {
  const windowKey = parseActivityWindow(req.query?.window);
  const cutoffMs = Date.now() - windowMs(windowKey);

  const users = userRepository.getAll();
  const recent = users
    .filter((user) => {
      const raw = user?.lastLoginAt;
      if (!raw) return false;
      const ts = Date.parse(raw);
      if (Number.isNaN(ts)) return false;
      return ts >= cutoffMs;
    })
    .map((user) => ({
      id: user.id,
      name: user.name || null,
      email: user.email || null,
      role: normalizeUserRole(user.role),
      lastLoginAt: user.lastLoginAt || null,
    }))
    .sort((a, b) => Date.parse(b.lastLoginAt || '') - Date.parse(a.lastLoginAt || ''));

  const byRole = recent.reduce((acc, user) => {
    const role = user.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});

  res.json({
    window: windowKey,
    generatedAt: new Date().toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    total: recent.length,
    byRole,
    users: recent,
  });
});

module.exports = router;
