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
  if (/^products\/[^/]+\/variations$/.test(endpoint)) return 10 * 60;
  if (/^products\/[^/]+$/.test(endpoint)) return 10 * 60;
  return 60;
};

const catalogCache = new Map();
const inFlight = new Map();

const parsePositiveInt = (value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
};

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
const MEDIA_CACHE_DIR = path.join(env.dataDir, 'woo-media-cache');
const MEDIA_CACHE_TTL_SECONDS = parsePositiveInt(
  process.env.WOO_MEDIA_CACHE_TTL_SECONDS,
  24 * 60 * 60,
  { min: 60, max: 30 * 24 * 60 * 60 },
);
const MEDIA_CACHE_MAX_BYTES = parsePositiveInt(
  process.env.WOO_MEDIA_CACHE_MAX_BYTES,
  10 * 1024 * 1024,
  { min: 256 * 1024, max: 50 * 1024 * 1024 },
);
const MEDIA_DOWNLOAD_MAX_BYTES = parsePositiveInt(
  process.env.WOO_MEDIA_DOWNLOAD_MAX_BYTES,
  MEDIA_CACHE_MAX_BYTES,
  { min: 256 * 1024, max: 50 * 1024 * 1024 },
);
const MEDIA_REQUEST_TIMEOUT_MS = parsePositiveInt(
  process.env.WOO_MEDIA_REQUEST_TIMEOUT_MS,
  15000,
  { min: 1000, max: 60000 },
);
const MEDIA_PROXY_PATH_PATTERN = /\/api\/(?:woo|catalog)\/media$/i;
const DEFAULT_MEDIA_HOSTS = new Set([
  'shop.trufusionlabs.com',
  'trufusionlabs.com',
  'www.trufusionlabs.com',
  'shop.peppro.net',
  'peppro.net',
  'www.peppro.net',
]);

const cacheKeyToFilename = (cacheKey) =>
  crypto.createHash('sha256').update(cacheKey).digest('hex') + '.json';

const mediaCachePaths = (source) => {
  const key = crypto.createHash('sha256').update(source).digest('hex');
  return {
    dataPath: path.join(MEDIA_CACHE_DIR, `${key}.bin`),
    metaPath: path.join(MEDIA_CACHE_DIR, `${key}.json`),
  };
};

const readCachedMedia = async ({ dataPath, metaPath }, { allowStale = false } = {}) => {
  try {
    const rawMeta = await fs.promises.readFile(metaPath, 'utf8');
    const meta = JSON.parse(rawMeta);
    const expiresAt = Number(meta?.expiresAt || 0);
    if (!allowStale && expiresAt && expiresAt < Date.now()) {
      return null;
    }
    const payload = await fs.promises.readFile(dataPath);
    return {
      payload,
      contentType: typeof meta?.contentType === 'string' && meta.contentType.trim()
        ? meta.contentType.trim()
        : null,
    };
  } catch {
    return null;
  }
};

const writeCachedMedia = async ({ dataPath, metaPath }, { payload, contentType }) => {
  if (!payload || payload.length > MEDIA_CACHE_MAX_BYTES) return;
  try {
    await fs.promises.mkdir(MEDIA_CACHE_DIR, { recursive: true });
    const tmpDataPath = `${dataPath}.tmp`;
    const tmpMetaPath = `${metaPath}.tmp`;
    await fs.promises.writeFile(tmpDataPath, payload);
    await fs.promises.writeFile(tmpMetaPath, JSON.stringify({
      contentType: contentType || null,
      bytes: payload.length,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + MEDIA_CACHE_TTL_SECONDS * 1000,
    }), 'utf8');
    await fs.promises.rename(tmpDataPath, dataPath);
    await fs.promises.rename(tmpMetaPath, metaPath);
  } catch (error) {
    logger.debug(
      { message: error?.message },
      'Woo media cache write failed',
    );
  }
};

const sendMediaPayload = ({ res, payload, contentType, cacheLabel }) => {
  res.set('Cache-Control', `public, max-age=${MEDIA_CACHE_TTL_SECONDS}`);
  res.set('X-TruFusion-Media-Cache', cacheLabel);
  res.set('Content-Length', String(payload.length));
  if (contentType) {
    res.set('Content-Type', contentType);
  }
  res.send(payload);
};

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
  res.set('X-TruFusion-Cache', cacheLabel);
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
  const hosts = new Set(DEFAULT_MEDIA_HOSTS);
  const configuredHosts = String(process.env.WOO_MEDIA_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  for (const host of configuredHosts) {
    hosts.add(host);
  }

  if (!env?.wooCommerce?.storeUrl) {
    return hosts;
  }
  try {
    const parsed = new URL(env.wooCommerce.storeUrl);
    if (parsed.hostname) {
      hosts.add(parsed.hostname.toLowerCase());
    }
  } catch {
    // Keep default/configured media hosts.
  }
  return hosts;
};

const unwrapMediaProxySource = (value) => {
  let candidate = String(value || '').trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate) break;
    try {
      const parsed = new URL(candidate, 'https://trufusionlabs.com');
      if (!MEDIA_PROXY_PATH_PATTERN.test(parsed.pathname)) {
        break;
      }
      const nestedSource = parsed.searchParams.get('src');
      if (!nestedSource || nestedSource.trim() === candidate) {
        break;
      }
      candidate = nestedSource.trim();
    } catch {
      break;
    }
  }
  return candidate;
};

const allowedMediaHosts = resolveWooHostnames();

const developmentCoaCandidates = [
  path.join(process.cwd(), 'server-data', 'documents'),
  path.join(process.cwd(), 'cpanel_backend', 'server-data', 'documents'),
];

const getMimeTypeForFilename = (filename) => {
  const ext = path.extname(String(filename || '')).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
};

const resolveDevelopmentCoaAsset = () => {
  const configuredPath = String(process.env.DEV_COA_DUMMY_PATH || '').trim();
  const configuredCandidates = configuredPath
    ? [path.isAbsolute(configuredPath) ? configuredPath : path.join(process.cwd(), configuredPath)]
    : [];
  const candidates = [...configuredCandidates];

  for (const dir of developmentCoaCandidates) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(png|jpe?g|webp|pdf)$/i.test(entry.name)) continue;
        candidates.push(path.join(dir, entry.name));
      }
    } catch {
      // ignore missing directories
    }
  }

  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) continue;
      return {
        filePath: candidate,
        filename: path.basename(candidate),
        mimeType: getMimeTypeForFilename(candidate),
        bytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
      };
    } catch {
      // ignore unreadable candidates
    }
  }

  return null;
};

const sendDevelopmentCoa = async (res, asset) => {
  const buffer = await fs.promises.readFile(asset.filePath);
  const etag = `"${crypto.createHash('sha256').update(buffer).digest('hex')}"`;
  res.set('Content-Type', asset.mimeType);
  res.set('Content-Disposition', `inline; filename="${asset.filename}"`);
  res.set('Cache-Control', 'private, max-age=300');
  res.set('ETag', etag);
  res.send(buffer);
};

const sanitizeMediaUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = unwrapMediaProxySource(value);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    const hostname = String(parsed.hostname || '').toLowerCase();
    if (!allowedMediaHosts.has(hostname)) {
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
    let requestedEndpoint = normalizeEndpoint((req.params && (req.params[0] || req.params.path)) || req.path || '');
    if (!requestedEndpoint) {
      throw createHttpError('Missing WooCommerce endpoint', 400);
    }

    if (requestedEndpoint === 'categories') {
      requestedEndpoint = 'products/categories';
    }

    if (!isAllowedEndpoint(requestedEndpoint)) {
      throw createHttpError(`Unsupported WooCommerce endpoint: ${requestedEndpoint}`, 404);
    }

    const forceParam = String(req.query?.force || '').toLowerCase().trim();
    const forceFresh = forceParam === '1' || forceParam === 'true' || forceParam === 'yes';

    const ttlSeconds = cacheTtlSecondsForEndpoint(requestedEndpoint);
    const allowStale =
      requestedEndpoint === 'products'
      || requestedEndpoint === 'products/categories'
      || /^products\/[^/]+\/variations$/.test(requestedEndpoint)
      || /^products\/[^/]+$/.test(requestedEndpoint);
    const cacheKey = buildCacheKey(requestedEndpoint, req.query);
    const now = Date.now();
    const cached = catalogCache.get(cacheKey);

    if (forceFresh) {
      try {
        const data = await wooCommerceClient.fetchCatalog(requestedEndpoint, req.query);
        if (catalogCache.size > 500) {
          catalogCache.clear();
        }
        catalogCache.set(cacheKey, { data, expiresAt: now + ttlSeconds * 1000 });
        void writeDiskCache(cacheKey, {
          data,
          fetchedAt: now,
          expiresAt: now + ttlSeconds * 1000,
        });
        res.set('Cache-Control', 'no-store');
        res.set('X-TruFusion-Cache', 'BYPASS');
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

    if (allowStale && cached && cached.expiresAt <= now && now - cached.expiresAt <= MAX_STALE_MS) {
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
      if (!allowStale && expiresAt <= now) {
        // Don't serve expired snapshots for endpoints that impact pricing/images (e.g. variations).
        // We'll fetch fresh instead.
      } else {
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
    res.set('X-TruFusion-Cache', 'MISS');
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
  let cachePaths = null;
  try {
    const source = sanitizeMediaUrl(req.query?.src);
    if (!source) {
      throw createHttpError('Invalid media source', 400);
    }
    cachePaths = mediaCachePaths(source);
    const cached = await readCachedMedia(cachePaths);
    if (cached) {
      sendMediaPayload({
        res,
        payload: cached.payload,
        contentType: cached.contentType,
        cacheLabel: 'HIT',
      });
      return;
    }

    const response = await axios.get(source, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      maxBodyLength: MEDIA_DOWNLOAD_MAX_BYTES,
      maxContentLength: MEDIA_DOWNLOAD_MAX_BYTES,
      responseType: 'arraybuffer',
      timeout: MEDIA_REQUEST_TIMEOUT_MS,
    });

    const payload = Buffer.from(response.data || []);
    if (payload.length > MEDIA_DOWNLOAD_MAX_BYTES) {
      throw createHttpError('Media too large', 413);
    }
    const contentType = typeof response.headers['content-type'] === 'string'
      ? response.headers['content-type']
      : null;
    await writeCachedMedia(cachePaths, { payload, contentType });
    sendMediaPayload({
      res,
      payload,
      contentType,
      cacheLabel: 'MISS',
    });
  } catch (error) {
    const upstreamStatus = error.response?.status;
    if (cachePaths && [408, 429, 500, 502, 503, 504].includes(Number(upstreamStatus))) {
      const stale = await readCachedMedia(cachePaths, { allowStale: true });
      if (stale) {
        sendMediaPayload({
          res,
          payload: stale.payload,
          contentType: stale.contentType,
          cacheLabel: 'STALE',
        });
        return;
      }
    }
    if (error.response?.status === 404) {
      res.status(404).end();
      return;
    }
    next(error);
  }
};

const getCertificateOfAnalysis = async (req, res, next) => {
  try {
    const asset = resolveDevelopmentCoaAsset();
    if (!asset) {
      throw createHttpError('Certificate of analysis not found', 404);
    }
    await sendDevelopmentCoa(res, asset);
  } catch (error) {
    next(error);
  }
};

const getCertificateOfAnalysisDelegate = async (req, res, next) => {
  try {
    const asset = resolveDevelopmentCoaAsset();
    if (!asset) {
      throw createHttpError('Certificate of analysis not found', 404);
    }
    await sendDevelopmentCoa(res, asset);
  } catch (error) {
    next(error);
  }
};

const getCertificateOfAnalysisInfo = async (req, res, next) => {
  try {
    const productId = Number.parseInt(String(req.params.productId || ''), 10);
    const asset = resolveDevelopmentCoaAsset();
    res.json({
      wooProductId: Number.isFinite(productId) ? productId : null,
      exists: Boolean(asset),
      filename: asset?.filename || null,
      mimeType: asset?.mimeType || null,
      bytes: asset?.bytes || null,
      updatedAt: asset?.updatedAt || null,
      sha256: null,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCertificateOfAnalysis,
  getCertificateOfAnalysisDelegate,
  getCertificateOfAnalysisInfo,
  proxyCatalog,
  proxyMedia,
};
