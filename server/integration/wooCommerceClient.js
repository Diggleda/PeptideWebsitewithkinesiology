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
};
