const axios = require('axios');
const crypto = require('crypto');
const { env } = require('../config/env');
const { logger } = require('../config/logger');
const { calculateEstimatedArrivalDate } = require('../services/shippingValidation');

const isConfigured = () => Boolean(
  env.wooCommerce.storeUrl
  && env.wooCommerce.consumerKey
  && env.wooCommerce.consumerSecret,
);

const DEFAULT_WOO_TIMEOUT_MS = env.wooCommerce.requestTimeoutMs || 25000;
const RETRIABLE_NETWORK_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const MAX_WOO_REQUEST_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 750;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetryWooError = (error) => {
  if (!error) {
    return false;
  }
  const code = error.code || error.cause?.code;
  if (code && RETRIABLE_NETWORK_CODES.has(code)) {
    return true;
  }
  const status = error.response?.status ?? error.status;
  if (typeof status === 'number' && status >= 500) {
    return true;
  }
  const message = (error.message || error.cause?.message || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
};

const executeWithRetry = async (operation, { label = 'woo_request', maxAttempts = MAX_WOO_REQUEST_ATTEMPTS } = {}) => {
  let attempt = 0;
  let lastError = null;
  while (attempt < maxAttempts) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      attempt += 1;
      const shouldRetry = shouldRetryWooError(error) && attempt < maxAttempts;
      logger.warn(
        {
          err: error,
          label,
          attempt,
          maxAttempts,
          willRetry: shouldRetry,
        },
        'WooCommerce request failed',
      );
      if (!shouldRetry) {
        break;
      }
      const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 5000);
      await sleep(delay);
    }
  }
  throw lastError;
};

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

const normalizedStoreUrl = env.wooCommerce.storeUrl
  ? env.wooCommerce.storeUrl.replace(/\/+$/, '')
  : '';

const buildInvoiceUrl = (orderId, orderKey) => {
  if (!normalizedStoreUrl || !orderId || !orderKey) {
    return null;
  }
  const safeId = encodeURIComponent(String(orderId).trim());
  const safeKey = encodeURIComponent(String(orderKey).trim());
  return `${normalizedStoreUrl}/my-account/view-order/${safeId}/?order=${safeId}&key=${safeKey}`;
};

const getClient = () => {
  if (!isConfigured()) {
    throw new Error('WooCommerce is not configured');
  }

  return axios.create({
    baseURL: `${normalizedStoreUrl}/wp-json/${env.wooCommerce.apiVersion.replace(/^\/+/, '')}`,
    auth: {
      username: env.wooCommerce.consumerKey,
      password: env.wooCommerce.consumerSecret,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: DEFAULT_WOO_TIMEOUT_MS,
  });
};

const getSiteClient = () => {
  if (!isConfigured()) {
    throw new Error('WooCommerce is not configured');
  }

  return axios.create({
    baseURL: `${normalizedStoreUrl}/wp-json`,
    auth: {
      username: env.wooCommerce.consumerKey,
      password: env.wooCommerce.consumerSecret,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: DEFAULT_WOO_TIMEOUT_MS,
  });
};

let taxCalculationSupported = true;
let taxCalculationWarningLogged = false;

const parseWooNumericId = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const str = String(value);
  const match = str.match(/(\d+)/);
  return match ? Number(match[1]) : null;
};

const buildLineItems = (items) => items.map((item) => {
  const quantity = Number(item.quantity) || 0;
  const price = Number(item.price) || 0;
  const total = Number(price * quantity).toFixed(2);
  const productId = parseWooNumericId(item.productId || item.wooProductId || item.product_id);
  const variationId = parseWooNumericId(
    item.variantId
    || item.variationId
    || item.wooVariationId
    || item.variation_id,
  );
  const resolvedSku = item.sku
    || item.productSku
    || item.variantSku
    || (typeof item.productId === 'string' ? item.productId : null);
  const line = {
    name: item.name,
    sku: resolvedSku || null,
    quantity,
    total,
    subtotal: total,
    total_tax: '0',
    subtotal_tax: '0',
    meta_data: item.note ? [{ key: 'note', value: item.note }] : [],
  };
  // Include product/variation ids so Woo and ShipStation exports keep the items.
  if (productId) {
    line.product_id = productId;
  }
  if (variationId) {
    line.variation_id = variationId;
  }
  return line;
});

const buildShippingLines = ({ shippingTotal, shippingEstimate }) => {
  if (shippingEstimate) {
    const total = Number.isFinite(shippingTotal) ? Number(shippingTotal) : 0;
    const rawMethodId = shippingEstimate.serviceCode
      || shippingEstimate.serviceType
      || shippingEstimate.carrierId
      || null;
    const normalizedMethodId = rawMethodId
      ? `peppro_${String(rawMethodId).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
      : 'peppro_shipstation';
    const methodTitle = shippingEstimate.serviceType
      || shippingEstimate.serviceCode
      || shippingEstimate.carrierId
      || 'PepPro Shipping';
    const metaData = [
      shippingEstimate.carrierId ? { key: 'peppro_carrier_id', value: shippingEstimate.carrierId } : null,
      shippingEstimate.serviceCode ? { key: 'peppro_service_code', value: shippingEstimate.serviceCode } : null,
      shippingEstimate.serviceType ? { key: 'peppro_service_type', value: shippingEstimate.serviceType } : null,
      Number.isFinite(shippingEstimate.estimatedDeliveryDays)
        ? { key: 'peppro_estimated_delivery_days', value: shippingEstimate.estimatedDeliveryDays }
        : null,
    ].filter(Boolean);
    return [
      {
        method_id: normalizedMethodId,
        method_title: methodTitle,
        total: total.toFixed(2),
        meta_data: metaData,
      },
    ];
  }
  return [];
};

const buildOrderPayload = ({ order, customer }) => {
  const shippingAddress = order.shippingAddress || null;
  const shippingTotal = typeof order.shippingTotal === 'number' && Number.isFinite(order.shippingTotal)
    ? Number(order.shippingTotal)
    : 0;

  const metaData = [
    { key: 'peppro_order_id', value: order.id },
    { key: 'peppro_total', value: order.total },
    { key: 'peppro_created_at', value: order.createdAt },
    { key: 'peppro_origin', value: 'PepPro Web Checkout' },
    { key: '_order_number', value: order.id },
    { key: '_order_number_formatted', value: order.id },
    { key: 'peppro_display_order_id', value: order.id },
  ];

  if (shippingTotal > 0) {
    metaData.push({ key: 'peppro_shipping_total', value: shippingTotal });
  }

  if (order.shippingEstimate) {
    metaData.push({ key: 'peppro_shipping_estimate', value: JSON.stringify(order.shippingEstimate) });
  }

  const payload = {
    status: 'pending',
    created_via: 'peppro_app',
    customer_note: `PepPro Order ${order.id}${order.referralCode ? ` — Referral code used: ${order.referralCode}` : ''}`,
    set_paid: false,
    line_items: buildLineItems(order.items || []),
    meta_data: metaData,
    billing: {
      first_name: customer.name || 'PepPro',
      email: customer.email || 'orders@peppro.example',
    },
  };

  if (shippingAddress) {
    payload.shipping = {
      first_name: shippingAddress.name || customer.name || 'PepPro',
      address_1: shippingAddress.addressLine1 || '',
      address_2: shippingAddress.addressLine2 || '',
      city: shippingAddress.city || '',
      state: shippingAddress.state || '',
      postcode: shippingAddress.postalCode || '',
      country: shippingAddress.country || 'US',
    };
  }

  const shippingLines = buildShippingLines({
    shippingTotal,
    shippingEstimate: order.shippingEstimate,
  });
  if (shippingLines.length > 0) {
    payload.shipping_lines = shippingLines;
  }

  return payload;
};

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
    const invoiceUrl = buildInvoiceUrl(response.data?.id, response.data?.order_key);
    return {
      status: 'success',
      payload,
      invoiceUrl,
      response: {
        id: response.data?.id,
        number: response.data?.number,
        status: response.data?.status,
        payment_url: response.data?.payment_url,
        order_key: response.data?.order_key,
        invoiceUrl,
      },
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to create WooCommerce order');
    const integrationError = new Error('WooCommerce order creation failed');
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const buildTaxCalculationPayload = ({ order }) => {
  if (!order?.shippingAddress) {
    return null;
  }
  const normalizedLineItems = (order.items || []).map((item, index) => ({
    id: item.productId || item.product_id || index + 1,
    price: Number(item.price || 0).toFixed(2),
    quantity: Number(item.quantity || 0),
  }));
  return {
    country: order.shippingAddress.country || 'US',
    state: order.shippingAddress.state || '',
    city: order.shippingAddress.city || '',
    postcode: order.shippingAddress.postalCode || order.shippingAddress.postcode || '',
    shipping: Number(order.shippingTotal || 0).toFixed(2),
    line_items: normalizedLineItems,
  };
};

// Ordered list of Woo tax endpoints to probe. Newer endpoints first, fall back to legacy.
const TAX_CALCULATION_ENDPOINTS = [
  '/wccom-site/v3/tax/calculate',
  '/wccom-site/v2/tax/calculate',
  '/wccom-site/v2/tax/calculations',
  '/wccom-site/v1/tax/calculate',
  '/wccom-site/tax/calculate',
  '/wc/v3/taxes/calculate',
];

const calculateOrderTaxes = async ({ order, customer }) => {
  if (!taxCalculationSupported) {
    const integrationError = new Error('WooCommerce tax calculation endpoint unavailable');
    integrationError.status = 404;
    integrationError.code = 'WOO_TAX_UNSUPPORTED';
    throw integrationError;
  }
  const payload = buildTaxCalculationPayload({ order, customer });

  if (!payload) {
    const error = new Error('Shipping address is required for tax calculation');
    error.status = 400;
    throw error;
  }

  if (!isConfigured()) {
    return {
      status: 'skipped',
      reason: 'not_configured',
      payload,
    };
  }

  const client = getSiteClient();
  const tryEndpoints = TAX_CALCULATION_ENDPOINTS.length ? TAX_CALCULATION_ENDPOINTS : ['/wccom-site/v2/tax/calculate'];
  let lastError = null;

  for (const endpoint of tryEndpoints) {
    try {
      const response = await client.post(endpoint, payload);
      return {
        status: 'success',
        payload,
        response: response.data,
      };
    } catch (error) {
      lastError = error;
      const statusCode = error?.response?.status ?? error?.status;
      if (statusCode !== 404) {
        break;
      }
      logger.warn({ err: error?.response?.data || error?.message || error, endpoint }, 'Woo tax endpoint returned 404, trying next');
    }
  }

  try {
    throw lastError;
  } catch (error) {
    const statusCode = error?.response?.status ?? error?.status;
    if (statusCode === 404) {
      taxCalculationSupported = false;
      if (!taxCalculationWarningLogged) {
        logger.warn({ err: error }, 'WooCommerce tax calculation endpoint unavailable; using fallback strategy');
        taxCalculationWarningLogged = true;
      }
      const integrationError = new Error('WooCommerce tax calculation endpoint unavailable');
      integrationError.status = 404;
      integrationError.code = 'WOO_TAX_UNSUPPORTED';
      throw integrationError;
    }
    logger.error({ err: error, orderId: order?.id }, 'Failed to calculate WooCommerce taxes');
    const integrationError = new Error('WooCommerce tax calculation failed');
    integrationError.cause = error.response?.data || error;
    integrationError.status = statusCode ?? 502;
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
    image: typeof item?.image?.src === 'string'
      ? item.image.src
      : (typeof item?.image === 'string' && item.image.trim().length > 0 ? item.image.trim() : null),
  }));
};

const mapWooAddress = (address = {}) => {
  if (!address || typeof address !== 'object') {
    return null;
  }
  const first = typeof address.first_name === 'string' ? address.first_name.trim() : '';
  const last = typeof address.last_name === 'string' ? address.last_name.trim() : '';
  const fullName = [first, last].filter(Boolean).join(' ').trim() || null;
  return {
    name: fullName,
    company: typeof address.company === 'string' ? address.company : null,
    addressLine1: typeof address.address_1 === 'string' ? address.address_1 : null,
    addressLine2: typeof address.address_2 === 'string' ? address.address_2 : null,
    city: typeof address.city === 'string' ? address.city : null,
    state: typeof address.state === 'string' ? address.state : null,
    postalCode: typeof address.postcode === 'string' ? address.postcode : null,
    country: typeof address.country === 'string' ? address.country : null,
    phone: typeof address.phone === 'string' ? address.phone : null,
    email: typeof address.email === 'string' ? address.email : null,
  };
};

const parseShippingEstimateMeta = (metaData = [], order = {}) => {
  const entry = metaData.find((meta) => meta?.key === 'peppro_shipping_estimate');
  if (!entry || entry.value === undefined || entry.value === null) {
    return null;
  }
  let value = entry.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse shipping estimate metadata');
      return null;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const estimate = {
    carrierId: value.carrierId || value.carrier_id || null,
    serviceCode: value.serviceCode || value.service_code || null,
    serviceType: value.serviceType || value.service_code || null,
    estimatedDeliveryDays: Number.isFinite(Number(value.estimatedDeliveryDays))
      ? Number(value.estimatedDeliveryDays)
      : null,
    deliveryDateGuaranteed: value.deliveryDateGuaranteed || value.delivery_date || null,
    rate: Number.isFinite(Number(value.rate)) ? Number(value.rate) : null,
    currency: value.currency || 'USD',
  };
  if (!estimate.estimatedArrivalDate && value.estimatedArrivalDate) {
    estimate.estimatedArrivalDate = value.estimatedArrivalDate;
  }
  if (!estimate.estimatedArrivalDate) {
    const referenceDate = order?.date_completed
      || order?.date_created
      || order?.date_created_gmt
      || null;
    estimate.estimatedArrivalDate = calculateEstimatedArrivalDate(estimate, referenceDate);
  }
  return estimate;
};

const mapWooOrderSummary = (order) => {
  const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
  const pepproMeta = metaData.find((entry) => entry?.key === 'peppro_order_id');
  const pepproOrderId = pepproMeta?.value ? String(pepproMeta.value) : null;
  const wooNumber = typeof order?.number === 'string' ? order.number : (order?.id ? String(order.id) : null);
  const shippingEstimate = parseShippingEstimateMeta(metaData, order);

  return {
    id: order?.id ? String(order.id) : crypto.randomUUID(),
    number: wooNumber || pepproOrderId,
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
    shippingAddress: mapWooAddress(order?.shipping),
    billingAddress: mapWooAddress(order?.billing),
    shippingEstimate,
    shippingTotal: normalizeNumber(order?.shipping_total),
    integrationDetails: {
      wooCommerce: {
        wooOrderNumber: wooNumber,
        pepproOrderId,
        status: order?.status || 'pending',
        invoiceUrl: buildInvoiceUrl(order?.id, order?.order_key),
      },
    },
  };
};

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
    const nowIso = new Date().toISOString();
    const response = await client.put(`/orders/${wooOrderId}`, {
      set_paid: true,
      status: 'processing',
      payment_method: 'stripe',
      payment_method_title: 'Stripe Onsite',
      // Setting paid date helps Woo → ShipStation exports.
      date_paid: nowIso,
      date_paid_gmt: nowIso,
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

const cancelOrder = async ({ wooOrderId, reason, statusOverride }) => {
  if (!wooOrderId) {
    return { status: 'skipped', reason: 'missing_woo_order_id' };
  }
  if (!isConfigured()) {
    return { status: 'skipped', reason: 'not_configured' };
  }
  const nextStatus = typeof statusOverride === 'string' && statusOverride.trim().length > 0
    ? statusOverride.trim()
    : 'cancelled';
  const attemptCancel = async () => {
    const client = getClient();
    const payload = {
      status: nextStatus,
      set_paid: false,
      customer_note: reason ? String(reason) : 'Order cancelled (payment failed)',
    };
    const response = await client.put(`/orders/${wooOrderId}`, payload);
    return {
      status: 'success',
      response: {
        id: response.data?.id,
        status: response.data?.status,
      },
    };
  };

  try {
    return await executeWithRetry(attemptCancel, {
      label: `cancel_order_${wooOrderId}`,
    });
  } catch (error) {
    logger.error({ err: error, wooOrderId }, 'Failed to cancel WooCommerce order');
    const integrationError = new Error('Failed to cancel WooCommerce order');
    integrationError.cause = error.response?.data || error;
    integrationError.status = error.response?.status ?? error.status ?? 502;
    integrationError.code = error.code || error.cause?.code;
    throw integrationError;
  }
};

const fetchOrderById = async (wooOrderId) => {
  if (!wooOrderId || !isConfigured()) {
    return null;
  }
  try {
    const client = getClient();
    const response = await client.get(`/orders/${wooOrderId}`);
    return response.data;
  } catch (error) {
    const integrationError = new Error('Failed to fetch WooCommerce order');
    integrationError.cause = error.response?.data || error;
    integrationError.status = error.response?.status ?? 502;
    throw integrationError;
  }
};

const findProductBySku = async (sku) => {
  if (!sku || !isConfigured()) {
    return null;
  }
  try {
    const client = getClient();
    const response = await client.get('/products', {
      params: {
        sku,
        per_page: 1,
      },
    });
    const products = Array.isArray(response.data) ? response.data : [];
    return products[0] || null;
  } catch (error) {
    logger.error({ err: error, sku }, 'Failed to fetch WooCommerce product by SKU');
    const integrationError = new Error('WooCommerce product lookup failed');
    integrationError.status = error.response?.status ?? 502;
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const addOrderNote = async ({ wooOrderId, note, isCustomerNote = false }) => {
  if (!wooOrderId || !note || !isConfigured()) {
    return { status: 'skipped', reason: 'missing_params' };
  }
  try {
    const client = getClient();
    const response = await client.post(`/orders/${wooOrderId}/notes`, {
      note: String(note),
      customer_note: Boolean(isCustomerNote),
    });
    return {
      status: 'success',
      response: {
        id: response.data?.id,
      },
    };
  } catch (error) {
    logger.error({ err: error, wooOrderId }, 'Failed to append WooCommerce order note');
    const integrationError = new Error('Failed to append WooCommerce order note');
    integrationError.cause = error.response?.data || error;
    integrationError.status = error.response?.status ?? 502;
    throw integrationError;
  }
};

const updateProductInventory = async (productId, { stock_quantity: stockQuantity, parent_id: parentId, type }) => {
  if (!productId || !isConfigured()) {
    return { status: 'skipped', reason: 'not_configured' };
  }

  try {
    const client = getClient();
    const payload = {
      manage_stock: true,
      stock_quantity: Number.isFinite(stockQuantity) ? Number(stockQuantity) : null,
    };
    const isVariation = Boolean(parentId) || String(type || '').toLowerCase() === 'variation';
    const endpoint = isVariation
      ? `/products/${parentId}/variations/${productId}`
      : `/products/${productId}`;

    const response = await client.put(endpoint, payload);
    return {
      status: 'success',
      response: {
        id: response.data?.id,
        stock_quantity: response.data?.stock_quantity,
      },
    };
  } catch (error) {
    logger.error({ err: error, productId }, 'Failed to update WooCommerce inventory');
    const integrationError = new Error('WooCommerce inventory update failed');
    integrationError.status = error.response?.status ?? 502;
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const fetchTaxRates = async ({ country, state, postcode, city, taxClass } = {}) => {
  if (!isConfigured()) {
    return [];
  }
  try {
    const client = getClient();
    const response = await client.get('/taxes', {
      params: {
        country: country || undefined,
        state: state || undefined,
        postcode: postcode || undefined,
        city: city || undefined,
        class: taxClass || undefined,
        per_page: 100,
      },
    });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch WooCommerce tax rates');
    const integrationError = new Error('WooCommerce tax lookup failed');
    integrationError.cause = error.response?.data || error;
    integrationError.status = error.response?.status ?? 502;
    throw integrationError;
  }
};

module.exports = {
  isConfigured,
  forwardOrder,
  calculateOrderTaxes,
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
  fetchOrderById,
  mapWooOrderSummary,
  markOrderPaid,
  cancelOrder,
  addOrderNote,
  fetchTaxRates,
  findProductBySku,
  updateProductInventory,
};
