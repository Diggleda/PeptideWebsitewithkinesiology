const orderRepository = require('../repositories/orderRepository');
const wooCommerceClient = require('../integration/wooCommerceClient');
const stripeClient = require('../integration/stripeClient');
const { logger } = require('../config/logger');

const titleCase = (value) => {
  if (!value) {
    return null;
  }
  const spaced = String(value).replace(/[_-]+/g, ' ').trim();
  if (!spaced) {
    return null;
  }
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
};

const extractCardSummary = (intent) => {
  const charges = intent?.charges?.data;
  if (!Array.isArray(charges) || charges.length === 0) {
    return null;
  }
  const charge = charges[charges.length - 1];
  if (!charge?.payment_method_details) {
    return null;
  }
  const details = charge.payment_method_details.card
    || charge.payment_method_details.card_present
    || charge.payment_method_details.card_swipe
    || charge.payment_method_details.klarna
    || null;
  if (!details) {
    return null;
  }
  const brand = titleCase(details.brand || details.card_brand || details.network || null);
  const last4 = details.last4 || details.card_last4 || details.number_last4 || null;
  if (!last4) {
    return null;
  }
  return {
    brand: brand || 'Card',
    last4,
  };
};

const applyCardSummaryToOrder = ({ order, cardSummary, stripeData }) => {
  if (!cardSummary) {
    return {
      paymentMethod: order.paymentMethod || null,
      paymentDetails: order.paymentDetails || order.paymentMethod || null,
      stripeMeta: stripeData,
    };
  }
  const label = `${cardSummary.brand || 'Card'} •••• ${cardSummary.last4}`;
  return {
    paymentMethod: label,
    paymentDetails: label,
    stripeMeta: {
      ...(stripeData || {}),
      cardBrand: cardSummary.brand,
      cardLast4: cardSummary.last4,
    },
  };
};

const resolveWooOrderId = (providedId, order) => {
  if (providedId) {
    return providedId;
  }
  if (order?.wooOrderId) {
    return order.wooOrderId;
  }
  const integrationId = order?.integrationDetails?.wooCommerce?.response?.id
    || order?.integrationDetails?.wooCommerce?.payload?.id
    || null;
  if (integrationId) {
    return integrationId;
  }
  return null;
};

const createStripePayment = async ({ order, customer, wooOrderId, wooOrderNumber }) => stripeClient.createPaymentIntent({
  order,
  wooOrderId,
  wooOrderNumber,
  customer,
});

const finalizePaymentIntent = async ({ paymentIntentId }) => {
  const intent = await stripeClient.retrievePaymentIntent(paymentIntentId);
  const orderId = intent?.metadata?.peppro_order_id || null;
  const metadataWooOrderId = intent?.metadata?.woo_order_id || null;
  const order = orderId
    ? orderRepository.findById(orderId)
    : orderRepository.findByPaymentIntentId(paymentIntentId);
  const resolvedWooOrderId = resolveWooOrderId(metadataWooOrderId, order);
  let wooUpdate = null;

  if (resolvedWooOrderId) {
    try {
      wooUpdate = await wooCommerceClient.markOrderPaid({
        wooOrderId: resolvedWooOrderId,
        paymentIntentId,
      });
    } catch (error) {
      logger.error(
        { err: error, wooOrderId: resolvedWooOrderId, intentId: paymentIntentId },
        'Failed to mark Woo order paid from confirm endpoint',
      );
    }
  }

  if (order) {
    const cardSummary = extractCardSummary(intent);
    if (cardSummary) {
      logger.info(
        {
          orderId: order.id,
          paymentIntentId,
          cardBrand: cardSummary.brand,
          last4: cardSummary.last4,
        },
        'Stripe card summary applied to order',
      );
    }
    const { paymentMethod, paymentDetails, stripeMeta } = applyCardSummaryToOrder({
      order,
      cardSummary,
      stripeData: {
        ...(order.integrationDetails?.stripe || {}),
        eventType: intent?.status,
        paymentIntentId,
        lastSyncAt: new Date().toISOString(),
        wooUpdate,
      },
    });
    const updated = {
      ...order,
      status: intent?.status === 'succeeded' ? 'paid' : order.status,
      paymentIntentId,
      wooOrderId: resolvedWooOrderId || order.wooOrderId,
      paymentMethod: paymentMethod || order.paymentMethod || 'Card on file',
      paymentDetails: paymentDetails || order.paymentDetails || paymentMethod || order.paymentMethod || null,
      integrationDetails: {
        ...(order.integrationDetails || {}),
        stripe: {
          ...stripeMeta,
        },
      },
      integrations: {
        ...(order.integrations || {}),
        stripe: intent?.status === 'succeeded' ? 'success' : order.integrations?.stripe,
      },
    };
    orderRepository.update(updated);
  }

  return {
    status: intent?.status || 'unknown',
    wooOrderId: resolvedWooOrderId || metadataWooOrderId,
    orderId,
  };
};

const refundPaymentIntent = async ({ paymentIntentId, amountCents, reason, metadata }) => {
  if (!stripeClient.isConfigured()) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  try {
    return await stripeClient.refundPaymentIntent({
      paymentIntentId,
      amount: amountCents,
      reason,
      metadata,
    });
  } catch (error) {
    logger.error({ err: error, paymentIntentId }, 'Stripe refund failed');
    throw error;
  }
};

const handleStripeWebhook = async ({ payload, signature }) => {
  const event = stripeClient.constructEvent(payload, signature);
  const intent = event?.data?.object;
  logger.debug(
    {
      type: event?.type || 'unknown',
      stripeObjectId: intent?.id || intent?.object || null,
    },
    'Stripe webhook event received',
  );

  if (!event?.type || !intent?.id) {
    return { received: true };
  }

  if (event.type === 'payment_intent.succeeded') {
    let hydratedIntent = intent;
    try {
      hydratedIntent = await stripeClient.retrievePaymentIntent(intent.id);
    } catch (error) {
      logger.warn(
        { err: error, paymentIntentId: intent.id },
        'Failed to hydrate payment intent from webhook; using payload intent',
      );
    }
    const orderId = hydratedIntent.metadata?.peppro_order_id || null;
    const metadataWooOrderId = hydratedIntent.metadata?.woo_order_id || null;
    const order = orderId
      ? orderRepository.findById(orderId)
      : orderRepository.findByPaymentIntentId(hydratedIntent.id);
    const resolvedWooOrderId = resolveWooOrderId(metadataWooOrderId, order);
    let wooUpdate = null;

    if (resolvedWooOrderId) {
      try {
        wooUpdate = await wooCommerceClient.markOrderPaid({
          wooOrderId: resolvedWooOrderId,
          paymentIntentId: hydratedIntent.id,
        });
      } catch (error) {
        logger.error(
          { err: error, wooOrderId: resolvedWooOrderId, intentId: hydratedIntent.id },
          'Failed to mark Woo order paid from webhook',
        );
      }
    }

    if (order) {
      const cardSummary = extractCardSummary(hydratedIntent);
      if (cardSummary) {
        logger.info(
          {
            orderId: order.id,
            paymentIntentId: hydratedIntent.id,
            cardBrand: cardSummary.brand,
            last4: cardSummary.last4,
          },
          'Stripe card summary applied to order (webhook)',
        );
      }
      const { paymentMethod, paymentDetails, stripeMeta } = applyCardSummaryToOrder({
        order,
        cardSummary,
        stripeData: {
          ...(order.integrationDetails?.stripe || {}),
          eventType: event.type,
          paymentIntentId: hydratedIntent.id,
          lastWebhookAt: new Date().toISOString(),
          wooUpdate,
        },
      });
      const updated = {
        ...order,
        status: 'paid',
        paymentIntentId: hydratedIntent.id,
        paymentMethod: paymentMethod || order.paymentMethod || 'Card on file',
        paymentDetails: paymentDetails || order.paymentDetails || paymentMethod || order.paymentMethod || null,
        integrationDetails: {
          ...(order.integrationDetails || {}),
          stripe: {
            ...stripeMeta,
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
  refundPaymentIntent,
};
