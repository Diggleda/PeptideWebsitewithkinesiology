const wooCommerceClient = require('../integration/wooCommerceClient');

const allowedExactEndpoints = new Set(['products', 'products/categories']);
const allowedPatternEndpoints = [/^products\/[A-Za-z0-9_-]+$/];

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

const proxyCatalog = async (req, res, next) => {
  try {
    const requestedEndpoint = normalizeEndpoint(req.params[0] || '');
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

module.exports = {
  proxyCatalog,
};
