const orderRepository = require('../repositories/orderRepository');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const { logger } = require('../config/logger');

const sanitizeOrder = (order) => ({ ...order });

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

const createOrder = async ({ userId, items, total, referralCode }) => {
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
    shipEngine: integrations.shipEngine?.status,
  };
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

const getOrdersForUser = (userId) => {
  const orders = orderRepository.findByUserId(userId);
  return orders.map(sanitizeOrder);
};

module.exports = {
  createOrder,
  getOrdersForUser,
};
