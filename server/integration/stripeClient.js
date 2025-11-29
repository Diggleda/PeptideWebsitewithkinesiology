const Stripe = require('stripe');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

let stripeClient = null;

const getClient = () => {
  if (!env.stripe.onsiteEnabled || !env.stripe.secretKey) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  if (stripeClient) {
    return stripeClient;
  }
  stripeClient = Stripe(env.stripe.secretKey, {
    apiVersion: '2024-06-20',
  });
  return stripeClient;
};

const isConfigured = () => Boolean(env.stripe.onsiteEnabled && env.stripe.secretKey);

const retrievePaymentIntent = async (paymentIntentId) => {
  if (!isConfigured()) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  const stripe = getClient();
  return stripe.paymentIntents.retrieve(paymentIntentId);
};

const createPaymentIntent = async ({ order, wooOrderId, wooOrderNumber, customer }) => {
  if (!isConfigured()) {
    return { status: 'skipped', reason: 'stripe_disabled' };
  }
  const stripe = getClient();
  const amount = Math.max(Math.round(Number(order.total || 0) * 100), 50);
  const metadata = {
    peppro_order_id: order.id ? String(order.id) : '',
    user_id: order.userId ? String(order.userId) : '',
  };
  if (wooOrderId) {
    metadata.woo_order_id = String(wooOrderId);
  }
  const normalizedWooOrderNumber = wooOrderNumber
    ? String(wooOrderNumber).replace(/^#/, '')
    : (wooOrderId ? String(wooOrderId) : '');
  if (normalizedWooOrderNumber) {
    metadata.woo_order_number = normalizedWooOrderNumber;
  }
  if (customer?.email) {
    metadata.customer_email = customer.email;
  }
  const descriptionParts = [];
  if (normalizedWooOrderNumber) {
    descriptionParts.push(`Woo Order #${normalizedWooOrderNumber}`);
  }
  if (order?.id) {
    descriptionParts.push(`PepPro Order ${order.id}`);
  }
  const description = descriptionParts.length > 0
    ? descriptionParts.join(' · ')
    : 'PepPro Order';

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata,
      description,
      automatic_payment_methods: { enabled: true },
    });
    return {
      status: 'success',
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Stripe PaymentIntent creation failed');
    const wrapped = new Error('Stripe PaymentIntent creation failed');
    wrapped.cause = error;
    wrapped.status = error?.statusCode || 502;
    throw wrapped;
  }
};

const constructEvent = (payload, signature) => {
  if (!env.stripe.webhookSecret) {
    const error = new Error('Stripe webhook secret is not configured');
    error.status = 400;
    throw error;
  }
  const stripe = getClient();
  return stripe.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
};

const refundPaymentIntent = async ({ paymentIntentId, amount, reason, metadata }) => {
  if (!isConfigured()) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  if (!paymentIntentId) {
    const error = new Error('Payment intent ID is required for refunds');
    error.status = 400;
    throw error;
  }
  const stripe = getClient();
  const params = {
    payment_intent: paymentIntentId,
    reason: reason ? 'requested_by_customer' : undefined,
  };
  if (Number.isFinite(amount) && amount > 0) {
    params.amount = Math.round(amount);
  }
  if (metadata && typeof metadata === 'object') {
    const sanitizedMetadata = Object.entries(metadata).reduce((acc, [key, value]) => {
      if (value === undefined || value === null) {
        return acc;
      }
      acc[key] = String(value);
      return acc;
    }, {});
    if (Object.keys(sanitizedMetadata).length > 0) {
      params.metadata = sanitizedMetadata;
    }
  }
  try {
    return await stripe.refunds.create(params);
  } catch (error) {
    logger.error({ err: error, paymentIntentId }, 'Stripe refund failed');
    const wrapped = new Error('Stripe refund failed');
    wrapped.cause = error;
    wrapped.status = error?.statusCode || 502;
    throw wrapped;
  }
};

module.exports = {
  isConfigured,
  createPaymentIntent,
  constructEvent,
  retrievePaymentIntent,
  refundPaymentIntent,
};
