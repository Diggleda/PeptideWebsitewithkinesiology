const path = require('path');
const dotenv = require('dotenv');

const envFile = process.env.DOTENV_CONFIG_PATH
  ? path.resolve(process.env.DOTENV_CONFIG_PATH)
  : path.join(process.cwd(), '.env');

dotenv.config({ path: envFile });

const toNumber = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseList = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const resolvePath = (value, fallback) => {
  const candidate = value || fallback;
  if (!candidate) {
    return candidate;
  }

  return path.isAbsolute(candidate)
    ? candidate
    : path.join(process.cwd(), candidate);
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toNumber(process.env.PORT, 3001),
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  dataDir: resolvePath(process.env.DATA_DIR, 'server-data'),
  cors: {
    allowList: parseList(process.env.CORS_ALLOW_ORIGINS || '*'),
  },
  bodyParser: {
    limit: process.env.BODY_LIMIT || '1mb',
  },
  backendBuild: process.env.BACKEND_BUILD || '2024.10.01-02',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  wooCommerce: {
    storeUrl: process.env.WC_STORE_URL || '',
    consumerKey: process.env.WC_CONSUMER_KEY || '',
    consumerSecret: process.env.WC_CONSUMER_SECRET || '',
    apiVersion: process.env.WC_API_VERSION || 'wc/v3',
    autoSubmitOrders: process.env.WC_AUTO_SUBMIT_ORDERS === 'true',
  },
  shipEngine: {
    apiKey: process.env.SHIPENGINE_API_KEY || '',
    accountId: process.env.SHIPENGINE_ACCOUNT_ID || '',
    defaultCarrierId: process.env.SHIPENGINE_CARRIER_ID || '',
    defaultServiceCode: process.env.SHIPENGINE_SERVICE_CODE || '',
    shipFromName: process.env.SHIPENGINE_SHIP_FROM_NAME || '',
    shipFromAddress1: process.env.SHIPENGINE_SHIP_FROM_ADDRESS1 || '',
    shipFromAddress2: process.env.SHIPENGINE_SHIP_FROM_ADDRESS2 || '',
    shipFromCity: process.env.SHIPENGINE_SHIP_FROM_CITY || '',
    shipFromState: process.env.SHIPENGINE_SHIP_FROM_STATE || '',
    shipFromPostalCode: process.env.SHIPENGINE_SHIP_FROM_POSTAL || '',
    shipFromCountry: process.env.SHIPENGINE_SHIP_FROM_COUNTRY || 'US',
    autoCreateLabels: process.env.SHIPENGINE_AUTO_CREATE_LABELS === 'true',
  },
};

const isProduction = env.nodeEnv === 'production';

module.exports = {
  env,
  isProduction,
};
