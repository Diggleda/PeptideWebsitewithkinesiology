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
const { env } = require('./config/env');
const { logger } = require('./config/logger');

const createApp = () => {
  const app = express();

  const corsOptions = Array.isArray(env.cors.allowList) && env.cors.allowList.length > 0
    ? {
      origin: env.cors.allowList.includes('*')
        ? true
        : env.cors.allowList,
      credentials: true,
    }
    : undefined;

  if (corsOptions) {
    app.use(cors(corsOptions));
  } else {
    app.use(cors());
  }

  // Stripe webhook needs the raw body for signature verification.
  app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

  app.use(bodyParser.json({ limit: env.bodyParser.limit }));

  // Handle CORS preflight for all API routes without redirecting.
  app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
    res.status(204).end();
  });

  app.use((req, res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'Incoming request');
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/woo', wooRoutes);
  app.use('/api/quotes', quotesRoutes);
  app.use('/api/news', newsRoutes);
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
