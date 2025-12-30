const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const loadEnvFile = (filePath, { override } = {}) => {
  if (!filePath) {
    return false;
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return false;
  }
  dotenv.config({ path: resolved, override });
  return true;
};

if (process.env.DOTENV_CONFIG_PATH) {
  loadEnvFile(process.env.DOTENV_CONFIG_PATH, { override: true });
} else {
  // Always load .env as the baseline configuration
  loadEnvFile(path.join(process.cwd(), '.env'));

  // When running in production, allow .env.production to override only the specific keys it defines.
  if (process.env.NODE_ENV === 'production') {
    loadEnvFile(path.join(process.cwd(), '.env.production'), { override: true });
  }
}

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

// Stripe Tax defaults
const DEFAULT_STRIPE_TAX_CODE = 'txcd_99999999'; // tangible personal property
const DEFAULT_STRIPE_SHIPPING_TAX_CODE = 'txcd_92010001'; // shipping / delivery charges

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toNumber(process.env.PORT, 3001),
  allowPortFallback: process.env.ALLOW_PORT_FALLBACK === 'true',
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  dataDir: resolvePath(process.env.DATA_DIR, 'server-data'),
  cors: {
    allowList: parseList(process.env.CORS_ALLOW_ORIGINS || '*'),
  },
  bodyParser: {
    // Allow larger payloads (e.g., base64 image uploads). Base64 adds ~33% overhead,
    // so default to 50mb to comfortably support ~25-35mb binary images.
    limit: process.env.BODY_LIMIT || '50mb',
  },
  backendBuild: process.env.BACKEND_BUILD || 'v1.9.51',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  logPretty: process.env.LOG_PRETTY === 'true',
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowSeconds: Math.max(10, Math.min(toNumber(process.env.RATE_LIMIT_WINDOW_SECONDS, 60), 10 * 60)),
    maxRequests: Math.max(30, Math.min(toNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 300), 5000)),
    maxRequestsExpensive: Math.max(10, Math.min(toNumber(process.env.RATE_LIMIT_MAX_REQUESTS_EXPENSIVE, 80), 1000)),
    maxRequestsAuth: Math.max(5, Math.min(toNumber(process.env.RATE_LIMIT_MAX_REQUESTS_AUTH, 40), 500)),
  },
  wooCommerce: {
    storeUrl: process.env.WC_STORE_URL || '',
    consumerKey: process.env.WC_CONSUMER_KEY || '',
    consumerSecret: process.env.WC_CONSUMER_SECRET || '',
    apiVersion: process.env.WC_API_VERSION || 'wc/v3',
    autoSubmitOrders: process.env.WC_AUTO_SUBMIT_ORDERS === 'true',
    requestTimeoutMs: toNumber(process.env.WC_REQUEST_TIMEOUT_MS, 25000),
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
  passkeys: {
    rpId: process.env.PASSKEY_RP_ID || '',
    rpName: process.env.PASSKEY_RP_NAME || 'PepPro',
    origins: parseList(process.env.PASSKEY_ALLOWED_ORIGINS || ''),
  },
  quotes: {
    sourceUrl: process.env.QUOTES_SOURCE_URL || 'https://port.peppro.net/api/integrations/google-sheets/quotes/quotes.php',
    secret: process.env.QUOTES_WEBHOOK_SECRET || process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || '',
  },
  frontendBaseUrl: process.env.FRONTEND_BASE_URL
    || process.env.APP_BASE_URL
    || 'http://localhost:3000',
  stripe: {
    onsiteEnabled: process.env.STRIPE_ONSITE_ENABLED === 'true',
    // Support switching between Stripe test/live without rewriting env files.
    // - STRIPE_MODE=test  -> STRIPE_SECRET_TEST_KEY (fallback STRIPE_SECRET_KEY)
    // - STRIPE_MODE=live  -> STRIPE_SECRET_KEY
    // Frontend uses VITE_STRIPE_MODE; allow using one value across services.
    mode: process.env.STRIPE_MODE || process.env.VITE_STRIPE_MODE || 'test',
    secretKey: (() => {
      const mode = String(
        process.env.STRIPE_MODE || process.env.VITE_STRIPE_MODE || 'test',
      )
        .toLowerCase()
        .trim();
      const liveKey = process.env.STRIPE_SECRET_KEY || '';
      const testKey = process.env.STRIPE_SECRET_TEST_KEY || '';
      if (mode === 'live') {
        return liveKey;
      }
      return testKey || liveKey;
    })(),
    liveSecretKey: process.env.STRIPE_SECRET_KEY || '',
    testSecretKey: process.env.STRIPE_SECRET_TEST_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // Publishable keys (browser) — safe to expose to Vite via VITE_ prefix.
    publishableKey: (() => {
      const mode = String(
        process.env.STRIPE_MODE || process.env.VITE_STRIPE_MODE || 'test',
      )
        .toLowerCase()
        .trim();
      const liveKey = process.env.VITE_STRIPE_PUBLISHABLE_KEY || '';
      const testKey = process.env.VITE_STRIPE_PUBLISHABLE_TEST_KEY || '';
      if (mode === 'live') {
        return liveKey;
      }
      return testKey || liveKey;
    })(),
    livePublishableKey: process.env.VITE_STRIPE_PUBLISHABLE_KEY || '',
    testPublishableKey: process.env.VITE_STRIPE_PUBLISHABLE_TEST_KEY || '',
    taxEnabled: process.env.STRIPE_TAX_ENABLED !== 'false',
    defaultTaxCode: process.env.STRIPE_TAX_CODE || DEFAULT_STRIPE_TAX_CODE,
    shippingTaxCode: process.env.STRIPE_TAX_SHIPPING_CODE
      || DEFAULT_STRIPE_SHIPPING_TAX_CODE,
    taxDebug: process.env.STRIPE_TAX_DEBUG === 'true',
  },
  shipStation: {
    // V2 bearer token support; fall back to legacy key/secret if provided
    apiToken: process.env.SHIPSTATION_API_TOKEN || process.env.SHIPSTATION_PRODUCTION_KEY || '',
    apiKey: process.env.SHIPSTATION_API_KEY || '',
    apiSecret: process.env.SHIPSTATION_API_SECRET || '',
    storeId: process.env.SHIPSTATION_STORE_ID || '',
    carrierCode: process.env.SHIPSTATION_CARRIER_CODE || '',
    serviceCode: process.env.SHIPSTATION_SERVICE_CODE || '',
    packageCode: process.env.SHIPSTATION_PACKAGE_CODE || 'package',
    shipFrom: {
      name: process.env.SHIPSTATION_SHIP_FROM_NAME || '',
      company: process.env.SHIPSTATION_SHIP_FROM_COMPANY || '',
      addressLine1: process.env.SHIPSTATION_SHIP_FROM_ADDRESS1 || '',
      addressLine2: process.env.SHIPSTATION_SHIP_FROM_ADDRESS2 || '',
      city: process.env.SHIPSTATION_SHIP_FROM_CITY || '',
      state: process.env.SHIPSTATION_SHIP_FROM_STATE || '',
      postalCode: process.env.SHIPSTATION_SHIP_FROM_POSTAL || '',
      countryCode: process.env.SHIPSTATION_SHIP_FROM_COUNTRY || 'US',
      phone: process.env.SHIPSTATION_SHIP_FROM_PHONE || '',
    },
  },
  orderSync: {
    enabled: process.env.ORDER_SYNC_ENABLED !== 'false',
    // Background task to keep MySQL in sync with WooCommerce/local orders
    intervalMs: toNumber(process.env.ORDER_SYNC_INTERVAL_MS, 5 * 60 * 1000),
  },
};

env.mysql = {
  enabled: process.env.MYSQL_ENABLED === 'true',
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: toNumber(process.env.MYSQL_PORT, 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'peppro',
  connectionLimit: toNumber(process.env.MYSQL_CONNECTION_LIMIT, 8),
  ssl: process.env.MYSQL_SSL === 'true',
  timezone: process.env.MYSQL_TIMEZONE || 'Z',
};

const isProduction = env.nodeEnv === 'production';

module.exports = {
  env,
  isProduction,
};
