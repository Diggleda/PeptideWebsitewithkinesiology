const { env } = require('../config/env');

const rateLimitEnabled = env.rateLimit?.enabled !== false;

const WINDOW_SECONDS = env.rateLimit?.windowSeconds || 60;
const DEFAULT_LIMIT = env.rateLimit?.maxRequests || 300;
const EXPENSIVE_LIMIT = env.rateLimit?.maxRequestsExpensive || 80;
const AUTH_LIMIT = env.rateLimit?.maxRequestsAuth || 40;

const hits = new Map();

const getClientIp = (req) => {
  const candidate = req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']
    || req.socket?.remoteAddress
    || req.ip
    || 'unknown';
  if (Array.isArray(candidate)) {
    return String(candidate[0] || 'unknown').split(',')[0].trim() || 'unknown';
  }
  return String(candidate).split(',')[0].trim() || 'unknown';
};

const isApiPath = (path) => (path || '').startsWith('/api');

const isExempt = (path) => {
  if (!path) return true;
  if (path === '/api/health' || path === '/api/help') return true;
  if (path === '/api/payments/stripe/webhook') return true;
  return false;
};

const bucketFor = (path) => {
  if (!path) return 'default';
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/api/orders/sales-rep')) return 'orders_sales_rep';
  if (path.startsWith('/api/woo')) return 'woo';
  if (path.startsWith('/api/shipping')) return 'shipping';
  return 'default';
};

const limitForBucket = (bucket) => {
  switch (bucket) {
    case 'auth':
      return AUTH_LIMIT;
    case 'orders_sales_rep':
    case 'woo':
    case 'shipping':
      return EXPENSIVE_LIMIT;
    default:
      return DEFAULT_LIMIT;
  }
};

const pruneBucket = (timestamps, cutoff) => {
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
};

const rateLimit = (req, res, next) => {
  if (!rateLimitEnabled) {
    return next();
  }

  if (req.method === 'OPTIONS') {
    return next();
  }

  const path = req.path || req.originalUrl || '';
  if (!isApiPath(path) || isExempt(path)) {
    return next();
  }

  const ip = getClientIp(req);
  const bucket = bucketFor(path);
  const limit = limitForBucket(bucket);
  const now = Date.now();
  const cutoff = now - WINDOW_SECONDS * 1000;
  const key = `${ip}:${bucket}`;

  const timestamps = hits.get(key) || [];
  pruneBucket(timestamps, cutoff);

  if (timestamps.length >= limit) {
    const oldest = timestamps[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_SECONDS * 1000 - (now - oldest)) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
      retryAfterSeconds,
    });
  }

  timestamps.push(now);
  hits.set(key, timestamps);
  return next();
};

module.exports = { rateLimit };

