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

const createPaymentIntent = async ({ order, wooOrderId, customer }) => {
  if (!isConfigured()) {
    return { status: 'skipped', reason: 'stripe_disabled' };
  }
  const stripe = getClient();
  const amount = Math.max(Math.round(Number(order.total || 0) * 100), 50);
  const metadata = {
    peppro_order_id: order.id,
    woo_order_id: wooOrderId || '',
    user_id: order.userId || '',
  };
  if (customer?.email) {
    metadata.customer_email = customer.email;
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata,
      description: `PepPro Order ${order.id}`,
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

module.exports = {
  isConfigured,
  createPaymentIntent,
  constructEvent,
  retrievePaymentIntent,
};
