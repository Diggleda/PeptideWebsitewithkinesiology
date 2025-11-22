const orderRepository = require('../repositories/orderRepository');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const paymentService = require('./paymentService');
const { logger } = require('../config/logger');

const sanitizeOrder = (order) => ({ ...order });

const buildLocalOrderSummary = (order) => ({
  id: order.id,
  number: order.id,
  status: order.status,
  total: order.total,
  currency: 'USD',
  createdAt: order.createdAt,
  updatedAt: order.updatedAt || order.createdAt,
  referralCode: order.referralCode || null,
  source: 'local',
  lineItems: (order.items || []).map((item) => ({
    id: item.cartItemId || item.productId || item.id || `${order.id}-${item.name}`,
    name: item.name,
    quantity: item.quantity,
    price: item.price,
    total: Number(item.price || 0) * Number(item.quantity || 0),
  })),
  integrations: order.integrations || null,
  referrerBonus: order.referrerBonus || null,
  integrationDetails: order.integrationDetails || null,
});

const validateItems = (items) => Array.isArray(items)
  && items.length > 0
  && items.every((item) => item && typeof item.quantity === 'number');

const serializeCause = (cause) => {
  if (!cause) {
    return null;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  if (cause instanceof Error) {
    return { message: cause.message };
  }
  try {
    return JSON.parse(JSON.stringify(cause));
  } catch (_error) {
    return { message: String(cause) };
  }
};

const createOrder = async ({
  userId,
  items,
  total,
  referralCode,
  shippingAddress,
  shippingEstimate,
  shippingTotal,
}) => {
  if (!validateItems(items)) {
    const error = new Error('Order requires at least one item');
    error.status = 400;
    throw error;
  }

  if (typeof total !== 'number' || Number.isNaN(total) || total <= 0) {
    const error = new Error('Order total must be a positive number');
    error.status = 400;
    throw error;
  }

  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  const now = new Date().toISOString();
  const order = {
    id: Date.now().toString(),
    userId,
    items,
    total,
    shippingTotal: typeof shippingTotal === 'number' && Number.isFinite(shippingTotal) ? shippingTotal : null,
    shippingEstimate: shippingEstimate || null,
    shippingAddress: shippingAddress || null,
    referralCode: referralCode || null,
    status: 'pending',
    createdAt: now,
  };

  const referralResult = referralService.applyReferralCredit({
    referralCode,
    total,
    purchaserId: userId,
  });

  if (referralResult) {
    order.referrerBonus = {
      referrerId: referralResult.referrerId,
      referrerName: referralResult.referrerName,
      commission: referralResult.commission,
    };
  }

  orderRepository.insert(order);

  const integrations = {};

  try {
    integrations.wooCommerce = await wooCommerceClient.forwardOrder({
      order,
      customer: user,
    });
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'WooCommerce integration failed');
    integrations.wooCommerce = {
      status: 'error',
      message: error.message,
      details: serializeCause(error.cause),
    };
  }

  const wooOrderId = integrations.wooCommerce?.response?.id || null;

  try {
    integrations.stripe = await paymentService.createStripePayment({
      order,
      customer: user,
      wooOrderId,
    });
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Stripe integration failed');
    integrations.stripe = {
      status: 'error',
      message: error.message,
      details: serializeCause(error.cause),
    };
  }

  try {
    integrations.shipEngine = await shipEngineClient.forwardShipment({
      order,
      customer: user,
    });
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'ShipEngine integration failed');
    integrations.shipEngine = {
      status: 'error',
      message: error.message,
      details: serializeCause(error.cause),
    };
  }

  order.integrations = {
    wooCommerce: integrations.wooCommerce?.status,
    stripe: integrations.stripe?.status,
    shipEngine: integrations.shipEngine?.status,
  };
  order.integrationDetails = integrations;
  if (wooOrderId) {
    order.wooOrderId = wooOrderId;
  }
  if (integrations.stripe?.paymentIntentId) {
    order.paymentIntentId = integrations.stripe.paymentIntentId;
  }
  orderRepository.update(order);

  return {
    success: true,
    order: sanitizeOrder(order),
    message: referralResult
      ? `${referralResult.referrerName} earned $${referralResult.commission.toFixed(2)} commission!`
      : null,
    integrations,
  };
};

const getOrdersForUser = async (userId) => {
  const user = userRepository.findById(userId);
  const orders = orderRepository.findByUserId(userId);
  const localSummaries = orders.map(buildLocalOrderSummary);

  let wooOrders = [];
  let wooError = null;

  if (user?.email) {
    try {
      wooOrders = await wooCommerceClient.fetchOrdersByEmail(user.email, { perPage: 15 });
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to fetch WooCommerce orders for user');
      wooError = {
        message: error?.message || 'WooCommerce order lookup failed',
        status: error?.status || null,
      };
    }
  }

  return {
    local: localSummaries,
    woo: wooOrders,
    fetchedAt: new Date().toISOString(),
    wooError,
  };
};

module.exports = {
  createOrder,
  getOrdersForUser,
};
