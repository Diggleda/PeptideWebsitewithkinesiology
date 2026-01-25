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
  getTaxesByStateCsvDownloadedAt,
  setTaxesByStateCsvDownloadedAt,
  getProductsCommissionCsvDownloadedAt,
  setProductsCommissionCsvDownloadedAt,
} = require('../services/settingsService');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const userRepository = require('../repositories/userRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');

const router = Router();

const normalizeRole = (role) => (role || '').toLowerCase();
const isAdmin = (role) => normalizeRole(role) === 'admin';
const isSalesRep = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'sales_rep' || normalized === 'rep';
};

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

const requireSalesRepOrAdmin = (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = userRepository.findById(userId);
  const role = normalizeRole(user?.role);
  if (!isAdmin(role) && !isSalesRep(role)) {
    return res.status(403).json({ error: 'Sales rep access required' });
  }
  req.currentUser = user;
  return next();
};

const computePresenceSnapshot = ({ user, nowMs, onlineThresholdMs, idleThresholdMs }) => {
  const lastLoginAt = user?.lastLoginAt || null;
  const lastLoginMs = lastLoginAt ? Date.parse(lastLoginAt) : NaN;
  const hasLoginTs = Number.isFinite(lastLoginMs);
  const lastSeenAt = user?.lastSeenAt || lastLoginAt || null;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  const hasSeenTs = Number.isFinite(lastSeenMs);
  const lastInteractionAt = user?.lastInteractionAt || null;
  const lastInteractionMs = lastInteractionAt ? Date.parse(lastInteractionAt) : NaN;
  const hasInteractionTs = Number.isFinite(lastInteractionMs);

  const isOnline =
    (hasSeenTs && (nowMs - lastSeenMs) <= onlineThresholdMs)
    || (!hasSeenTs && hasLoginTs && (nowMs - lastLoginMs) <= onlineThresholdMs);

  const explicitIdle = typeof user?.isIdle === 'boolean' ? user.isIdle : null;
  // "Idle" should not be reset by heartbeats (`lastSeenAt`); only by interactions or (as fallback) session start.
  const idleAnchorMs = hasInteractionTs ? lastInteractionMs : (hasLoginTs ? lastLoginMs : lastSeenMs);
  const hasIdleAnchor = Number.isFinite(idleAnchorMs);
  const computedIdle = isOnline && hasIdleAnchor ? (nowMs - idleAnchorMs) >= idleThresholdMs : null;

  const idleMinutes = hasIdleAnchor ? Math.max(0, Math.floor((nowMs - idleAnchorMs) / 60000)) : null;
  const onlineMinutes = hasLoginTs ? Math.max(0, Math.floor((nowMs - lastLoginMs) / 60000)) : null;

  return {
    isOnline,
    isIdle: explicitIdle ?? computedIdle,
    lastLoginAt,
    lastSeenAt,
    lastInteractionAt,
    idleMinutes,
    onlineMinutes,
  };
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
  const taxesDownloadedAt = await getTaxesByStateCsvDownloadedAt();
  const productsDownloadedAt = await getProductsCommissionCsvDownloadedAt();
  res.json({
    salesBySalesRepCsvDownloadedAt: downloadedAt,
    taxesByStateCsvDownloadedAt: taxesDownloadedAt,
    productsCommissionCsvDownloadedAt: productsDownloadedAt,
  });
});

router.put('/reports', authenticate, requireAdmin, async (req, res) => {
  const salesDownloadedAt = req.body?.salesBySalesRepCsvDownloadedAt;
  const taxesDownloadedAt = req.body?.taxesByStateCsvDownloadedAt;
  const productsDownloadedAt = req.body?.productsCommissionCsvDownloadedAt;

  if (salesDownloadedAt !== undefined) {
    await setSalesBySalesRepCsvDownloadedAt(salesDownloadedAt);
  }
  if (taxesDownloadedAt !== undefined) {
    await setTaxesByStateCsvDownloadedAt(taxesDownloadedAt);
  }
  if (productsDownloadedAt !== undefined) {
    await setProductsCommissionCsvDownloadedAt(productsDownloadedAt);
  }

  res.json({
    salesBySalesRepCsvDownloadedAt: await getSalesBySalesRepCsvDownloadedAt(),
    taxesByStateCsvDownloadedAt: await getTaxesByStateCsvDownloadedAt(),
    productsCommissionCsvDownloadedAt: await getProductsCommissionCsvDownloadedAt(),
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

router.get('/live-clients', authenticate, requireSalesRepOrAdmin, async (req, res) => {
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
  const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
  const idleThresholdMs = idleThresholdMinutes * 60 * 1000;

  const current = req.currentUser || userRepository.findById(req.user?.id);
  const role = normalizeRole(current?.role);
  const requestedSalesRepId =
    isAdmin(role) && typeof req.query?.salesRepId === 'string'
      ? req.query.salesRepId
      : null;
  const allowedOwnerIds = Array.from(
    new Set(
      [
        requestedSalesRepId,
        current?.salesRepId,
        current?.id,
      ]
        .filter(Boolean)
        .map((value) => String(value)),
    ),
  );

  let prospects = [];
  try {
    const all = await salesProspectRepository.getAll();
    prospects = (all || []).filter(
      (record) => record?.salesRepId && allowedOwnerIds.includes(String(record.salesRepId)),
    );
  } catch (error) {
    logger.warn(
      { err: error, userId: current?.id || null },
      'Failed to load sales prospects for live clients',
    );
  }

  const doctorIdSet = new Set(
    prospects
      .map((record) => (record?.doctorId ? String(record.doctorId) : null))
      .filter(Boolean),
  );
  const emailSet = new Set(
    prospects
      .map((record) => (record?.contactEmail ? String(record.contactEmail).trim().toLowerCase() : null))
      .filter(Boolean),
  );

  const users = userRepository.getAll();
  const doctors = (users || []).filter((candidate) => {
    const candidateRole = normalizeUserRole(candidate?.role);
    if (candidateRole !== 'doctor' && candidateRole !== 'test_doctor') {
      return false;
    }
    const idMatch = candidate?.id && doctorIdSet.has(String(candidate.id));
    const email = candidate?.email ? String(candidate.email).trim().toLowerCase() : '';
    const emailMatch = email && emailSet.has(email);
    return idMatch || emailMatch;
  });

  const clients = doctors
    .map((user) => {
      const snapshot = computePresenceSnapshot({
        user,
        nowMs,
        onlineThresholdMs,
        idleThresholdMs,
      });
      return {
        id: user.id,
        name: user.name || null,
        email: user.email || null,
        role: normalizeUserRole(user.role),
        profileImageUrl: user.profileImageUrl || null,
        ...snapshot,
      };
    })
    .filter((entry) => entry.isOnline)
    .sort((a, b) => {
      const aIdle = Boolean(a.isIdle);
      const bIdle = Boolean(b.isIdle);
      if (aIdle !== bIdle) return aIdle ? 1 : -1;
      const aName = String(a?.name || a?.email || a?.id || '').toLowerCase();
      const bName = String(b?.name || b?.email || b?.id || '').toLowerCase();
      return aName.localeCompare(bName);
    });

  res.json({
    generatedAt: new Date().toISOString(),
    salesRepId: requestedSalesRepId || current?.salesRepId || current?.id || null,
    clients,
  });
});

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
  // Default OFF: pseudo-live users are only for demos/dev; they can look like "stuck online" accounts.
  const pseudoLiveEnabled = String(
    process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS || 'false',
  ).toLowerCase() === 'true';
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
    const idleAnchorMs = hasInteractionTs ? lastInteractionMs : (hasLoginTs ? lastLoginMs : lastSeenMs);
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
        isSimulated: true,
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
        isSimulated: true,
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

router.get('/live-clients', authenticate, requireSalesRepOrAdmin, async (req, res) => {
  try {
    const currentUser = req.currentUser || req.user;
    const role = normalizeRole(currentUser?.role);
    const requestedSalesRepId = typeof req.query?.salesRepId === 'string'
      ? req.query.salesRepId
      : null;

    const targetSalesRepId = isAdmin(role) && requestedSalesRepId
      ? String(requestedSalesRepId)
      : String(currentUser?.id || '');

    if (!targetSalesRepId) {
      return res.status(400).json({ error: 'salesRepId is required' });
    }

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
    const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
    const idleThresholdMs = idleThresholdMinutes * 60 * 1000;
    const nowMs = Date.now();

    const prospects = await salesProspectRepository.getAll();
    const ownedProspects = (prospects || []).filter(
      (p) => String(p?.salesRepId || '') === targetSalesRepId,
    );
    const doctorIds = new Set(
      ownedProspects.map((p) => p?.doctorId).filter(Boolean).map(String),
    );
    const doctorEmails = new Set(
      ownedProspects
        .map((p) => (p?.contactEmail || '').toString().trim().toLowerCase())
        .filter(Boolean),
    );

    const doctorUsers = userRepository
      .getAll()
      .filter((candidate) => {
        const candidateRole = normalizeRole(candidate?.role);
        if (candidateRole !== 'doctor' && candidateRole !== 'test_doctor') {
          return false;
        }
        if (doctorIds.size > 0 && doctorIds.has(String(candidate.id))) {
          return true;
        }
        const email = (candidate.email || '').toString().trim().toLowerCase();
        return Boolean(email && doctorEmails.has(email));
      })
      .map((doctor) => {
        const snapshot = computePresenceSnapshot({
          user: doctor,
          nowMs,
          onlineThresholdMs,
          idleThresholdMs,
        });
        return {
          id: doctor.id,
          name: doctor.name || null,
          email: doctor.email || null,
          role: normalizeRole(doctor.role),
          profileImageUrl: doctor.profileImageUrl || null,
          ...snapshot,
        };
      })
      .filter((entry) => entry.isOnline);

    res.json({
      generatedAt: new Date().toISOString(),
      salesRepId: targetSalesRepId,
      clients: doctorUsers,
      total: doctorUsers.length,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load live clients');
    res.status(500).json({ error: 'Unable to load live clients' });
  }
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
      (kind === 'interaction' || (kind === 'heartbeat' && isIdle === false))
        ? nowIso
        : (existing.lastInteractionAt || null),
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
