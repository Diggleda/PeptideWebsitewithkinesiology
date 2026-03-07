const { env } = require('../config/env');
const { logger } = require('../config/logger');

const stats = new Map();
let reportTimer = null;

const maxRouteKeys = 2000;

const normalizeSegment = (segment) => {
  const value = String(segment || '').trim();
  if (!value) return '';
  if (/^\d+$/.test(value)) return ':id';
  if (/^[0-9a-f]{8,}$/i.test(value)) return ':id';
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    return ':id';
  }
  if (value.length > 64) return ':token';
  return value;
};

const normalizePath = (pathValue) => {
  const raw = String(pathValue || '').split('?')[0];
  const pieces = raw.split('/').filter(Boolean).map(normalizeSegment);
  return `/${pieces.join('/')}`;
};

const toRouteKey = (req) => {
  const method = String(req.method || 'GET').toUpperCase();
  const rawPath = req.baseUrl && req.route?.path
    ? `${req.baseUrl}${req.route.path}`
    : (req.originalUrl || req.path || '/');
  const normalizedPath = normalizePath(rawPath);
  return `${method} ${normalizedPath}`;
};

const getOrCreateStat = (key) => {
  let stat = stats.get(key);
  if (!stat) {
    if (stats.size >= maxRouteKeys) {
      let oldestKey = null;
      let oldestSeen = Number.MAX_SAFE_INTEGER;
      for (const [candidateKey, candidateStat] of stats.entries()) {
        if (candidateStat.lastSeenAt < oldestSeen) {
          oldestSeen = candidateStat.lastSeenAt;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) stats.delete(oldestKey);
    }
    stat = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      slowCount: 0,
      lastSeenAt: Date.now(),
    };
    stats.set(key, stat);
  }
  return stat;
};

const emitSummary = () => {
  if (stats.size === 0) {
    return;
  }
  const minHits = Math.max(1, Number(env.perf?.minHitsForSummary || 5));
  const topN = Math.max(1, Number(env.perf?.topRoutes || 5));
  const rows = [];

  for (const [route, stat] of stats.entries()) {
    if (stat.count < minHits) continue;
    rows.push({
      route,
      count: stat.count,
      avgMs: Number((stat.totalMs / stat.count).toFixed(2)),
      maxMs: Number(stat.maxMs.toFixed(2)),
      slowCount: stat.slowCount,
    });
  }

  rows.sort((a, b) => (b.avgMs - a.avgMs) || (b.maxMs - a.maxMs) || (b.count - a.count));
  const top = rows.slice(0, topN);

  if (top.length > 0) {
    logger.info(
      {
        windowMs: env.perf.summaryIntervalMs,
        topSlowRoutes: top,
        trackedRoutes: stats.size,
      },
      'Request performance summary',
    );
  }

  stats.clear();
};

const ensureReporter = () => {
  if (reportTimer) return;
  reportTimer = setInterval(emitSummary, env.perf.summaryIntervalMs);
  if (typeof reportTimer.unref === 'function') {
    reportTimer.unref();
  }
};

const requestTiming = (req, res, next) => {
  if (!env.perf.enabled) {
    return next();
  }
  if (env.perf.onlyApi && !(String(req.path || req.originalUrl || '').startsWith('/api'))) {
    return next();
  }

  ensureReporter();
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedNs = process.hrtime.bigint() - startedAt;
    const durationMs = Number(elapsedNs) / 1e6;
    const routeKey = toRouteKey(req);
    const stat = getOrCreateStat(routeKey);
    stat.count += 1;
    stat.totalMs += durationMs;
    stat.maxMs = Math.max(stat.maxMs, durationMs);
    stat.lastSeenAt = Date.now();
    if (durationMs >= env.perf.slowRequestMs) {
      stat.slowCount += 1;
      logger.warn(
        {
          route: routeKey,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
          requestId: req.requestId || null,
        },
        'Slow request detected',
      );
    }
  });

  return next();
};

module.exports = { requestTiming };
