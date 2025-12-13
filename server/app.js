const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { router: paymentRoutes, handleStripeWebhook } = require('./routes/paymentRoutes');
const authRoutes = require('./routes/authRoutes');
const orderRoutes = require('./routes/orderRoutes');
const systemRoutes = require('./routes/systemRoutes');
const newsRoutes = require('./routes/newsRoutes');
const wooRoutes = require('./routes/wooRoutes');
const quotesRoutes = require('./routes/quotesRoutes');
const shippingRoutes = require('./routes/shippingRoutes');
const referralRoutes = require('./routes/referralRoutes');
const passwordResetRoutes = require('./routes/passwordReset');
const contactRoutes = require('./routes/contactRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const { env } = require('./config/env');
const { logger } = require('./config/logger');

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

  const corsOptions = buildCorsOptions();
  app.use(cors(corsOptions));

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
  app.use('/api/quotes', quotesRoutes);
  app.use('/api/news', newsRoutes);
  app.use('/api/password-reset', passwordResetRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api', systemRoutes);

  app.use((err, req, res, _next) => {
    logger.error({ err, path: req.path }, 'Unhandled application error');
    res.status(err.status || 500).json({
      error: err.message || 'Internal server error',
    });
  });

  return app;
};

module.exports = createApp;
