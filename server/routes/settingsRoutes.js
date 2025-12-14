const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const { getShopEnabled, setShopEnabled, getStripeMode, setStripeMode } = require('../services/settingsService');
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

module.exports = router;
