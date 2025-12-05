const { env } = require('../config/env');
const { logger } = require('../config/logger');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');

const getHealth = (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    build: env.backendBuild,
    timestamp: new Date().toISOString(),
  });
};

const getHelp = (_req, res) => {
  const payload = {
    ok: true,
    service: 'PepPro Backend',
    build: env.backendBuild,
    integrations: {
      wooCommerce: {
        configured: wooCommerceClient.isConfigured(),
      },
      shipEngine: {
        configured: shipEngineClient.isConfigured(),
      },
      shipStation: {
        configured: shipStationClient.isConfigured(),
      },
      mysql: {
        enabled: env.mysql?.enabled === true,
      },
    },
    endpoints: [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/me',
      '/api/auth/check-email',
      '/api/orders',
      '/api/shipping/rates',
      '/api/quotes/daily',
      '/api/quotes',
      '/api/woo/products',
      '/api/woo/products/categories',
      '/api/referrals/doctor/summary',
      '/api/referrals/admin/dashboard',
      '/api/integrations/google-sheets/sales-reps',
      '/api/help',
      '/api/health',
    ],
    timestamp: new Date().toISOString(),
  };

  logger.info({ build: env.backendBuild }, 'Backend help accessed');
  res.json(payload);
};

module.exports = {
  getHealth,
  getHelp,
};
