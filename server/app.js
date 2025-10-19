const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const authRoutes = require('./routes/authRoutes');
const orderRoutes = require('./routes/orderRoutes');
const systemRoutes = require('./routes/systemRoutes');
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

  app.use(bodyParser.json({ limit: env.bodyParser.limit }));

  app.use((req, res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'Incoming request');
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderRoutes);
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
