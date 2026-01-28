const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { router: paymentRoutes, handleStripeWebhook } = require('./routes/paymentRoutes');
const authRoutes = require('./routes/authRoutes');
const orderRoutes = require('./routes/orderRoutes');
const systemRoutes = require('./routes/systemRoutes');
const newsRoutes = require('./routes/newsRoutes');
const wooRoutes = require('./routes/wooRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const quotesRoutes = require('./routes/quotesRoutes');
const shippingRoutes = require('./routes/shippingRoutes');
const referralRoutes = require('./routes/referralRoutes');
const passwordResetRoutes = require('./routes/passwordReset');
const contactRoutes = require('./routes/contactRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const peptideForumRoutes = require('./routes/peptideForumRoutes');
const googleSheetsRoutes = require('./routes/googleSheetsRoutes');
const shipStationRoutes = require('./routes/shipStationRoutes');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { requestContext } = require('./config/requestContext');
const { rateLimit } = require('./middleware/rateLimit');

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
  const allowList = Array.isArray(env.cors?.allowList) ? env.cors.allowList : [];
  const allowAll = allowList.includes('*');
  if (allowAll) {
    return { origin: true, credentials: true };
  }

  const isDev = env.nodeEnv !== 'production';

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
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowList.includes(origin)) {
        callback(null, true);
        return;
      }
      if (isDev && isDevLocalOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
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

  app.use(rateLimit);

  // Stripe webhook needs the raw body for signature verification.
  app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

  app.use(bodyParser.json({ limit: env.bodyParser.limit }));
  app.use(bodyParser.urlencoded({ limit: env.bodyParser.limit, extended: true }));

  // Handle CORS preflight for all API routes without redirecting.
  // Express 5 disallows plain "*" path strings; use a regex matcher instead.
  app.options(/.*/, cors(corsOptions));

  app.use((req, res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'Incoming request');
    next();
  });

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

  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/shipping', shippingRoutes);
  app.use('/api/referrals', referralRoutes);
  app.use('/api/woo', wooRoutes);
  app.use('/api/catalog', catalogRoutes);
  app.use('/api/quotes', quotesRoutes);
  app.use('/api/news', newsRoutes);
  app.use('/api/password-reset', passwordResetRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/forum', peptideForumRoutes);
  app.use('/api/integrations/google-sheets', googleSheetsRoutes);
  app.use('/api/integrations/shipstation', shipStationRoutes);
  app.use('/api', systemRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Serve the built frontend for local/test usage when present.
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

  return app;
};

module.exports = createApp;
