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

const runtimeNodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const normalizeRealPath = (target) => {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};
const pathWithinRoot = (candidate, root) => {
  const relative = path.relative(normalizeRealPath(root), normalizeRealPath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

if (process.env.DOTENV_CONFIG_PATH) {
  if (runtimeNodeEnv === 'production' && pathWithinRoot(process.env.DOTENV_CONFIG_PATH, process.cwd())) {
    throw new Error('DOTENV_CONFIG_PATH must reference a server-managed file outside the repo in production');
  }
  loadEnvFile(process.env.DOTENV_CONFIG_PATH, { override: true });
} else if (runtimeNodeEnv !== 'production') {
  loadEnvFile(path.join(process.cwd(), '.env'));
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

const parseBooleanEnv = (value) => {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return null;
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

const resolveBackendBuild = () => {
  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const version = String(parsed?.version || '').trim();
      if (version) {
        return version.toLowerCase().startsWith('v') ? version : `v${version}`;
      }
    }
  } catch {
    // ignore
  }
  return 'unknown';
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
  backendBuild: process.env.BACKEND_BUILD || resolveBackendBuild(),
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  logPretty: process.env.LOG_PRETTY === 'true',
  perf: {
    enabled: process.env.PERF_LOG_ENABLED !== 'false',
    onlyApi: process.env.PERF_LOG_ONLY_API !== 'false',
    slowRequestMs: Math.max(50, Math.min(toNumber(process.env.PERF_SLOW_REQUEST_MS, 400), 60_000)),
    summaryIntervalMs: Math.max(
      10_000,
      Math.min(toNumber(process.env.PERF_SUMMARY_INTERVAL_MS, 5 * 60 * 1000), 60 * 60 * 1000),
    ),
    topRoutes: Math.max(1, Math.min(toNumber(process.env.PERF_TOP_ROUTES, 5), 20)),
    minHitsForSummary: Math.max(1, Math.min(toNumber(process.env.PERF_MIN_HITS_FOR_SUMMARY, 5), 500)),
  },
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
  googleSheets: {
    webhookSecret: process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || '',
    peptideForumWebhookSecret:
      process.env.PEPTIDE_FORUM_WEBHOOK_SECRET
      || process.env.GOOGLE_SHEETS_WEBHOOK_SECRET
      || '',
  },
  frontendBaseUrl: process.env.FRONTEND_BASE_URL
    || process.env.APP_BASE_URL
    || 'http://localhost:3000',
  encryption: {
    key: process.env.DATA_ENCRYPTION_KEY || '',
    algorithm: process.env.DATA_ENCRYPTION_ALGO || 'aes-256-gcm',
    keyVersion: process.env.DATA_ENCRYPTION_KEY_VERSION || 'local-v1',
    kmsKeyId: process.env.DATA_ENCRYPTION_KMS_KEY_ID || '',
    blindIndexKey: process.env.DATA_ENCRYPTION_BLIND_INDEX_KEY || '',
  },
  stripe: {
    // Master switch to disable all outbound Stripe API usage while keeping code in place.
    externalEnabled: process.env.STRIPE_EXTERNAL_ENABLED === 'true',
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
    orderStatusLookupsEnabled: (() => {
      const explicit = parseBooleanEnv(process.env.SHIPSTATION_ORDER_STATUS_LOOKUPS_ENABLED);
      if (explicit !== null) {
        return explicit;
      }
      return process.env.NODE_ENV === 'production';
    })(),
    storeId: process.env.SHIPSTATION_STORE_ID || '',
    webhookSecret: process.env.SHIPSTATION_WEBHOOK_SECRET || '',
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
  shipStationSync: {
    enabled: process.env.SHIPSTATION_STATUS_SYNC_ENABLED !== 'false',
    intervalMs: toNumber(process.env.SHIPSTATION_STATUS_SYNC_INTERVAL_MS, 60 * 1000),
    lookbackDays: toNumber(process.env.SHIPSTATION_STATUS_SYNC_LOOKBACK_DAYS, 60),
    maxOrders: toNumber(process.env.SHIPSTATION_STATUS_SYNC_MAX_ORDERS, 80),
  },
  ups: {
    clientId: process.env.UPS_CLIENT_ID || '',
    clientSecret: process.env.UPS_CLIENT_SECRET || '',
    merchantId: process.env.UPS_MERCHANT_ID || '',
    useCie: parseBooleanEnv(process.env.UPS_USE_CIE) === true,
    locale: process.env.UPS_LOCALE || 'en_US',
    transactionSrc: process.env.UPS_TRANSACTION_SRC || 'peppro',
    requestTimeoutMs: toNumber(process.env.UPS_REQUEST_TIMEOUT_MS, 15_000),
  },
  upsSync: {
    enabled: process.env.UPS_STATUS_SYNC_ENABLED !== 'false',
    intervalMs: toNumber(process.env.UPS_STATUS_SYNC_INTERVAL_MS, 5 * 60 * 1000),
    lookbackDays: toNumber(process.env.UPS_STATUS_SYNC_LOOKBACK_DAYS, 60),
    maxOrders: toNumber(process.env.UPS_STATUS_SYNC_MAX_ORDERS, 50),
    throttleMs: toNumber(process.env.UPS_STATUS_SYNC_THROTTLE_MS, 150),
  },
  orderSync: {
    enabled: process.env.ORDER_SYNC_ENABLED !== 'false',
    // Background task to keep MySQL in sync with WooCommerce/local orders
    intervalMs: toNumber(process.env.ORDER_SYNC_INTERVAL_MS, 5 * 60 * 1000),
  },
  crm: {
    seamlessEnabled: process.env.CRM_SEAMLESS_ENABLED === 'true',
    seamlessReconciliationIntervalMs: toNumber(
      process.env.CRM_SEAMLESS_RECONCILIATION_INTERVAL_MS,
      15 * 60 * 1000,
    ),
  },
  seamless: {
    apiBaseUrl: process.env.SEAMLESS_API_BASE_URL || 'https://api.seamless.ai/api/client/v1',
    apiKey: process.env.SEAMLESS_API_KEY || '',
    oauthAccessToken: process.env.SEAMLESS_OAUTH_ACCESS_TOKEN || '',
    webhookSecret: process.env.SEAMLESS_WEBHOOK_SECRET || '',
    contactsPath: process.env.SEAMLESS_CONTACTS_PATH || '/contacts',
    companiesPath: process.env.SEAMLESS_COMPANIES_PATH || '/companies',
    backfillPath: process.env.SEAMLESS_BACKFILL_PATH || '/contacts',
    backfillLimit: Math.max(1, Math.min(toNumber(process.env.SEAMLESS_BACKFILL_LIMIT, 100), 500)),
    backfillMaxPages: Math.max(1, Math.min(toNumber(process.env.SEAMLESS_BACKFILL_MAX_PAGES, 10), 200)),
    backfillLookbackHours: Math.max(
      1,
      Math.min(toNumber(process.env.SEAMLESS_BACKFILL_LOOKBACK_HOURS, 24), 24 * 90),
    ),
    includeCompaniesBackfill: parseBooleanEnv(process.env.SEAMLESS_INCLUDE_COMPANIES_BACKFILL) === true,
    requestTimeoutMs: toNumber(process.env.SEAMLESS_REQUEST_TIMEOUT_MS, 15000),
  },
};

const mysqlEnabledFlag = parseBooleanEnv(process.env.MYSQL_ENABLED);
const hasMysqlConfig = Boolean(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE);

env.mysql = {
  enabled: mysqlEnabledFlag === true || (mysqlEnabledFlag === null && hasMysqlConfig),
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: toNumber(process.env.MYSQL_PORT, 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'peppro',
  connectionLimit: toNumber(process.env.MYSQL_CONNECTION_LIMIT, 8),
  ssl: process.env.MYSQL_SSL === 'true',
  sslRequireNegotiated: process.env.MYSQL_SSL_ENFORCE === 'true',
  timezone: process.env.MYSQL_TIMEZONE || 'Z',
};

const isProduction = env.nodeEnv === 'production';

const assertHttpsUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return;
  if (/^https:\/\//i.test(raw)) return;
  throw new Error(`Expected HTTPS URL in production, received: ${raw}`);
};

const validateSecureEnv = () => {
  if (!isProduction) {
    return;
  }
  if (!process.env.JWT_SECRET || env.jwtSecret === 'your-secret-key-change-in-production') {
    throw new Error('JWT_SECRET must be set to a strong value in production');
  }
  if (!String(env.encryption?.key || '').trim()) {
    throw new Error('DATA_ENCRYPTION_KEY must be configured in production');
  }
  const mysqlHost = String(env.mysql?.host || '').trim().toLowerCase();
  const mysqlIsLocal = mysqlHost === '' || mysqlHost === 'localhost' || mysqlHost === '127.0.0.1' || mysqlHost === '::1';
  if (env.mysql?.enabled && env.mysql.ssl !== true && !mysqlIsLocal) {
    throw new Error('MYSQL_SSL=true is required in production when MySQL is enabled on a non-local host');
  }
  if (process.env.REDIS_URL && !String(process.env.REDIS_URL).trim().toLowerCase().startsWith('rediss://')) {
    throw new Error('REDIS_URL must use rediss:// in production');
  }
  assertHttpsUrl(env.frontendBaseUrl);
};

validateSecureEnv();

module.exports = {
  env,
  isProduction,
};
