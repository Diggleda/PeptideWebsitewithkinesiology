const paymentService = require('../services/paymentService');
const orderRepository = require('../repositories/orderRepository');
const { logger } = require('../config/logger');

// Optional endpoint to create/refresh a PaymentIntent for an existing order.
const createIntent = async (req, res, next) => {
  try {
    const { orderId } = req.body || {};
    const order = orderRepository.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const wooOrderId = order.integrationDetails?.wooCommerce?.response?.id || null;
    const result = await paymentService.createStripePayment({
      order,
      customer: req.user || {},
      wooOrderId,
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const confirmIntent = async (req, res, next) => {
  try {
    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'paymentIntentId is required' });
    }
    const result = await paymentService.finalizePaymentIntent({ paymentIntentId });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const handleStripeWebhook = async (req, res, next) => {
  try {
    const rawPayload = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? Buffer.from(req.body)
        : Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.headers['stripe-signature'];
    const result = await paymentService.handleStripeWebhook({ payload: rawPayload, signature });
    return res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Stripe webhook error');
    return res.status(error.status || 400).json({ error: error.message || 'Webhook error' });
  }
};

module.exports = {
  createIntent,
  confirmIntent,
  handleStripeWebhook,
};
