const orderRepository = require('../repositories/orderRepository');
const wooCommerceClient = require('../integration/wooCommerceClient');
const stripeClient = require('../integration/stripeClient');
const { logger } = require('../config/logger');

const createStripePayment = async ({ order, customer, wooOrderId }) => stripeClient.createPaymentIntent({
  order,
  wooOrderId,
  customer,
});

const finalizePaymentIntent = async ({ paymentIntentId }) => {
  const intent = await stripeClient.retrievePaymentIntent(paymentIntentId);
  const orderId = intent?.metadata?.peppro_order_id || null;
  const wooOrderId = intent?.metadata?.woo_order_id || null;
  const order = orderId ? orderRepository.findById(orderId) : orderRepository.findByPaymentIntentId(paymentIntentId);
  let wooUpdate = null;

  if (wooOrderId) {
    try {
      wooUpdate = await wooCommerceClient.markOrderPaid({
        wooOrderId,
        paymentIntentId,
      });
    } catch (error) {
      logger.error({ err: error, wooOrderId, intentId: paymentIntentId }, 'Failed to mark Woo order paid from confirm endpoint');
    }
  }

  if (order) {
    const updated = {
      ...order,
      status: intent?.status === 'succeeded' ? 'paid' : order.status,
      paymentIntentId,
      wooOrderId: wooOrderId || order.wooOrderId,
      integrationDetails: {
        ...(order.integrationDetails || {}),
        stripe: {
          ...(order.integrationDetails?.stripe || {}),
          eventType: intent?.status,
          paymentIntentId,
          lastSyncAt: new Date().toISOString(),
          wooUpdate,
        },
      },
      integrations: {
        ...(order.integrations || {}),
        stripe: intent?.status === 'succeeded' ? 'success' : order.integrations?.stripe,
      },
    };
    orderRepository.update(updated);
  }

  return { status: intent?.status || 'unknown', wooOrderId, orderId };
};

const handleStripeWebhook = async ({ payload, signature }) => {
  const event = stripeClient.constructEvent(payload, signature);
  const intent = event?.data?.object;

  if (!event?.type || !intent?.id) {
    return { received: true };
  }

  if (event.type === 'payment_intent.succeeded') {
    const orderId = intent.metadata?.peppro_order_id || null;
    const wooOrderId = intent.metadata?.woo_order_id || null;
    const order = orderId ? orderRepository.findById(orderId) : null;
    let wooUpdate = null;

    if (wooOrderId) {
      try {
        wooUpdate = await wooCommerceClient.markOrderPaid({
          wooOrderId,
          paymentIntentId: intent.id,
        });
      } catch (error) {
        logger.error({ err: error, wooOrderId, intentId: intent.id }, 'Failed to mark Woo order paid from webhook');
      }
    }

    if (order) {
      const updated = {
        ...order,
        status: 'paid',
        paymentIntentId: intent.id,
        integrationDetails: {
          ...(order.integrationDetails || {}),
          stripe: {
            ...(order.integrationDetails?.stripe || {}),
            eventType: event.type,
            paymentIntentId: intent.id,
            lastWebhookAt: new Date().toISOString(),
            wooUpdate,
          },
        },
        integrations: {
          ...(order.integrations || {}),
          stripe: 'success',
        },
      };
      orderRepository.update(updated);
    }
  }

  // Handle charge.succeeded in case Stripe only sends charge-level events
  if (event.type === 'charge.succeeded' && intent.object === 'charge') {
    const paymentIntentId = intent.payment_intent || null;
    if (paymentIntentId) {
      try {
        await finalizePaymentIntent({ paymentIntentId });
      } catch (error) {
        logger.error({ err: error, paymentIntentId }, 'Failed to finalize payment intent from charge.succeeded');
      }
    }
  }

  return { received: true, type: event.type };
};

module.exports = {
  createStripePayment,
  handleStripeWebhook,
  finalizePaymentIntent,
};
