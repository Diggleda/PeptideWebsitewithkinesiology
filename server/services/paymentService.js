const orderRepository = require('../repositories/orderRepository');
const wooCommerceClient = require('../integration/wooCommerceClient');
const stripeClient = require('../integration/stripeClient');
const { logger } = require('../config/logger');

const createStripePayment = async ({ order, customer, wooOrderId }) => stripeClient.createPaymentIntent({
  order,
  wooOrderId,
  customer,
});

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

  return { received: true, type: event.type };
};

module.exports = {
  createStripePayment,
  handleStripeWebhook,
};
