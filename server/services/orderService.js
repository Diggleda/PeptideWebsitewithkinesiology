const orderRepository = require('../repositories/orderRepository');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const paymentService = require('./paymentService');
const { ensureShippingData } = require('./shippingValidation');
const { logger } = require('../config/logger');
const inventorySyncService = require('./inventorySyncService');
const orderSqlRepository = require('../repositories/orderSqlRepository');

const sanitizeOrder = (order) => ({ ...order });

const buildAddressSummary = (address = {}) => {
  if (!address || typeof address !== 'object') {
    return null;
  }
  return {
    name: address.name || null,
    company: address.company || null,
    addressLine1: address.addressLine1 || address.address_1 || null,
    addressLine2: address.addressLine2 || address.address_2 || null,
    city: address.city || null,
    state: address.state || null,
    postalCode: address.postalCode || address.postcode || null,
    country: address.country || null,
    phone: address.phone || null,
    email: address.email || null,
  };
};

const buildBillingAddressFromUser = (user, fallbackAddress = null) => {
  if (!user) {
    return fallbackAddress;
  }
  return {
    name: user.name || fallbackAddress?.name || null,
    company: user.company || fallbackAddress?.company || null,
    addressLine1: user.officeAddressLine1 || fallbackAddress?.addressLine1 || null,
    addressLine2: user.officeAddressLine2 || fallbackAddress?.addressLine2 || null,
    city: user.officeCity || fallbackAddress?.city || null,
    state: user.officeState || fallbackAddress?.state || null,
    postalCode: user.officePostalCode || fallbackAddress?.postalCode || null,
    country: fallbackAddress?.country || 'US',
    phone: user.phone || fallbackAddress?.phone || null,
    email: user.email || fallbackAddress?.email || null,
  };
};

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
  paymentMethod: order.paymentMethod
    || (order.integrationDetails?.stripe?.cardLast4
      ? `${order.integrationDetails?.stripe?.cardBrand || 'Card'} •••• ${order.integrationDetails.stripe.cardLast4}`
      : null),
  shippingAddress: buildAddressSummary(order.shippingAddress),
  billingAddress: buildAddressSummary(order.billingAddress),
  shippingEstimate: order.shippingEstimate || null,
  shippingTotal: order.shippingTotal ?? null,
  physicianCertified: order.physicianCertificationAccepted === true,
});

const normalizeWooOrderId = (rawId) => {
  if (!rawId) {
    return null;
  }
  if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    return rawId;
  }
  const idString = String(rawId);
  if (/^\d+$/.test(idString)) {
    return Number(idString);
  }
  const match = idString.match(/(\d+)/);
  return match ? Number(match[1]) : null;
};

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
  physicianCertification,
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

  const shippingData = ensureShippingData({
    shippingAddress,
    shippingEstimate,
    shippingTotal,
  });

  const now = new Date().toISOString();
  const order = {
    id: Date.now().toString(),
    userId,
    items,
    total,
    shippingTotal: shippingData.shippingTotal,
    shippingEstimate: shippingData.shippingEstimate,
    shippingAddress: shippingData.shippingAddress,
    billingAddress: buildBillingAddressFromUser(user, shippingData.shippingAddress),
    referralCode: referralCode || null,
    status: 'pending',
    createdAt: now,
    physicianCertificationAccepted: Boolean(physicianCertification),
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
  let shipStationOrderId = null;

  try {
    integrations.shipStation = await shipStationClient.forwardOrder({
      order,
      customer: user,
      wooOrder: integrations.wooCommerce,
    });
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'ShipStation integration failed');
    integrations.shipStation = {
      status: 'error',
      message: error.message,
      details: serializeCause(error.cause),
    };
  }

  shipStationOrderId = integrations.shipStation?.response?.orderId || null;

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

  if (shipStationClient.isConfigured()) {
    integrations.shipEngine = {
      status: 'skipped',
      reason: 'shipstation_enabled',
    };
  } else {
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
  }

  try {
    integrations.inventorySync = await inventorySyncService.syncShipStationInventoryToWoo(order.items);
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Inventory sync integration failed');
    integrations.inventorySync = {
      status: 'error',
      message: error.message,
    };
  }

  order.integrations = {
    wooCommerce: integrations.wooCommerce?.status,
    stripe: integrations.stripe?.status,
    shipEngine: integrations.shipEngine?.status,
    shipStation: integrations.shipStation?.status,
    inventorySync: integrations.inventorySync?.status || integrations.inventorySync?.reason || null,
    mysql: integrations.mysql?.status || integrations.mysql?.reason || null,
  };
  order.integrationDetails = integrations;
  if (wooOrderId) {
    order.wooOrderId = wooOrderId;
  }
  if (shipStationOrderId) {
    order.shipStationOrderId = shipStationOrderId;
  }
  if (integrations.stripe?.paymentIntentId) {
    order.paymentIntentId = integrations.stripe.paymentIntentId;
  }

  try {
    integrations.mysql = await orderSqlRepository.persistOrder({
      order,
      wooOrderId,
      shipStationOrderId,
    });
    order.integrations.mysql = integrations.mysql?.status || integrations.mysql?.reason || order.integrations.mysql;
    order.integrationDetails.mysql = integrations.mysql;
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'MySQL logging failed for order');
    integrations.mysql = {
      status: 'error',
      message: error.message,
    };
    order.integrations.mysql = 'error';
    order.integrationDetails.mysql = integrations.mysql;
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

const cancelWooOrderForUser = async ({ userId, wooOrderId, reason }) => {
  const cancellationReason = reason || 'Cancelled via account portal';
  const normalizedWooOrderId = normalizeWooOrderId(wooOrderId);
  if (!normalizedWooOrderId) {
    const error = new Error('Order not found');
    error.status = 404;
    throw error;
  }

  const buildWooCancellationResponse = ({ wooOrder = null, status = 'cancelled', wooCancellation = null }) => ({
    success: true,
    order: {
      id: String(normalizedWooOrderId),
      number: wooOrder?.number || String(normalizedWooOrderId),
      status,
      source: 'woocommerce',
      updatedAt: new Date().toISOString(),
    },
    cancellationReason,
    wooCancellation: wooCancellation || {
      status: wooOrder ? 'success' : 'skipped',
      reason: wooOrder ? null : 'unavailable',
    },
  });

  if (!wooCommerceClient.isConfigured()) {
    return buildWooCancellationResponse({
      wooCancellation: {
        status: 'skipped',
        reason: 'not_configured',
      },
    });
  }

  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  let wooOrder;
  try {
    wooOrder = await wooCommerceClient.fetchOrderById(normalizedWooOrderId);
  } catch (error) {
    logger.warn({ err: error, wooOrderId: normalizedWooOrderId, userId }, 'Unable to fetch Woo order for cancellation; returning fallback success');
    return buildWooCancellationResponse({
      wooCancellation: {
        status: 'error',
        reason: 'fetch_failed',
        message: error.message,
      },
    });
  }

  if (!wooOrder) {
    logger.warn({ wooOrderId: normalizedWooOrderId, userId }, 'Woo order not found; returning fallback success');
    return buildWooCancellationResponse({
      wooCancellation: {
        status: 'skipped',
        reason: 'missing_order',
      },
    });
  }

  const wooEmail = (wooOrder?.billing?.email || wooOrder?.billing?.email_address || wooOrder?.email || '')
    .toLowerCase()
    .trim();
  const normalizedUserEmail = (user.email || '').toLowerCase().trim();
  if (wooEmail && normalizedUserEmail && wooEmail !== normalizedUserEmail) {
    const error = new Error('Unauthorized');
    error.status = 403;
    throw error;
  }

  try {
    const wooCancellation = await wooCommerceClient.cancelOrder({
      wooOrderId: normalizedWooOrderId,
      reason: cancellationReason,
    });
    return buildWooCancellationResponse({
      wooOrder,
      status: wooCancellation?.response?.status || wooOrder?.status || 'cancelled',
      wooCancellation,
    });
  } catch (error) {
    logger.warn({ err: error, wooOrderId: normalizedWooOrderId, userId }, 'WooCommerce cancellation failed; returning fallback success');
    return buildWooCancellationResponse({
      wooOrder,
      status: wooOrder?.status || 'cancelled',
      wooCancellation: {
        status: 'error',
        message: error.message,
      },
    });
  }
};

const cancelOrder = async ({ userId, orderId, reason }) => {
  const cancellationReason = typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim()
    : 'Cancelled via account portal';
  const order = orderRepository.findById(orderId);
  if (!order) {
    const fallbackResult = await cancelWooOrderForUser({ userId, wooOrderId: orderId, reason: cancellationReason });
    if (fallbackResult) {
      return fallbackResult;
    }
    const error = new Error('Order not found');
    error.status = 404;
    throw error;
  }
  if (order.userId !== userId) {
    const error = new Error('Unauthorized');
    error.status = 403;
    throw error;
  }
  const normalizedStatus = (order.status || '').toLowerCase();
  const cancellableStatuses = new Set(['pending', 'processing', 'paid']);
  if (!cancellableStatuses.has(normalizedStatus)) {
    const error = new Error('This order can no longer be cancelled');
    error.status = 400;
    throw error;
  }

  let stripeRefund = null;
  const requiresRefund = normalizedStatus !== 'pending' || Boolean(order.paymentIntentId);
  if (requiresRefund && order.paymentIntentId) {
    const amountCents = Math.max(
      Math.round(((order.total ?? 0) + (order.shippingTotal ?? 0)) * 100),
      0,
    );
    try {
      stripeRefund = await paymentService.refundPaymentIntent({
        paymentIntentId: order.paymentIntentId,
        amountCents: amountCents || undefined,
        reason: cancellationReason,
      });
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'Stripe refund failed during order cancellation');
      const refundError = new Error('Unable to refund this order right now. Please try again soon.');
      refundError.status = 502;
      throw refundError;
    }
  }

  let wooCancellation = null;
  if (order.wooOrderId) {
    try {
      wooCancellation = await wooCommerceClient.cancelOrder({
        wooOrderId: order.wooOrderId,
        reason: cancellationReason,
      });
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'Failed to cancel WooCommerce order after payment failure');
      wooCancellation = {
        status: 'error',
        message: error.message,
      };
    }
  }

  const updatedOrder = {
    ...order,
    status: stripeRefund ? 'refunded' : 'cancelled',
    cancellationReason,
    updatedAt: new Date().toISOString(),
    integrationDetails: {
      ...(order.integrationDetails || {}),
      stripe: {
        ...(order.integrationDetails?.stripe || {}),
        status: stripeRefund ? 'refunded' : order.integrationDetails?.stripe?.status || null,
        reason: cancellationReason,
        cancellationReason,
        lastSyncAt: new Date().toISOString(),
        refund: stripeRefund
          ? {
              id: stripeRefund.id,
              amount: stripeRefund.amount,
              currency: stripeRefund.currency,
              status: stripeRefund.status,
              createdAt: new Date().toISOString(),
            }
          : order.integrationDetails?.stripe?.refund,
        wooCancellation,
      },
    },
    integrations: {
      ...(order.integrations || {}),
      stripe: stripeRefund ? 'refunded' : order.integrations?.stripe || null,
      wooCommerce: wooCancellation?.status || order.integrations?.wooCommerce || null,
    },
  };

  orderRepository.update(updatedOrder);
  try {
    await orderSqlRepository.persistOrder({
      order: updatedOrder,
      wooOrderId: updatedOrder.wooOrderId,
      shipStationOrderId: updatedOrder.shipStationOrderId,
    });
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to update MySQL record for cancelled order');
  }

  return {
    success: true,
    order: sanitizeOrder(updatedOrder),
    cancellationReason,
    wooCancellation,
  };
};

const getOrdersForUser = async (userId) => {
  const user = userRepository.findById(userId);
  const orders = orderRepository.findByUserId(userId);
  const localSummaries = orders.map(buildLocalOrderSummary);
  const visibleLocalSummaries = localSummaries.filter(
    (summary) => ((summary.status || '').toLowerCase() !== 'payment_failed'),
  );

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
    local: visibleLocalSummaries,
    woo: wooOrders,
    fetchedAt: new Date().toISOString(),
    wooError,
  };
};

module.exports = {
  createOrder,
  getOrdersForUser,
  cancelOrder,
};
