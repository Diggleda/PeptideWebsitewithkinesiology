const orderRepository = require('../repositories/orderRepository');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const paymentService = require('./paymentService');
const stripeClient = require('../integration/stripeClient');
const { ensureShippingData, normalizeAmount } = require('./shippingValidation');
const { logger } = require('../config/logger');
const inventorySyncService = require('./inventorySyncService');
const orderSqlRepository = require('../repositories/orderSqlRepository');

const sanitizeOrder = (order) => ({ ...order });

const extractWooMetaValue = (wooOrder, keys) => {
  const lookup = Array.isArray(keys) ? keys : [keys];
  const metaData = Array.isArray(wooOrder?.meta_data) ? wooOrder.meta_data : [];
  for (const key of lookup) {
    const entry = metaData.find((item) => item?.key === key);
    if (entry && entry.value !== undefined && entry.value !== null) {
      return entry.value;
    }
  }
  return null;
};

const toStripeRefundSummary = (stripeRefund) => {
  if (!stripeRefund) {
    return null;
  }
  const createdAt = typeof stripeRefund.created === 'number'
    ? new Date(stripeRefund.created * 1000).toISOString()
    : new Date().toISOString();
  return {
    id: stripeRefund.id,
    amount: stripeRefund.amount,
    currency: stripeRefund.currency,
    status: stripeRefund.status,
    createdAt,
  };
};

const formatCurrencyFromCents = (amountCents, currency = 'usd') => {
  if (!Number.isFinite(amountCents)) {
    return null;
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ? String(currency).toUpperCase() : 'USD',
    }).format(amountCents / 100);
  } catch (_error) {
    return `$${(amountCents / 100).toFixed(2)}`;
  }
};

const appendWooRefundNote = async ({
  wooOrderId,
  wooOrderNumber,
  stripeRefund,
  pepproOrderId,
}) => {
  if (!stripeRefund || !wooOrderId || typeof wooCommerceClient.addOrderNote !== 'function') {
    return;
  }
  const amountLabel = typeof stripeRefund.amount === 'number'
    ? formatCurrencyFromCents(stripeRefund.amount, stripeRefund.currency)
    : null;
  const noteParts = [
    `Stripe refund ${stripeRefund.id} issued`,
    amountLabel ? `amount: ${amountLabel}` : null,
    wooOrderNumber ? `Woo order #${String(wooOrderNumber).replace(/^#/, '')}` : null,
    pepproOrderId ? `PepPro order ${pepproOrderId}` : null,
  ].filter(Boolean);
  const note = noteParts.join(' — ') || `Stripe refund ${stripeRefund.id} processed`;
  try {
    await wooCommerceClient.addOrderNote({
      wooOrderId,
      note,
    });
  } catch (error) {
    logger.warn({ err: error, wooOrderId, refundId: stripeRefund.id }, 'Failed to append WooCommerce refund note');
  }
};

const buildStripeRefundMetadata = ({ pepproOrderId, wooOrderId, wooOrderNumber }) => {
  const metadata = {};
  if (pepproOrderId) {
    metadata.peppro_order_id = pepproOrderId;
  }
  if (wooOrderId) {
    metadata.woo_order_id = wooOrderId;
  }
  if (wooOrderNumber) {
    metadata.woo_order_number = String(wooOrderNumber).replace(/^#/, '');
  }
  return metadata;
};

const getWooOrderNumberFromOrder = (order) => order?.wooOrderNumber
  || order?.integrationDetails?.wooCommerce?.response?.number
  || null;

const RETRIABLE_WOO_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const BACKGROUND_WOO_CANCELLATION_MAX_ATTEMPTS = 3;
const BACKGROUND_WOO_RETRY_BASE_DELAY_MS = 5000;
const wooCancellationRetryTracker = new Map();
let wooTaxFallbackWarned = false;

const shouldRetryWooCancellationError = (error) => {
  if (!error) {
    return false;
  }
  const code = error.code || error.cause?.code;
  if (code && RETRIABLE_WOO_ERROR_CODES.has(code)) {
    return true;
  }
  const status = error.response?.status ?? error.status;
  if (typeof status === 'number' && status >= 500) {
    return true;
  }
  const message = (error.message || error.cause?.message || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
};

const scheduleWooCancellationRetry = ({
  wooOrderId,
  reason,
  stripeRefund,
  pepproOrderId,
  wooOrderNumber,
  error,
}) => {
  if (!wooOrderId || (error && !shouldRetryWooCancellationError(error))) {
    return;
  }
  const currentAttempt = wooCancellationRetryTracker.get(wooOrderId) || 0;
  if (currentAttempt >= BACKGROUND_WOO_CANCELLATION_MAX_ATTEMPTS) {
    return;
  }
  const nextAttempt = currentAttempt + 1;
  const delayMs = Math.min(BACKGROUND_WOO_RETRY_BASE_DELAY_MS * nextAttempt, 60000);
  wooCancellationRetryTracker.set(wooOrderId, nextAttempt);
  logger.warn(
    {
      wooOrderId,
      attempt: nextAttempt,
      delayMs,
    },
    'Scheduling WooCommerce cancellation retry',
  );
  setTimeout(async () => {
    try {
      const result = await wooCommerceClient.cancelOrder({
        wooOrderId,
        reason,
        statusOverride: stripeRefund ? 'refunded' : 'cancelled',
      });
      logger.info({ wooOrderId, attempt: nextAttempt, result }, 'WooCommerce cancellation retry succeeded');
      if (stripeRefund) {
        await appendWooRefundNote({
          wooOrderId,
          wooOrderNumber: wooOrderNumber || wooOrderId,
          stripeRefund,
          pepproOrderId,
        });
      }
      wooCancellationRetryTracker.delete(wooOrderId);
    } catch (retryError) {
      logger.error({ err: retryError, wooOrderId, attempt: nextAttempt }, 'WooCommerce cancellation retry failed');
      wooCancellationRetryTracker.delete(wooOrderId);
      scheduleWooCancellationRetry({
        wooOrderId,
        reason,
        stripeRefund,
        pepproOrderId,
        wooOrderNumber,
        error: retryError,
      });
    }
  }, delayMs);
};

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
  taxTotal: order.taxTotal ?? null,
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

const roundCurrency = (value) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return 0;
  }
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const calculateItemsSubtotal = (items = []) => {
  if (!Array.isArray(items)) {
    return 0;
  }
  return roundCurrency(
    items.reduce((sum, item) => {
      const price = Number(item?.price) || 0;
      const quantity = Number(item?.quantity) || 0;
      return sum + price * quantity;
    }, 0),
  );
};

const normalizeTaxAmount = (value) => {
  const normalized = normalizeAmount(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return roundCurrency(normalized);
};

const calculateTaxFromRates = ({ rates, itemsSubtotal, shippingTotal }) => {
  if (!Array.isArray(rates) || rates.length === 0) {
    return 0;
  }
  const sortedRates = [...rates].sort(
    (a, b) => (Number(a?.priority) || 0) - (Number(b?.priority) || 0),
  );
  let accumulatedTax = 0;
  sortedRates.forEach((rate) => {
    const percentage = Number(rate?.rate);
    if (!Number.isFinite(percentage) || percentage <= 0) {
      return;
    }
    const multiplier = percentage / 100;
    const isCompound = Boolean(rate?.compound);
    const appliesToShipping = rate?.shipping === true
      || rate?.shipping === 'yes'
      || rate?.shipping === 1
      || rate?.shipping === '1';
    const taxBase = isCompound ? itemsSubtotal + accumulatedTax : itemsSubtotal;
    const lineTax = taxBase * multiplier;
    const shippingTax = appliesToShipping ? shippingTotal * multiplier : 0;
    accumulatedTax += lineTax + shippingTax;
  });
  return accumulatedTax;
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
  taxTotal,
}) => {
  if (!validateItems(items)) {
    const error = new Error('Order requires at least one item');
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
  const itemsSubtotal = calculateItemsSubtotal(items);
  const normalizedTaxTotal = normalizeTaxAmount(taxTotal);
  const computedTotal = roundCurrency(itemsSubtotal + shippingData.shippingTotal + normalizedTaxTotal);
  const normalizedTotal = typeof total === 'number' && !Number.isNaN(total) ? roundCurrency(total) : computedTotal;
  if (normalizedTotal <= 0) {
    const error = new Error('Order total must be a positive number');
    error.status = 400;
    throw error;
  }
  if (Math.abs(normalizedTotal - computedTotal) > 0.01) {
    const error = new Error('Order total mismatch. Refresh and try again.');
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const order = {
    id: Date.now().toString(),
    userId,
    items,
    total: computedTotal,
    taxTotal: normalizedTaxTotal,
    itemsSubtotal,
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
  const wooOrderNumber = integrations.wooCommerce?.response?.number || null;
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
      wooOrderNumber,
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
  if (wooOrderNumber) {
    order.wooOrderNumber = wooOrderNumber;
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

const allowZeroTaxFallback = process.env.ALLOW_ZERO_TAX_FALLBACK !== 'false';

const estimateOrderTotals = async ({
  userId,
  items,
  shippingAddress,
  shippingEstimate,
  shippingTotal,
}) => {
  if (!validateItems(items)) {
    const error = new Error('Order requires at least one item');
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

  const itemsSubtotal = calculateItemsSubtotal(items);
  const provisionalOrder = {
    id: `estimate-${Date.now()}`,
    userId,
    items,
    total: roundCurrency(itemsSubtotal + shippingData.shippingTotal),
    shippingTotal: shippingData.shippingTotal,
    shippingEstimate: shippingData.shippingEstimate,
    shippingAddress: shippingData.shippingAddress,
    billingAddress: buildBillingAddressFromUser(user, shippingData.shippingAddress),
    status: 'pending',
    createdAt: new Date().toISOString(),
    physicianCertificationAccepted: false,
  };

  let taxTotal = 0;
  let shippingTotalFromPreview = shippingData.shippingTotal;
  let wooTaxResponse = null;
  let taxSource = 'none';
  const shippingLocation = {
    country: provisionalOrder.shippingAddress.country || 'US',
    state: provisionalOrder.shippingAddress.state || '',
    postcode: provisionalOrder.shippingAddress.postalCode || provisionalOrder.shippingAddress.postcode || '',
    city: provisionalOrder.shippingAddress.city || '',
  };

  // Try Stripe Tax first if configured
  if (stripeClient.isTaxConfigured && stripeClient.isTaxConfigured()) {
    try {
      const stripeResult = await stripeClient.calculateStripeTax({
        items,
        shippingAddress: provisionalOrder.shippingAddress,
        shippingTotal: shippingTotalFromPreview,
      });
      if (stripeResult && stripeResult.status === 'success') {
        taxTotal = roundCurrency(stripeResult.taxAmount);
        taxSource = 'stripe_tax';
      }
    } catch (error) {
      logger.warn({ err: error, userId }, 'Stripe Tax calculation failed, falling back to WooCommerce tax logic');
    }
  }

  if (taxSource === 'none' && wooCommerceClient.isConfigured() && typeof wooCommerceClient.calculateOrderTaxes === 'function') {
    try {
      wooTaxResponse = await wooCommerceClient.calculateOrderTaxes({
        order: provisionalOrder,
        customer: user,
      });
      const taxLines = Array.isArray(wooTaxResponse?.response)
        ? wooTaxResponse.response
        : [];
      const totalTaxFromWoo = taxLines.reduce((sum, line) => {
        const lineTax = normalizeAmount(line?.total ?? line?.tax_total ?? line?.tax) || 0;
        const shippingTax = normalizeAmount(line?.shipping_tax ?? line?.shipping ?? 0) || 0;
        return sum + lineTax + shippingTax;
      }, 0);
      taxTotal = roundCurrency(totalTaxFromWoo);
      taxSource = 'woocommerce';
    } catch (error) {
      const isUnsupported = error?.code === 'WOO_TAX_UNSUPPORTED';
      if (isUnsupported) {
        if (!wooTaxFallbackWarned) {
          logger.warn({ err: error, userId }, 'WooCommerce tax preview endpoint unavailable; falling back to rate lookup');
          wooTaxFallbackWarned = true;
        }
      } else {
        logger.warn({ err: error, userId }, 'WooCommerce tax preview failed, trying rate fallback');
      }
      try {
        const rateResponse = await wooCommerceClient.fetchTaxRates(shippingLocation);
        if (Array.isArray(rateResponse) && rateResponse.length > 0) {
          const computedTax = calculateTaxFromRates({
            rates: rateResponse,
            itemsSubtotal,
            shippingTotal: shippingTotalFromPreview,
          });
          taxTotal = roundCurrency(computedTax);
          taxSource = 'rates_lookup';
          wooTaxResponse = {
            response: rateResponse,
            status: 'fallback_rates',
          };
        } else {
          logger.warn({ shippingLocation, userId }, 'WooCommerce tax rate lookup returned no rates');
        }
      } catch (lookupError) {
        logger.warn({ err: lookupError, userId }, 'WooCommerce tax rate lookup failed, using zero tax');
      }
    }
  }

  if (taxSource === 'none' && taxTotal === 0) {
    if (!allowZeroTaxFallback) {
      const error = new Error('Tax service unavailable for this address');
      error.status = 502;
      error.code = 'TAX_UNAVAILABLE';
      error.details = { shippingLocation };
      throw error;
    }
    logger.warn(
      { shippingLocation },
      'Tax service unavailable; returning zero tax via fallback',
    );
    taxSource = 'fallback_zero';
  }

  const grandTotal = roundCurrency(itemsSubtotal + shippingTotalFromPreview + taxTotal);

  return {
    success: true,
    totals: {
      itemsTotal: roundCurrency(itemsSubtotal),
      shippingTotal: roundCurrency(shippingTotalFromPreview),
      taxTotal: roundCurrency(taxTotal),
      grandTotal: roundCurrency(grandTotal),
      currency: 'USD',
      source: taxSource || (wooTaxResponse ? 'woocommerce' : 'fallback'),
    },
    wooPreview: wooTaxResponse,
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

  const buildWooCancellationResponse = ({
    wooOrder = null,
    status = 'cancelled',
    wooCancellation = null,
    stripeRefund = null,
    stripePaymentIntentId = null,
    pepproOrderId = null,
  }) => {
    const refundSummary = toStripeRefundSummary(stripeRefund);
    const wooOrderNumber = wooOrder?.number || String(normalizedWooOrderId);
    return {
      success: true,
      order: {
        id: String(normalizedWooOrderId),
        number: wooOrderNumber,
        status,
        source: 'woocommerce',
        updatedAt: new Date().toISOString(),
        integrationDetails: {
          stripe: (stripePaymentIntentId || refundSummary)
            ? {
                paymentIntentId: stripePaymentIntentId || null,
                refund: refundSummary,
              }
            : null,
          wooCommerce: {
            wooOrderNumber,
            pepproOrderId,
            status,
          },
        },
      },
      cancellationReason,
      wooCancellation: wooCancellation || {
        status: wooOrder ? 'success' : 'skipped',
        reason: wooOrder ? null : 'unavailable',
      },
      stripeRefund: refundSummary,
    };
  };

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

  const wooOrderNumber = wooOrder?.number || String(normalizedWooOrderId);
  const pepproOrderId = extractWooMetaValue(wooOrder, 'peppro_order_id');
  const stripePaymentIntentId = extractWooMetaValue(wooOrder, ['stripe_payment_intent', 'peppro_payment_intent', 'payment_intent']);
  const totalCents = Number.isFinite(Number(wooOrder?.total))
    ? Math.max(Math.round(Number(wooOrder.total) * 100), 0)
    : null;

  let stripeRefund = null;
  if (stripePaymentIntentId) {
    try {
      stripeRefund = await paymentService.refundPaymentIntent({
        paymentIntentId: stripePaymentIntentId,
        amountCents: totalCents || undefined,
        reason: cancellationReason,
        metadata: buildStripeRefundMetadata({
          pepproOrderId,
          wooOrderId: normalizedWooOrderId,
          wooOrderNumber,
        }),
      });
    } catch (error) {
      logger.error({ err: error, wooOrderId: normalizedWooOrderId, userId }, 'Stripe refund failed during Woo-only cancellation');
      const refundError = new Error('Unable to refund this order right now. Please try again soon.');
      refundError.status = 502;
      throw refundError;
    }
  }

  try {
    const wooCancellation = await wooCommerceClient.cancelOrder({
      wooOrderId: normalizedWooOrderId,
      reason: cancellationReason,
      statusOverride: stripeRefund ? 'refunded' : 'cancelled',
    });
    if (stripeRefund) {
      await appendWooRefundNote({
        wooOrderId: normalizedWooOrderId,
        wooOrderNumber,
        stripeRefund,
        pepproOrderId: pepproOrderId || null,
      });
    }
    return buildWooCancellationResponse({
      wooOrder,
      status: wooCancellation?.response?.status
        || (stripeRefund ? 'refunded' : wooOrder?.status || 'cancelled'),
      wooCancellation,
      stripeRefund,
      stripePaymentIntentId,
      pepproOrderId,
    });
  } catch (error) {
    logger.warn({ err: error, wooOrderId: normalizedWooOrderId, userId }, 'WooCommerce cancellation failed; returning fallback success');
    const backgroundRetry = shouldRetryWooCancellationError(error);
    if (backgroundRetry) {
      scheduleWooCancellationRetry({
        wooOrderId: normalizedWooOrderId,
        reason: cancellationReason,
        stripeRefund,
        pepproOrderId,
        wooOrderNumber,
        error,
      });
    }
    return buildWooCancellationResponse({
      wooOrder,
      status: stripeRefund ? 'refunded' : (wooOrder?.status || 'cancelled'),
      wooCancellation: {
        status: 'error',
        message: error.message,
        backgroundRetryScheduled: backgroundRetry,
      },
      stripeRefund,
      stripePaymentIntentId,
      pepproOrderId,
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
  const wooOrderNumber = getWooOrderNumberFromOrder(order);
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
    const refundMetadata = buildStripeRefundMetadata({
      pepproOrderId: order.id,
      wooOrderId: order.wooOrderId || null,
      wooOrderNumber: wooOrderNumber || order.wooOrderId || null,
    });
    try {
      stripeRefund = await paymentService.refundPaymentIntent({
        paymentIntentId: order.paymentIntentId,
        amountCents: amountCents || undefined,
        reason: cancellationReason,
        metadata: refundMetadata,
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
        statusOverride: stripeRefund ? 'refunded' : 'cancelled',
      });
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'Failed to cancel WooCommerce order after payment failure');
      const backgroundRetry = shouldRetryWooCancellationError(error);
      if (backgroundRetry) {
        scheduleWooCancellationRetry({
          wooOrderId: order.wooOrderId,
          reason: cancellationReason,
          stripeRefund,
          pepproOrderId: order.id,
          wooOrderNumber,
          error,
        });
      }
      wooCancellation = {
        status: 'error',
        message: error.message,
        backgroundRetryScheduled: backgroundRetry,
      };
    }
  }

  const updatedOrder = {
    ...order,
    status: stripeRefund ? 'refunded' : 'cancelled',
    cancellationReason,
    updatedAt: new Date().toISOString(),
    wooOrderNumber: wooOrderNumber || order.wooOrderNumber || null,
    integrationDetails: {
      ...(order.integrationDetails || {}),
      stripe: {
        ...(order.integrationDetails?.stripe || {}),
        status: stripeRefund ? 'refunded' : order.integrationDetails?.stripe?.status || null,
        reason: cancellationReason,
        cancellationReason,
        lastSyncAt: new Date().toISOString(),
        refund: stripeRefund
          ? toStripeRefundSummary(stripeRefund)
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
  if (stripeRefund && updatedOrder.wooOrderId) {
    await appendWooRefundNote({
      wooOrderId: updatedOrder.wooOrderId,
      wooOrderNumber: wooOrderNumber || updatedOrder.wooOrderNumber || updatedOrder.wooOrderId,
      stripeRefund,
      pepproOrderId: order.id,
    });
  }
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
  estimateOrderTotals,
  getOrdersForUser,
  cancelOrder,
};
