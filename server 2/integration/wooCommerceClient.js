const axios = require('axios');
const crypto = require('crypto');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const isConfigured = () => Boolean(
  env.wooCommerce.storeUrl
  && env.wooCommerce.consumerKey
  && env.wooCommerce.consumerSecret,
);

const shouldAutoSubmitOrders = env.wooCommerce.autoSubmitOrders === true;

const allowedCatalogQueryKeys = new Set([
  'per_page',
  'page',
  'search',
  'status',
  'orderby',
  'order',
  'slug',
  'sku',
  'category',
  'tag',
  'type',
  'featured',
  'stock_status',
  'min_price',
  'max_price',
  'before',
  'after',
]);

const sanitizeQueryValue = (value) => {
  if (Array.isArray(value)) {
    return sanitizeQueryValue(value[value.length - 1]);
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
};

const sanitizeQueryParams = (query = {}) => {
  if (!query || typeof query !== 'object') {
    return {};
  }

  return Object.entries(query).reduce((acc, [key, value]) => {
    if (!allowedCatalogQueryKeys.has(key)) {
      return acc;
    }

    const sanitizedValue = sanitizeQueryValue(value);
    if (sanitizedValue === undefined) {
      return acc;
    }

    acc[key] = sanitizedValue;
    return acc;
  }, {});
};

const getClient = () => {
  if (!isConfigured()) {
    throw new Error('WooCommerce is not configured');
  }

  return axios.create({
    baseURL: `${env.wooCommerce.storeUrl.replace(/\/+$/, '')}/wp-json/${env.wooCommerce.apiVersion.replace(/^\/+/, '')}`,
    auth: {
      username: env.wooCommerce.consumerKey,
      password: env.wooCommerce.consumerSecret,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
  });
};

const buildLineItems = (items) => items.map((item) => ({
  name: item.name,
  sku: item.productId,
  quantity: item.quantity,
  total: Number(item.price * item.quantity).toFixed(2),
  meta_data: item.note ? [{ key: 'note', value: item.note }] : [],
}));

const buildOrderPayload = ({ order, customer }) => ({
  status: 'pending',
  customer_note: order.referralCode
    ? `Referral code used: ${order.referralCode}`
    : '',
  set_paid: false,
  line_items: buildLineItems(order.items || []),
  meta_data: [
    { key: 'protixa_order_id', value: order.id },
    { key: 'protixa_total', value: order.total },
    { key: 'protixa_created_at', value: order.createdAt },
  ],
  billing: {
    first_name: customer.name || 'Protixa',
    email: customer.email || 'orders@protixa.example',
  },
});

const createDraftId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
};

const forwardOrder = async ({ order, customer }) => {
  const payload = buildOrderPayload({ order, customer });

  if (!isConfigured()) {
    return {
      status: 'skipped',
      reason: 'not_configured',
      payload,
    };
  }

  if (!shouldAutoSubmitOrders) {
    const draftId = createDraftId();
    logger.info(
      {
        draftId,
        orderId: order.id,
      },
      'WooCommerce auto-submit disabled; returning draft payload',
    );
    return {
      status: 'pending',
      reason: 'auto_submit_disabled',
      payload,
      draftId,
    };
  }

  try {
    const client = getClient();
    const response = await client.post('/orders', payload);
    return {
      status: 'success',
      payload,
      response: {
        id: response.data?.id,
        number: response.data?.number,
        status: response.data?.status,
      },
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to create WooCommerce order');
    const integrationError = new Error('WooCommerce order creation failed');
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

module.exports = {
  isConfigured,
  forwardOrder,
  buildOrderPayload,
  fetchCatalog: async (endpoint, query = {}) => {
    if (!isConfigured()) {
      const error = new Error('WooCommerce is not configured');
      error.status = 503;
      throw error;
    }

    const normalizedEndpoint = endpoint.replace(/^\/+/, '');
    const client = getClient();

    try {
      const response = await client.get(`/${normalizedEndpoint}`, {
        params: sanitizeQueryParams(query),
      });

      return response.data;
    } catch (error) {
      logger.error(
        { err: error, endpoint: normalizedEndpoint },
        'WooCommerce catalog fetch failed',
      );
      const fetchError = new Error('WooCommerce catalog request failed');
      fetchError.status = error.response?.status ?? 502;
      fetchError.cause = error.response?.data || error;
      throw fetchError;
    }
  },
};
