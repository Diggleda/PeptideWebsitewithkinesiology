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
const MAX_WOO_ORDER_FETCH = 25;

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
  created_via: 'peppro_app',
  customer_note: order.referralCode
    ? `Referral code used: ${order.referralCode}`
    : '',
  set_paid: false,
  line_items: buildLineItems(order.items || []),
  meta_data: [
    { key: 'peppro_order_id', value: order.id },
    { key: 'peppro_total', value: order.total },
    { key: 'peppro_created_at', value: order.createdAt },
    { key: 'peppro_origin', value: 'PepPro Web Checkout' },
  ],
  billing: {
    first_name: customer.name || 'PepPro',
    email: customer.email || 'orders@peppro.example',
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
        payment_url: response.data?.payment_url,
        order_key: response.data?.order_key,
      },
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to create WooCommerce order');
    const integrationError = new Error('WooCommerce order creation failed');
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const normalizeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatBillingName = (billing = {}) => {
  const first = typeof billing.first_name === 'string' ? billing.first_name.trim() : '';
  const last = typeof billing.last_name === 'string' ? billing.last_name.trim() : '';
  return [first, last].filter(Boolean).join(' ').trim() || null;
};

const sanitizeWooLineItems = (items = []) => {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => ({
    id: item?.id ? String(item.id) : null,
    productId: item?.product_id ?? null,
    variationId: item?.variation_id ?? null,
    name: typeof item?.name === 'string' ? item.name : 'Item',
    quantity: normalizeNumber(item?.quantity, 0),
    total: normalizeNumber(item?.total || item?.subtotal, 0),
    sku: item?.sku || null,
  }));
};

const mapWooOrderSummary = (order) => ({
  id: order?.id ? String(order.id) : crypto.randomUUID(),
  number: typeof order?.number === 'string' ? order.number : (order?.id ? String(order.id) : null),
  status: order?.status || 'pending',
  currency: order?.currency || 'USD',
  total: normalizeNumber(order?.total, normalizeNumber(order?.total_ex_tax)),
  totalTax: normalizeNumber(order?.total_tax),
  shippingTotal: normalizeNumber(order?.shipping_total),
  paymentMethod: order?.payment_method_title || order?.payment_method || null,
  createdAt: order?.date_created || order?.date_created_gmt || null,
  updatedAt: order?.date_modified || order?.date_modified_gmt || null,
  billingName: formatBillingName(order?.billing),
  billingEmail: order?.billing?.email || null,
  source: 'woocommerce',
  lineItems: sanitizeWooLineItems(order?.line_items),
});

const fetchOrdersByEmail = async (email, { perPage = 10 } = {}) => {
  if (!email || !isConfigured()) {
    return [];
  }

  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedEmail) {
    return [];
  }

  const size = Math.min(Math.max(Number(perPage) || 10, 1), MAX_WOO_ORDER_FETCH);
  const client = getClient();

  try {
    const response = await client.get('/orders', {
      params: {
        per_page: size,
        orderby: 'date',
        order: 'desc',
      },
    });

    const payload = Array.isArray(response.data) ? response.data : [];
    return payload
      .filter((order) => {
        const billingEmail = typeof order?.billing?.email === 'string' ? order.billing.email.trim().toLowerCase() : '';
        return billingEmail === trimmedEmail;
      })
      .map(mapWooOrderSummary);
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch WooCommerce orders');
    const fetchError = new Error('WooCommerce order lookup failed');
    fetchError.status = error.response?.status ?? 502;
    fetchError.cause = error.response?.data || error;
    throw fetchError;
  }
};

const markOrderPaid = async ({ wooOrderId, paymentIntentId }) => {
  if (!wooOrderId) {
    return { status: 'skipped', reason: 'missing_woo_order_id' };
  }
  if (!isConfigured()) {
    return { status: 'skipped', reason: 'not_configured' };
  }
  try {
    const client = getClient();
    const response = await client.put(`/orders/${wooOrderId}`, {
      set_paid: true,
      status: 'processing',
      payment_method: 'stripe',
      payment_method_title: 'Stripe Onsite',
      meta_data: paymentIntentId
        ? [{ key: 'stripe_payment_intent', value: paymentIntentId }]
        : [],
    });
    return {
      status: 'success',
      response: {
        id: response.data?.id,
        status: response.data?.status,
      },
    };
  } catch (error) {
    logger.error({ err: error, wooOrderId }, 'Failed to mark WooCommerce order paid');
    const integrationError = new Error('Failed to update WooCommerce order status');
    integrationError.cause = error.response?.data || error;
    integrationError.status = error.response?.status ?? 502;
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
  fetchOrdersByEmail,
  mapWooOrderSummary,
  markOrderPaid,
};
