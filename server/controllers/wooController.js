const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const wooCommerceClient = require('../integration/wooCommerceClient');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const allowedExactEndpoints = new Set(['products', 'products/categories']);
const allowedPatternEndpoints = [
  /^products\/[A-Za-z0-9_-]+$/,
  /^products\/[A-Za-z0-9_-]+\/variations$/,
];

const normalizeEndpoint = (value) => value.replace(/^\/+|\/+$/g, '');

const isAllowedEndpoint = (endpoint) => (
  allowedExactEndpoints.has(endpoint)
  || allowedPatternEndpoints.some((pattern) => pattern.test(endpoint))
);

const buildCacheKey = (endpoint, query) => {
  const normalizedQuery = query && typeof query === 'object'
    ? Object.keys(query)
      .sort()
      .reduce((acc, key) => {
        acc[key] = query[key];
        return acc;
      }, {})
    : {};
  return `${endpoint}::${JSON.stringify(normalizedQuery)}`;
};

const cacheTtlSecondsForEndpoint = (endpoint) => {
  if (endpoint === 'products/categories') return 10 * 60;
  // Products rarely change minute-to-minute; a longer TTL prevents repeated cold Woo fetches.
  if (endpoint === 'products') return 5 * 60;
  if (/^products\/[^/]+\/variations$/.test(endpoint)) return 5 * 60;
  if (/^products\/[^/]+$/.test(endpoint)) return 5 * 60;
  return 60;
};

const catalogCache = new Map();
const inFlight = new Map();

const DISK_CACHE_ENABLED =
  String(process.env.WOO_PROXY_DISK_CACHE || 'true').toLowerCase() === 'true';
const MAX_STALE_MS = (() => {
  const raw = String(process.env.WOO_PROXY_MAX_STALE_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 24 * 60 * 60 * 1000; // 24h
})();
const DISK_CACHE_DIR = path.join(env.dataDir, 'woo-proxy-cache');

const cacheKeyToFilename = (cacheKey) =>
  crypto.createHash('sha256').update(cacheKey).digest('hex') + '.json';

const readDiskCache = async (cacheKey) => {
  if (!DISK_CACHE_ENABLED) return null;
  try {
    const filePath = path.join(DISK_CACHE_DIR, cacheKeyToFilename(cacheKey));
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!('data' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeDiskCache = async (cacheKey, payload) => {
  if (!DISK_CACHE_ENABLED) return;
  try {
    await fs.promises.mkdir(DISK_CACHE_DIR, { recursive: true });
    const filePath = path.join(DISK_CACHE_DIR, cacheKeyToFilename(cacheKey));
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    logger.debug(
      { message: error?.message, cacheKey },
      'Woo proxy disk cache write failed',
    );
  }
};

const createHttpError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const serveCachedResponse = ({
  res,
  requestedEndpoint,
  startedAt,
  ttlSeconds,
  cacheLabel,
  data,
}) => {
  res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
  res.set('X-PepPro-Cache', cacheLabel);
  res.json(data);
  if (requestedEndpoint === 'products' || requestedEndpoint === 'products/categories') {
    logger.info(
      {
        endpoint: requestedEndpoint,
        cache: cacheLabel,
        ttlSeconds,
        durationMs: Date.now() - startedAt,
        items: Array.isArray(data) ? data.length : null,
      },
      'Woo proxy served cached response',
    );
  }
};

const refreshInBackground = ({ cacheKey, requestedEndpoint, query, ttlSeconds }) => {
  if (inFlight.get(cacheKey)) return;
  const pending = (async () => wooCommerceClient.fetchCatalog(requestedEndpoint, query))();
  inFlight.set(cacheKey, pending);
  pending
    .then((data) => {
      const now = Date.now();
      if (catalogCache.size > 500) {
        catalogCache.clear();
      }
      catalogCache.set(cacheKey, { data, expiresAt: now + ttlSeconds * 1000 });
      void writeDiskCache(cacheKey, {
        data,
        fetchedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      });
    })
    .catch((error) => {
      logger.warn(
        {
          endpoint: requestedEndpoint,
          message: error?.message,
          status: error?.status ?? error?.response?.status,
        },
        'Woo proxy background refresh failed',
      );
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });
};

const resolveWooHostnames = () => {
  if (!env?.wooCommerce?.storeUrl) {
    return new Set();
  }
  try {
    const parsed = new URL(env.wooCommerce.storeUrl);
    return new Set([parsed.hostname]);
  } catch {
    return new Set();
  }
};

const allowedMediaHosts = resolveWooHostnames();

const sanitizeMediaUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    if (!allowedMediaHosts.has(parsed.hostname)) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join('/');
    return parsed.toString();
  } catch {
    return null;
  }
};

const proxyCatalog = async (req, res, next) => {
  const startedAt = Date.now();
  try {
    // Support both wildcard param capture (e.g. '/*') and middleware usage
    // where we rely on req.path under the '/api/woo' mount.
    const requestedEndpoint = normalizeEndpoint((req.params && (req.params[0] || req.params.path)) || req.path || '');
    if (!requestedEndpoint) {
      throw createHttpError('Missing WooCommerce endpoint', 400);
    }

    if (!isAllowedEndpoint(requestedEndpoint)) {
      throw createHttpError(`Unsupported WooCommerce endpoint: ${requestedEndpoint}`, 404);
    }

    const forceParam = String(req.query?.force || '').toLowerCase().trim();
    const forceFresh = forceParam === '1' || forceParam === 'true' || forceParam === 'yes';

    const ttlSeconds = cacheTtlSecondsForEndpoint(requestedEndpoint);
    const cacheKey = buildCacheKey(requestedEndpoint, req.query);
    const now = Date.now();
    const cached = catalogCache.get(cacheKey);

    if (forceFresh) {
      try {
        const data = await wooCommerceClient.fetchCatalog(requestedEndpoint, req.query);
        res.set('Cache-Control', 'no-store');
        res.set('X-PepPro-Cache', 'BYPASS');
        res.json(data);
        return;
      } catch (error) {
        // If the live fetch fails, fall back to the freshest cached snapshot we have.
        if (cached && cached.data !== undefined) {
          serveCachedResponse({
            res,
            requestedEndpoint,
            startedAt,
            ttlSeconds,
            cacheLabel: 'FORCE_STALE',
            data: cached.data,
          });
          return;
        }
        const diskCached = await readDiskCache(cacheKey);
        if (diskCached && diskCached.data !== undefined) {
          serveCachedResponse({
            res,
            requestedEndpoint,
            startedAt,
            ttlSeconds,
            cacheLabel: 'FORCE_DISK',
            data: diskCached.data,
          });
          return;
        }
        throw error;
      }
    }

    if (cached && cached.expiresAt > now) {
      serveCachedResponse({
        res,
        requestedEndpoint,
        startedAt,
        ttlSeconds,
        cacheLabel: 'HIT',
        data: cached.data,
      });
      return;
    }

    const existing = inFlight.get(cacheKey);
    if (existing) {
      const data = await existing;
      serveCachedResponse({
        res,
        requestedEndpoint,
        startedAt,
        ttlSeconds,
        cacheLabel: 'INFLIGHT',
        data,
      });
      return;
    }

    if (cached && cached.expiresAt <= now && now - cached.expiresAt <= MAX_STALE_MS) {
      serveCachedResponse({
        res,
        requestedEndpoint,
        startedAt,
        ttlSeconds,
        cacheLabel: 'STALE',
        data: cached.data,
      });
      refreshInBackground({
        cacheKey,
        requestedEndpoint,
        query: req.query,
        ttlSeconds,
      });
      return;
    }

    const diskCached = await readDiskCache(cacheKey);
    if (
      diskCached &&
      diskCached.data !== undefined &&
      typeof diskCached.expiresAt === 'number' &&
      typeof diskCached.fetchedAt === 'number' &&
      now - diskCached.fetchedAt <= MAX_STALE_MS
    ) {
      const expiresAt = diskCached.expiresAt;
      const data = diskCached.data;
      if (catalogCache.size > 500) {
        catalogCache.clear();
      }
      catalogCache.set(cacheKey, { data, expiresAt });
      const cacheLabel = expiresAt > now ? 'DISK' : 'DISK_STALE';
      serveCachedResponse({
        res,
        requestedEndpoint,
        startedAt,
        ttlSeconds,
        cacheLabel,
        data,
      });
      if (expiresAt <= now) {
        refreshInBackground({
          cacheKey,
          requestedEndpoint,
          query: req.query,
          ttlSeconds,
        });
      }
      return;
    }

    const pending = (async () => wooCommerceClient.fetchCatalog(requestedEndpoint, req.query))();
    inFlight.set(cacheKey, pending);
    let data;
    try {
      data = await pending;
    } finally {
      inFlight.delete(cacheKey);
    }
    if (catalogCache.size > 500) {
      catalogCache.clear();
    }
    catalogCache.set(cacheKey, { data, expiresAt: now + ttlSeconds * 1000 });
    void writeDiskCache(cacheKey, {
      data,
      fetchedAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });
    res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    res.set('X-PepPro-Cache', 'MISS');
    res.json(data);
    if (requestedEndpoint === 'products' || requestedEndpoint === 'products/categories') {
      logger.info(
        {
          endpoint: requestedEndpoint,
          cache: 'MISS',
          ttlSeconds,
          durationMs: Date.now() - startedAt,
          items: Array.isArray(data) ? data.length : null,
        },
        'Woo proxy fetched from WooCommerce',
      );
    }
  } catch (error) {
    logger.warn(
      {
        endpoint: req.originalUrl,
        durationMs: Date.now() - startedAt,
        message: error?.message,
        status: error?.status ?? error?.response?.status,
      },
      'Woo proxy request failed',
    );
    next(error);
  }
};

const proxyMedia = async (req, res, next) => {
  try {
    const source = sanitizeMediaUrl(req.query?.src);
    if (!source) {
      throw createHttpError('Invalid media source', 400);
    }
    const response = await axios.get(source, {
      responseType: 'stream',
      timeout: 15000,
    });
    res.set('Cache-Control', 'public, max-age=300');
    if (response.headers['content-type']) {
      res.set('Content-Type', response.headers['content-type']);
    }
    response.data.pipe(res);
  } catch (error) {
    if (error.response?.status === 404) {
      res.status(404).end();
      return;
    }
    next(error);
  }
};

module.exports = {
  proxyCatalog,
  proxyMedia,
};
