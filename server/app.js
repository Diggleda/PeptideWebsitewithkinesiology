const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { requestContext } = require('./config/requestContext');
const { rateLimit } = require('./middleware/rateLimit');
const { requestTiming } = require('./middleware/requestTiming');

const lazyModule = (load) => {
  let cached;
  return () => {
    if (!cached) {
      cached = load();
    }
    return cached;
  };
};

const lazyRoute = (loadRoute) => {
  const getRoute = lazyModule(loadRoute);
  return (req, res, next) => {
    try {
      const route = getRoute();
      return route(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
};

const getPaymentRoutes = lazyModule(() => require('./routes/paymentRoutes'));
const getAuthRoutes = lazyModule(() => require('./routes/authRoutes'));
const getOrderRoutes = lazyModule(() => require('./routes/orderRoutes'));
const getSystemRoutes = lazyModule(() => require('./routes/systemRoutes'));
const getNewsRoutes = lazyModule(() => require('./routes/newsRoutes'));
const getWooRoutes = lazyModule(() => require('./routes/wooRoutes'));
const getCatalogRoutes = lazyModule(() => require('./routes/catalogRoutes'));
const getQuotesRoutes = lazyModule(() => require('./routes/quotesRoutes'));
const getShippingRoutes = lazyModule(() => require('./routes/shippingRoutes'));
const getReferralRoutes = lazyModule(() => require('./routes/referralRoutes'));
const getPasswordResetRoutes = lazyModule(() => require('./routes/passwordReset'));
const getContactRoutes = lazyModule(() => require('./routes/contactRoutes'));
const getBugRoutes = lazyModule(() => require('./routes/bugRoutes'));
const getSettingsRoutes = lazyModule(() => require('./routes/settingsRoutes'));
const getModerationRoutes = lazyModule(() => require('./routes/moderationRoutes'));
const getPeptideForumRoutes = lazyModule(() => require('./routes/peptideForumRoutes'));
const getGoogleSheetsRoutes = lazyModule(() => require('./routes/googleSheetsRoutes'));
const getShipStationRoutes = lazyModule(() => require('./routes/shipStationRoutes'));
const getSeamlessRoutes = lazyModule(() => require('./routes/seamlessRoutes'));
const getTrackingRoutes = lazyModule(() => require('./routes/trackingRoutes'));
const getDelegationRoutes = lazyModule(() => require('./routes/delegationRoutes'));
const getUsageTrackingRoutes = lazyModule(() => require('./routes/usageTrackingRoutes'));

const prewarmApiModules = () => {
  const warmers = [
    ['authRoutes', getAuthRoutes],
    ['systemRoutes', getSystemRoutes],
    ['settingsRoutes', getSettingsRoutes],
    ['orderRoutes', getOrderRoutes],
    ['catalogRoutes', getCatalogRoutes],
    ['wooRoutes', getWooRoutes],
  ];

  for (const [name, load] of warmers) {
    try {
      load();
    } catch (error) {
      logger.warn({ err: error, module: name }, 'Background route prewarm failed');
    }
  }
};

const sanitizePublicMessage = (message) => {
  if (!message || typeof message !== 'string') {
    return message;
  }
  const replacements = [
    [/\bwoocommerce\b/gi, 'store'],
    [/\bwoo\s*commerce\b/gi, 'store'],
    [/\bwoo\b/gi, 'store'],
    [/\bstripe\b/gi, 'payment provider'],
    [/\bcloudflare\b/gi, 'network provider'],
    [/\bgodaddy\b/gi, 'hosting provider'],
    [/\bshipstation\b/gi, 'shipping provider'],
    [/\bshipengine\b/gi, 'shipping provider'],
  ];
  let output = message;
  for (const [pattern, replacement] of replacements) {
    output = output.replace(pattern, replacement);
  }
  output = output.replace(/\bstore\s+store\b/gi, 'store');
  output = output.replace(/\bpayment provider\s+payment provider\b/gi, 'payment provider');
  return output;
};

const generateRequestId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.randomBytes(16);
  return bytes.toString('hex');
};

const normalizeRequestId = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const defaultCodeForStatus = (status) => {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
};

const resolveFrontendRoot = () => {
  const baseCandidates = [
    process.cwd(),
    path.join(__dirname, '..'),
  ].map((value) => path.resolve(value));
  const bases = Array.from(new Set(baseCandidates));

  for (const base of bases) {
    const candidates = [
      path.join(base, 'build'),
      path.join(base, 'public_html'),
      path.join(base, 'public'),
    ];
    const resolved = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
    if (resolved) {
      return { root: resolved, base };
    }
  }

  return null;
};

const buildCorsOptions = () => {
  const configuredAllowList = Array.isArray(env.cors?.allowList) ? env.cors.allowList : [];
  const derivedAllowList = [];
  const frontendBase = String(env.frontendBaseUrl || '').trim();
  if (frontendBase) {
    try {
      derivedAllowList.push(new URL(frontendBase).origin);
    } catch {
      // ignore invalid FRONTEND_BASE_URL values
    }
  }
  // Production safety net: keep core web origins allowed even if env allow-list drifts.
  const productionFallbackAllowList = env.nodeEnv === 'production'
    ? [
      'https://peppro.net',
      'https://www.peppro.net',
      'https://port.peppro.net',
      'https://www.port.peppro.net',
    ]
    : [];
  const allowList = Array.from(new Set([
    ...configuredAllowList,
    ...derivedAllowList,
    ...productionFallbackAllowList,
  ]));
  const allowAll = allowList.includes('*');
  if (allowAll) {
    return { origin: true, credentials: true };
  }

  const isDev = env.nodeEnv !== 'production';

  const matchesAllowList = (origin) => {
    if (!origin || typeof origin !== 'string') {
      return false;
    }
    const trimmed = origin.trim();
    if (!trimmed || trimmed === 'null') {
      return isDev;
    }

    let parsed = null;
    try {
      parsed = new URL(trimmed);
    } catch {
      parsed = null;
    }

    if (allowList.includes(trimmed)) {
      return true;
    }

    const hostname = parsed?.hostname ? String(parsed.hostname).trim().toLowerCase() : null;
    const normalizedOrigin = parsed?.origin ? String(parsed.origin).trim() : null;

    for (const entry of allowList) {
      const candidate = String(entry || '').trim();
      if (!candidate) continue;

      if (candidate === trimmed) return true;

      // Allow specifying origins as full URLs (normalized to protocol + host + port).
      if (candidate.includes('://') && normalizedOrigin) {
        try {
          if (new URL(candidate).origin === normalizedOrigin) {
            return true;
          }
        } catch {
          // ignore
        }
      }

      // Allow specifying hostnames (e.g. "peppro.net") or wildcard subdomains (e.g. "*.peppro.net").
      if (hostname) {
        const normalizedCandidate = candidate.toLowerCase();
        if (normalizedCandidate === hostname) return true;
        if (normalizedCandidate.startsWith('*.')) {
          const suffix = normalizedCandidate.slice(1); // ".peppro.net"
          if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
            return true;
          }
        } else if (normalizedCandidate.startsWith('.')) {
          const suffix = normalizedCandidate; // ".peppro.net"
          if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
            return true;
          }
        }
      }
    }

    return false;
  };

  const isDevLocalOrigin = (origin) => {
    if (!origin || typeof origin !== 'string') {
      return false;
    }
    const trimmed = origin.trim();
    if (!trimmed || trimmed === 'null') {
      return isDev;
    }
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return false;
      }
      const host = parsed.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
        return true;
      }
      // Common private LAN ranges (for phone/tablet testing).
      if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
      if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
      return false;
    } catch {
      return false;
    }
  };

  return {
    origin: (origin, callback) => {
      if (!origin || matchesAllowList(origin)) {
        callback(null, true);
        return;
      }
      if (isDev && isDevLocalOrigin(origin)) {
        callback(null, true);
        return;
      }
      logger.warn(
        {
          origin: origin || null,
          allowList,
        },
        'CORS origin rejected',
      );
      callback(null, false);
    },
    credentials: true,
    exposedHeaders: [
      'Content-Disposition',
      'Content-Type',
      'Server-Timing',
      'X-PepPro-Quote-Export-Ms',
      'X-PepPro-Quote-Pdf-Ms',
      'X-PepPro-Quote-Render-Ms',
      'X-PepPro-Quote-Image-Ms',
      'X-PepPro-Quote-Renderer',
      'X-PepPro-Quote-Cache',
      'X-PepPro-Quote-Pdf-Bytes',
      'X-PepPro-Quote-Id',
      'X-Request-Id',
    ],
  };
};

const createApp = () => {
  const app = express();

  app.use((req, res, next) => {
    const requestId = normalizeRequestId(req.headers['x-request-id']) || generateRequestId();
    res.setHeader('X-Request-Id', requestId);
    req.requestId = requestId;
    requestContext.run({ requestId }, () => next());
  });

  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload) {
        const status = res.statusCode || 500;
        const currentCode = payload.code;
        const nextPayload = {
          ...payload,
          requestId: payload.requestId ?? req.requestId ?? null,
          code: typeof currentCode === 'string' && currentCode.trim()
            ? currentCode
            : defaultCodeForStatus(status),
        };
        return originalJson(nextPayload);
      }
      return originalJson(payload);
    };
    next();
  });

  const corsOptions = buildCorsOptions();
  app.use(cors(corsOptions));

  const respondToPreflight = (req, res, next) => cors(corsOptions)(req, res, (err) => {
    if (err) return next(err);
    if (!res.headersSent) {
      res.sendStatus(204);
    }
    return undefined;
  });

  // Some deployments intermittently miss the global OPTIONS route for mounted API routers.
  // Short-circuit all API preflights here so authenticated cross-origin requests stay reliable.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'OPTIONS') {
      return next();
    }
    return respondToPreflight(req, res, next);
  });

  app.use(rateLimit);
  app.use(requestTiming);

  // Stripe webhook needs the raw body for signature verification.
  app.post(
    '/api/payments/stripe/webhook',
    express.raw({ type: 'application/json' }),
    (req, res, next) => getPaymentRoutes().handleStripeWebhook(req, res, next),
  );

  app.use(bodyParser.json({ limit: env.bodyParser.limit }));
  app.use(bodyParser.urlencoded({ limit: env.bodyParser.limit, extended: true }));

  // Handle CORS preflight for all API routes without redirecting.
  // Express 5 disallows plain "*" path strings; use a regex matcher instead.
  // Some deployments return a 404 for preflight when CORS rejects the origin;
  // ensure we always send a response (and let CORS attach headers when allowed).
  app.options(/.*/, respondToPreflight);

  if (typeof logger.isLevelEnabled !== 'function' || logger.isLevelEnabled('debug')) {
    app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, 'Incoming request');
      next();
    });
  }

  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        logger.warn(
          {
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            userId: req.user?.id || null,
          },
          'Request returned client or server error',
        );
      }
    });
    next();
  });

  app.use('/api/auth', lazyRoute(() => getAuthRoutes()));
  app.use('/api/orders', lazyRoute(() => getOrderRoutes()));
  app.use('/api/payments', lazyRoute(() => getPaymentRoutes().router));
  app.use('/api/shipping', lazyRoute(() => getShippingRoutes()));
  app.use('/api/referrals', lazyRoute(() => getReferralRoutes()));
  app.use('/api/woo', lazyRoute(() => getWooRoutes()));
  app.use('/api/catalog', lazyRoute(() => getCatalogRoutes()));
  app.use('/api/quotes', lazyRoute(() => getQuotesRoutes()));
  app.use('/api/news', lazyRoute(() => getNewsRoutes()));
  app.use('/api/password-reset', lazyRoute(() => getPasswordResetRoutes()));
  app.use('/api/contact', lazyRoute(() => getContactRoutes()));
  app.use('/api/bugs', lazyRoute(() => getBugRoutes()));
  app.use('/api/settings', lazyRoute(() => getSettingsRoutes()));
  app.use('/api/moderation', lazyRoute(() => getModerationRoutes()));
  app.use('/api/forum', lazyRoute(() => getPeptideForumRoutes()));
  app.use('/api/integrations/google-sheets', lazyRoute(() => getGoogleSheetsRoutes()));
  app.use('/api/integrations/shipstation', lazyRoute(() => getShipStationRoutes()));
  app.use('/api/integrations/seamless', lazyRoute(() => getSeamlessRoutes()));
  app.use('/api/tracking', lazyRoute(() => getTrackingRoutes()));
  app.use('/api/delegation', lazyRoute(() => getDelegationRoutes()));
  app.use('/api/usage-tracking', lazyRoute(() => getUsageTrackingRoutes()));
  app.use('/api', lazyRoute(() => getSystemRoutes()));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // In development, Vite serves the frontend on port 3000, so skip bundled-frontend
  // discovery/mounting here to keep backend startup predictable.
  if (env.nodeEnv === 'production') {
    const frontendResolved = resolveFrontendRoot();
    const frontendRoot = frontendResolved?.root || null;
    const frontendBase = frontendResolved?.base || process.cwd();
    if (frontendRoot) {
      logger.info({ frontendRoot, frontendBase }, 'Serving bundled frontend');
      const contentRoot = path.join(frontendBase, 'src', 'content');
      if (fs.existsSync(contentRoot)) {
        app.use('/content', express.static(contentRoot));
      }
      app.use(express.static(frontendRoot));
      app.get(/^\/(?!api\/).*/, (req, res, next) => res.sendFile(path.join(frontendRoot, 'index.html')));
    }
  }

  app.use((err, req, res, _next) => {
    const status = Number.isFinite(err?.status) ? err.status : 500;
    const isProduction = env.nodeEnv === 'production';
    const isClientError = status >= 400 && status < 500;
    const exposeMessage = isClientError || !isProduction;
    const publicMessage = exposeMessage ? err?.message : 'Internal server error';
    logger.error({ err, path: req.path, status }, 'Unhandled application error');
    res.status(status).json({
      error: sanitizePublicMessage(publicMessage || 'Internal server error'),
      code: typeof err?.code === 'string' ? err.code : undefined,
      details: isClientError && err?.details !== undefined ? err.details : undefined,
    });
  });

  app.prewarmApiModules = prewarmApiModules;

  return app;
};

module.exports = createApp;
