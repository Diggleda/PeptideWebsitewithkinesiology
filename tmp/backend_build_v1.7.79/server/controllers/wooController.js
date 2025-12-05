const axios = require('axios');
const wooCommerceClient = require('../integration/wooCommerceClient');
const { env } = require('../config/env');

const allowedExactEndpoints = new Set(['products', 'products/categories']);
const allowedPatternEndpoints = [
  /^products\/[A-Za-z0-9_-]+$/,
  /^products\/[A-Za-z0-9_-]+\/variations$/,
];

const normalizeEndpoint = (value) => value.replace(/^\/+|\/+$/g, '');

const isAllowedEndpoint = (endpoint) => (
  allowedExactEndpoints.has(endpoint)
  || allowedPatternEndpoints.some((pattern) => pattern.test(endpoint))
);

const createHttpError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const resolveWooHostnames = () => {
  if (!env?.wooCommerce?.storeUrl) {
    return new Set();
  }
  try {
    const parsed = new URL(env.wooCommerce.storeUrl);
    return new Set([parsed.hostname]);
  } catch {
    return new Set();
  }
};

const allowedMediaHosts = resolveWooHostnames();

const sanitizeMediaUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    if (!allowedMediaHosts.has(parsed.hostname)) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join('/');
    return parsed.toString();
  } catch {
    return null;
  }
};

const proxyCatalog = async (req, res, next) => {
  try {
    // Support both wildcard param capture (e.g. '/*') and middleware usage
    // where we rely on req.path under the '/api/woo' mount.
    const requestedEndpoint = normalizeEndpoint((req.params && (req.params[0] || req.params.path)) || req.path || '');
    if (!requestedEndpoint) {
      throw createHttpError('Missing WooCommerce endpoint', 400);
    }

    if (!isAllowedEndpoint(requestedEndpoint)) {
      throw createHttpError(`Unsupported WooCommerce endpoint: ${requestedEndpoint}`, 404);
    }

    const data = await wooCommerceClient.fetchCatalog(requestedEndpoint, req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const proxyMedia = async (req, res, next) => {
  try {
    const source = sanitizeMediaUrl(req.query?.src);
    if (!source) {
      throw createHttpError('Invalid media source', 400);
    }
    const response = await axios.get(source, {
      responseType: 'stream',
      timeout: 15000,
    });
    res.set('Cache-Control', 'public, max-age=300');
    if (response.headers['content-type']) {
      res.set('Content-Type', response.headers['content-type']);
    }
    response.data.pipe(res);
  } catch (error) {
    if (error.response?.status === 404) {
      res.status(404).end();
      return;
    }
    next(error);
  }
};

module.exports = {
  proxyCatalog,
  proxyMedia,
};
