const { env } = require('../config/env');
const { logger } = require('../config/logger');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const os = require('os');

const getServerUsage = () => {
  try {
    const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : null;
    const load = Array.isArray(os.loadavg()) ? os.loadavg() : [];
    const one = typeof load[0] === 'number' ? load[0] : null;
    const loadAvg = one !== null ? { '1m': Number(one.toFixed(2)), '5m': Number((load[1] || 0).toFixed(2)), '15m': Number((load[2] || 0).toFixed(2)) } : null;
    const loadPercent = one !== null && cpuCount ? Number(((one / cpuCount) * 100).toFixed(2)) : null;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem > 0 ? totalMem - freeMem : 0;
    const memUsedPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(2)) : null;
    const memory = totalMem > 0 ? { totalMb: Number((totalMem / (1024 * 1024)).toFixed(2)), availableMb: Number((freeMem / (1024 * 1024)).toFixed(2)), usedPercent: memUsedPercent } : null;

    const rss = process?.memoryUsage ? process.memoryUsage().rss : null;
    const processMem = typeof rss === 'number' ? { rssMb: Number((rss / (1024 * 1024)).toFixed(2)) } : null;

    return {
      cpu: { count: cpuCount, loadAvg, loadPercent },
      memory,
      process: processMem,
      platform: `${os.platform()} ${os.release()}`,
    };
  } catch {
    return null;
  }
};

const getHealth = (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    build: env.backendBuild,
    usage: getServerUsage(),
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
