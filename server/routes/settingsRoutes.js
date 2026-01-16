const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const {
  getShopEnabled,
  setShopEnabled,
  getPeptideForumEnabled,
  setPeptideForumEnabled,
  getResearchDashboardEnabled,
  setResearchDashboardEnabled,
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
  res.json({ shopEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/forum', async (_req, res) => {
  const enabled = await getPeptideForumEnabled();
  res.json({ peptideForumEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/research', async (_req, res) => {
  const enabled = await getResearchDashboardEnabled();
  res.json({ researchDashboardEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/shop', authenticate, requireAdmin, async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const confirmed = await setShopEnabled(enabled);
  res.json({ shopEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/forum', authenticate, requireAdmin, async (req, res) => {
  const enabled = req.body?.peptideForumEnabled ?? req.body?.enabled;
  const confirmed = await setPeptideForumEnabled(Boolean(enabled));
  res.json({ peptideForumEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/research', authenticate, requireAdmin, async (req, res) => {
  const enabled = req.body?.researchDashboardEnabled ?? req.body?.enabled;
  const confirmed = await setResearchDashboardEnabled(Boolean(enabled));
  res.json({ researchDashboardEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
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
  await setStripeMode(mode);
  const updated = await getStripeMode();
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
const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));
const fallbackLiveUsers = [
  {
    id: 'pseudo-live-1',
    name: 'Courtney Gillenwater',
    email: 'demo.live1@peppro.net',
    role: 'sales_rep',
  },
  {
    id: 'pseudo-live-2',
    name: 'Linden Mosk',
    email: 'demo.live2@peppro.net',
    role: 'admin',
  },
  {
    id: 'pseudo-live-3',
    name: 'Avery Stone',
    email: 'demo.live3@peppro.net',
    role: 'doctor',
  },
  {
    id: 'pseudo-live-4',
    name: 'Jordan Miles',
    email: 'demo.live4@peppro.net',
    role: 'sales_rep',
  },
  {
    id: 'pseudo-live-5',
    name: 'Riley Quinn',
    email: 'demo.live5@peppro.net',
    role: 'doctor',
  },
];

router.get('/user-activity', authenticate, requireAdmin, async (req, res) => {
  const windowKey = parseActivityWindow(req.query?.window);
  const cutoffMs = Date.now() - windowMs(windowKey);
  const nowMs = Date.now();
  const onlineThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_ONLINE_THRESHOLD_MINUTES, 45),
    1,
    24 * 60,
  );
  const idleThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_IDLE_THRESHOLD_MINUTES, 5),
    1,
    12 * 60,
  );
  const pseudoLiveEnabled = String(
    process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS || 'true',
  ).toLowerCase() !== 'false';
  const pseudoLiveCount = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS_COUNT, 4),
    1,
    12,
  );
  const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
  const idleThresholdMs = idleThresholdMinutes * 60 * 1000;

  const users = userRepository.getAll();
  const normalized = users.map((user) => {
    const lastLoginAt = user?.lastLoginAt || null;
    const lastLoginMs = lastLoginAt ? Date.parse(lastLoginAt) : NaN;
    const hasLoginTs = Number.isFinite(lastLoginMs);
    const lastSeenAt = user?.lastSeenAt || lastLoginAt || null;
    const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
    const hasSeenTs = Number.isFinite(lastSeenMs);
    const lastInteractionAt = user?.lastInteractionAt || null;
    const lastInteractionMs = lastInteractionAt ? Date.parse(lastInteractionAt) : NaN;
    const hasInteractionTs = Number.isFinite(lastInteractionMs);

    // Online is derived from recent presence. Do not trust a persisted `isOnline` flag,
    // since it can become stale (e.g., a tab closed without cleanup).
    const isOnline =
      (hasSeenTs && (nowMs - lastSeenMs) <= onlineThresholdMs)
      || (!hasSeenTs && hasLoginTs && (nowMs - lastLoginMs) <= onlineThresholdMs);

    const explicitIdle = typeof user?.isIdle === 'boolean' ? user.isIdle : null;
    const idleAnchorMs = hasInteractionTs ? lastInteractionMs : (hasSeenTs ? lastSeenMs : lastLoginMs);
    const hasIdleAnchor = Number.isFinite(idleAnchorMs);
    const computedIdle = isOnline && hasIdleAnchor ? (nowMs - idleAnchorMs) >= idleThresholdMs : null;
    return {
      id: user.id,
      name: user.name || null,
      email: user.email || null,
      role: normalizeUserRole(user.role),
      isOnline,
      isIdle: explicitIdle ?? computedIdle,
      lastLoginAt,
      lastSeenAt,
      lastInteractionAt,
      profileImageUrl: user.profileImageUrl || null,
    };
  });

  let recent = normalized
    .filter((user) => {
      if (!user.lastLoginAt) return false;
      const ts = Date.parse(user.lastLoginAt);
      if (Number.isNaN(ts)) return false;
      return ts >= cutoffMs;
    })
    .sort((a, b) => Date.parse(b.lastLoginAt || '') - Date.parse(a.lastLoginAt || ''));

  let liveUsers = normalized.filter((user) => user.isOnline);
  if (pseudoLiveEnabled && liveUsers.length < pseudoLiveCount) {
    const liveIds = new Set(liveUsers.map((user) => user.id));
    const seed = (recent.length > 0 ? recent : normalized)
      .filter((user) => !liveIds.has(user.id));
    const needed = Math.max(0, pseudoLiveCount - liveUsers.length);
    if (seed.length > 0 && needed > 0) {
      const pseudo = seed.slice(0, needed).map((user, index) => ({
        ...user,
        isOnline: true,
        isIdle: (liveUsers.length + index) % 3 === 0,
      }));
      const pseudoMap = new Map(pseudo.map((user) => [user.id, user]));
      recent = recent.map((user) => pseudoMap.get(user.id) || user);
      liveUsers = [...liveUsers, ...pseudo];
    }
  }
  if (pseudoLiveEnabled && liveUsers.length < pseudoLiveCount) {
    const liveIds = new Set(liveUsers.map((user) => user.id));
    const liveEmails = new Set(
      liveUsers.map((user) => user.email).filter((email) => email),
    );
    const needed = Math.max(0, pseudoLiveCount - liveUsers.length);
    const extras = fallbackLiveUsers
      .filter((entry) => !liveIds.has(entry.id) && !liveEmails.has(entry.email))
      .slice(0, needed)
      .map((entry, index) => ({
        id: entry.id,
        name: entry.name || null,
        email: entry.email || null,
        role: normalizeUserRole(entry.role),
        isOnline: true,
        isIdle: (liveUsers.length + index) % 3 === 0,
        lastLoginAt: new Date(nowMs - (index + 1) * 12 * 60 * 1000).toISOString(),
        profileImageUrl: null,
      }));
    if (extras.length > 0) {
      liveUsers = [...liveUsers, ...extras];
    }
  }
  liveUsers = liveUsers.sort((a, b) =>
    String(a?.name || a?.email || a?.id || '')
      .toLowerCase()
      .localeCompare(String(b?.name || b?.email || b?.id || '').toLowerCase()),
  );

  const byRole = recent.reduce((acc, user) => {
    const role = user.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});

  res.json({
    window: windowKey,
    generatedAt: new Date().toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    liveUsers,
    total: recent.length,
    byRole,
    users: recent,
  });
});

router.post('/presence', authenticate, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'User not found' });
  }
  const nowIso = new Date().toISOString();
  const kind = (req.body?.kind || 'heartbeat').toString();
  const isIdle = typeof req.body?.isIdle === 'boolean' ? req.body.isIdle : null;

  const existing = userRepository.findById(userId);
  if (!existing) {
    return res.status(401).json({ error: 'User not found' });
  }

  const next = {
    ...existing,
    isOnline: true,
    isIdle: isIdle ?? existing.isIdle ?? false,
    lastSeenAt: nowIso,
    lastInteractionAt:
      kind === 'interaction' ? nowIso : (existing.lastInteractionAt || null),
  };

  userRepository.update(next);

  return res.json({
    ok: true,
    now: nowIso,
    kind,
    isIdle: next.isIdle,
    lastSeenAt: next.lastSeenAt,
    lastInteractionAt: next.lastInteractionAt,
  });
});

module.exports = router;
