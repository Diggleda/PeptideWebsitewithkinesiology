const { env } = require('../config/env');
const orderRepository = require('../repositories/orderRepository');
const userRepository = require('../repositories/userRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const referralService = require('./referralService');
const emailService = require('./emailService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const paymentService = require('./paymentService');
const stripeClient = require('../integration/stripeClient');
const { ensureShippingData, normalizeAmount } = require('./shippingValidation');
const { logger } = require('../config/logger');
const orderSqlRepository = require('../repositories/orderSqlRepository');
const mysqlClient = require('../database/mysqlClient');
const crypto = require('crypto');
const { resolvePacificDayWindowUtc } = require('../utils/timeZone');

const sanitizeOrder = (order) => {
  if (!order || typeof order !== 'object') {
    return order;
  }
  const { idempotencyKey: _idempotencyKey, ...rest } = order;
  return { ...rest };
};

const isManualPaymentMethod = (value) => {
  const normalized = String(value || '').toLowerCase().trim();
  if (!normalized) return false;
  return (
    normalized.includes('zelle')
    || normalized.includes('bank')
    || normalized.includes('transfer')
    || normalized === 'bacs'
  );
};

const inFlightOrders = new Map();

const generateOrderId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
};

const buildIdempotentOrderId = ({ userId, idempotencyKey }) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${userId}:${idempotencyKey}`, 'utf8')
    .digest('hex');
  return `ord_${hash.slice(0, 24)}`;
};

const normalizeIdempotencyKey = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const buildReferralMessageFromOrder = (order) => {
  if (!order?.referrerBonus?.referrerName) {
    return null;
  }
  const commission = Number(order.referrerBonus?.commission);
  if (!Number.isFinite(commission)) {
    return null;
  }
  return `${order.referrerBonus.referrerName} earned $${commission.toFixed(2)} commission!`;
};

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const normalizeRole = (role) => (role || '').toString().trim().toLowerCase();

const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : '');

const fetchSalesRepDirectory = async (repIds) => {
  const ids = Array.from(new Set((repIds || []).map(normalizeId).filter(Boolean)));
  const lookup = new Map();
  if (ids.length === 0) {
    return lookup;
  }

  if (mysqlClient.isEnabled()) {
    const placeholders = ids.map((_, idx) => `:id${idx}`).join(', ');
    const params = ids.reduce((acc, id, idx) => ({ ...acc, [`id${idx}`]: id }), {});
    const query = `
      SELECT id, name, email
      FROM sales_reps
      WHERE id IN (${placeholders})
    `;
    try {
      const rows = await mysqlClient.fetchAll(query, params);
      (rows || []).forEach((row) => {
        const id = normalizeId(row?.id);
        if (!id) return;
        lookup.set(id, {
          id,
          name: typeof row?.name === 'string' && row.name.trim().length ? row.name.trim() : null,
          email: typeof row?.email === 'string' && row.email.trim().length ? row.email.trim() : null,
        });
      });
    } catch (error) {
      logger.warn({ err: error, ids: ids.length }, 'Failed to query MySQL sales_reps directory');
      try {
        const rows = await mysqlClient.fetchAll(
          `
            SELECT id, name, email
            FROM sales_rep
            WHERE id IN (${placeholders})
          `,
          params,
        );
        (rows || []).forEach((row) => {
          const id = normalizeId(row?.id);
          if (!id) return;
          lookup.set(id, {
            id,
            name: typeof row?.name === 'string' && row.name.trim().length ? row.name.trim() : null,
            email: typeof row?.email === 'string' && row.email.trim().length ? row.email.trim() : null,
          });
        });
      } catch {
        // ignore
      }
    }
  }

  // Overlay local store + users table as fallback.
  ids.forEach((id) => {
    if (lookup.has(id)) return;
    const stored = salesRepRepository.findById(id);
    if (stored) {
      lookup.set(id, {
        id,
        name: stored?.name || stored?.email || null,
        email: stored?.email || null,
      });
      return;
    }
    const user = userRepository.findById ? userRepository.findById(id) : null;
    if (user && normalizeRole(user.role) === 'sales_rep') {
      lookup.set(id, {
        id,
        name: user?.name || user?.email || null,
        email: user?.email || null,
      });
    }
  });

  return lookup;
};

const isDoctorRole = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'doctor' || normalized === 'test_doctor';
};

const normalizePricingMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'retail') return 'retail';
  return 'wholesale';
};

const canSelectRetailPricing = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'admin' || normalized === 'sales_rep' || normalized === 'rep';
};

const hasResellerPermitOnFile = async (user) => {
  const doctorId = normalizeId(user?.id);
  const email = normalizeEmail(user?.email);
  if (!doctorId && !email) {
    return false;
  }

  if (mysqlClient.isEnabled()) {
    const clauses = [];
    const params = {};
    if (doctorId) {
      clauses.push('doctor_id = :doctorId');
      params.doctorId = doctorId;
    }
    if (email) {
      clauses.push('LOWER(contact_email) = :email');
      params.email = email;
    }
    if (!clauses.length) {
      return false;
    }
    const where = clauses.join(' OR ');
    const row = await mysqlClient.fetchOne(
      `
        SELECT id
        FROM sales_prospects
        WHERE reseller_permit_file_path IS NOT NULL
          AND reseller_permit_file_path <> ''
          AND (${where})
        LIMIT 1
      `,
      params,
    );
    return Boolean(row);
  }

  try {
    const prospects = await salesProspectRepository.getAll();
    const list = Array.isArray(prospects) ? prospects : [];
    return list.some((prospect) => {
      const prospectDoctorId = normalizeId(prospect?.doctorId);
      const prospectEmail = normalizeEmail(prospect?.contactEmail);
      const matchesDoctor = doctorId && prospectDoctorId && prospectDoctorId === doctorId;
      const matchesEmail = email && prospectEmail && prospectEmail === email;
      if (!matchesDoctor && !matchesEmail) {
        return false;
      }
      const path = prospect?.resellerPermitFilePath;
      return typeof path === 'string' && path.trim().length > 0;
    });
  } catch {
    return false;
  }
};

const isUserTaxExemptForCheckout = async (user) => {
  if (!user || !isDoctorRole(user.role)) {
    return false;
  }
  if (user.isTaxExempt === true) {
    return true;
  }
  return hasResellerPermitOnFile(user);
};

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

const buildWooOrderSummary = (wooOrder) => {
  if (!wooOrder) {
    return null;
  }

  const mapped = typeof wooCommerceClient.mapWooOrderSummary === 'function'
    ? wooCommerceClient.mapWooOrderSummary(wooOrder)
    : null;
  if (!mapped) {
    return null;
  }

  const number = mapped.wooOrderNumber || mapped.number || mapped.id || null;
  return {
    ...mapped,
    wooOrderId: mapped.wooOrderId || mapped.id || null,
    wooOrderNumber: mapped.wooOrderNumber || number,
    number,
  };
};

const resolveWooOrderNumber = async (order) => {
  const existing = getWooOrderNumberFromOrder(order);
  if (existing) {
    return existing;
  }
  if (order?.wooOrderId && wooCommerceClient?.isConfigured?.()) {
    try {
      const wooOrder = await wooCommerceClient.fetchOrderById(order.wooOrderId);
      const number = wooOrder?.number || String(order.wooOrderId);
      if (number) {
        return number;
      }
    } catch (error) {
      logger.debug(
        { err: error, wooOrderId: order.wooOrderId },
        'Unable to resolve Woo order number during sync',
      );
    }
  }
  return null;
};

const DEFAULT_ORDER_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RETRIABLE_WOO_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const BACKGROUND_WOO_CANCELLATION_MAX_ATTEMPTS = 3;
const BACKGROUND_WOO_RETRY_BASE_DELAY_MS = 5000;
const wooCancellationRetryTracker = new Map();
let wooTaxFallbackWarned = false;
let orderSyncTimer = null;

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

const buildLocalOrderSummary = (order) => {
  const wooOrderNumber = getWooOrderNumberFromOrder(order)
    || order.wooOrderId
    || order.integrationDetails?.wooCommerce?.orderId
    || null;

  return {
    id: order.id,
    number: wooOrderNumber || order.id,
    status: order.status,
    total: order.total,
    pricingMode: order.pricingMode || 'wholesale',
    currency: order.currency || 'USD',
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt,
    referralCode: order.referralCode || null,
    source: order.source || 'local',
    userId: order.userId,
    lineItems: (order.items || []).map((item) => ({
      id: item.cartItemId || item.productId || item.id || `${order.id}-${item.name}`,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      total: Number(item.price || 0) * Number(item.quantity || 0),
      sku: item.sku || item.productSku || null,
      productId: item.productId || null,
      variantId: item.variantId || null,
      image: item.image || null,
    })),
    integrations: order.integrations || null,
    referrerBonus: order.referrerBonus || null,
    integrationDetails: order.integrationDetails || null,
    paymentMethod: order.paymentMethod
      || (order.integrationDetails?.stripe?.cardLast4
        ? `${order.integrationDetails?.stripe?.cardBrand || 'Card'} •••• ${order.integrationDetails.stripe.cardLast4}`
        : null),
    paymentDetails: order.paymentDetails
      || order.paymentMethod
      || (order.integrationDetails?.stripe?.cardLast4
        ? `${order.integrationDetails?.stripe?.cardBrand || 'Card'} •••• ${order.integrationDetails.stripe.cardLast4}`
        : null),
    shippingAddress: buildAddressSummary(order.shippingAddress),
    billingAddress: buildAddressSummary(order.billingAddress),
    shippingEstimate: order.shippingEstimate || null,
    shippingTotal: order.shippingTotal ?? null,
    taxTotal: order.taxTotal ?? null,
    wooOrderId: order.wooOrderId || order.integrationDetails?.wooCommerce?.orderId || null,
    wooOrderNumber: wooOrderNumber,
    shipStationOrderId: order.shipStationOrderId || null,
    physicianCertified: order.physicianCertificationAccepted === true,
  };
};

const ensurePlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
};

const resolveShipStationOrderNumber = (order) => {
  if (!order || typeof order !== 'object') {
    return null;
  }
  const candidates = [];
  if (order.number) {
    candidates.push(order.number);
  }
  if (order.wooOrderNumber) {
    candidates.push(order.wooOrderNumber);
  }
  if (order.woo_order_number) {
    candidates.push(order.woo_order_number);
  }
  if (order.integrationDetails?.wooCommerce?.wooOrderNumber) {
    candidates.push(order.integrationDetails.wooCommerce.wooOrderNumber);
  }
  const metaData = Array.isArray(order.meta_data) ? order.meta_data : [];
  const pepproMeta = metaData.find((entry) => entry?.key === 'peppro_order_id');
  if (pepproMeta && pepproMeta.value !== undefined && pepproMeta.value !== null) {
    candidates.push(pepproMeta.value);
  }
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }
    const str = String(candidate).trim();
    if (str.length > 0) {
      return str;
    }
  }
  return null;
};

const enrichOrderWithShipStation = async (order) => {
  if (!order || !shipStationClient.isConfigured()) {
    return order;
  }

  const orderNumber = resolveShipStationOrderNumber(order);
  if (!orderNumber) {
    return order;
  }

  let info = null;
  try {
    // eslint-disable-next-line no-await-in-loop
    info = await shipStationClient.fetchOrderStatus(orderNumber);
  } catch (error) {
    logger.warn(
      {
        err: error,
        orderNumber,
      },
      'ShipStation status lookup failed for order',
    );
    return order;
  }

  if (!info) {
    return order;
  }

  logger.info(
    {
      orderNumber,
      shipStationStatus: info.status || null,
      shipStationTracking: info.trackingNumber || null,
      shipStationShipDate: info.shipDate || null,
    },
    'ShipStation enrichment result',
  );

  const integrations = ensurePlainObject(order.integrationDetails || order.integrations);
  integrations.shipStation = info;

  const shippingEstimate = ensurePlainObject(order.shippingEstimate || order.shipping_estimate);
  const shipStatus = (info.status || '').toString().toLowerCase();
  const existingStatus = (order.status || '').toString().toLowerCase();
  const isCanceled = existingStatus.includes('cancel') || existingStatus === 'trash';

  const nextOrder = {
    ...order,
    integrationDetails: integrations,
    integrations: order.integrations || integrations,
  };

  if (shipStatus && !isCanceled) {
    nextOrder.status = shipStatus;
  }

  if (shipStatus === 'shipped') {
    if (!shippingEstimate.status) {
      shippingEstimate.status = 'shipped';
    }
    if (info.shipDate && !shippingEstimate.shipDate) {
      shippingEstimate.shipDate = info.shipDate;
    }
  }

  if (info.carrierCode && !shippingEstimate.carrierId) {
    shippingEstimate.carrierId = info.carrierCode;
  }
  if (info.serviceCode && !shippingEstimate.serviceType) {
    shippingEstimate.serviceType = info.serviceCode;
  }

  const hasEstimateFields = Object.keys(shippingEstimate).length > 0;

  nextOrder.shippingEstimate = hasEstimateFields
    ? shippingEstimate
    : (order.shippingEstimate || order.shipping_estimate || null);

  if (!nextOrder.trackingNumber && info.trackingNumber) {
    nextOrder.trackingNumber = info.trackingNumber;
  }

  return nextOrder;
};

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

const hasPaidLineItem = (items = []) => {
  if (!Array.isArray(items)) {
    return false;
  }
  return items.some((item) => {
    const quantity = Number(item?.quantity);
    const price = Number(item?.price);
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) {
      return false;
    }
    const lineTotal = price * quantity;
    return quantity > 0 && lineTotal > 0;
  });
};

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

const createOrderInternal = async ({
  userId,
  idempotencyKey,
  orderId,
  items,
  total,
  referralCode,
  shippingAddress,
  shippingEstimate,
  shippingTotal,
  physicianCertification,
  taxTotal,
  paymentMethod,
  pricingMode,
}) => {
  if (!validateItems(items)) {
    const error = new Error('Order requires at least one item');
    error.status = 400;
    throw error;
  }
  if (!hasPaidLineItem(items)) {
    const error = new Error('Order must include at least one paid line item before checkout.');
    error.status = 400;
    error.code = 'INVALID_LINE_ITEMS';
    throw error;
  }

  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  const requestedPricingMode = normalizePricingMode(pricingMode);
  const effectivePricingMode = canSelectRetailPricing(user.role) ? requestedPricingMode : 'wholesale';

  const taxExempt = await isUserTaxExemptForCheckout(user);
  const shippingData = ensureShippingData({
    shippingAddress,
    shippingEstimate,
    shippingTotal,
  });
  const itemsSubtotal = calculateItemsSubtotal(items);
  const normalizedTaxTotal = taxExempt ? 0 : normalizeTaxAmount(taxTotal);
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
  const resolveManualPaymentLabel = (raw) => {
    const normalized = String(raw || '').toLowerCase().trim();
    if (normalized === 'zelle') return 'Zelle';
    if (normalized === 'bank_transfer' || normalized === 'bank' || normalized === 'transfer') return 'Direct Bank Transfer';
    if (normalized === 'bacs') return 'Direct Bank Transfer';
    return 'Zelle / Bank transfer';
  };
  const manualPaymentLabel = resolveManualPaymentLabel(paymentMethod);
  const order = {
    id: orderId || generateOrderId(),
    userId,
    items,
    total: computedTotal,
    pricingMode: effectivePricingMode,
    taxTotal: normalizedTaxTotal,
    itemsSubtotal,
    shippingTotal: shippingData.shippingTotal,
    shippingEstimate: shippingData.shippingEstimate,
    shippingAddress: shippingData.shippingAddress,
    billingAddress: buildBillingAddressFromUser(user, shippingData.shippingAddress),
    referralCode: referralCode || null,
    status: 'pending',
    paymentMethod: manualPaymentLabel,
    paymentDetails: manualPaymentLabel,
    createdAt: now,
    physicianCertificationAccepted: Boolean(physicianCertification),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };

  const referralResult = referralService.applyReferralCredit({
    referralCode,
    total: computedTotal,
    purchaserId: userId,
    orderId: order.id,
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

  integrations.stripe = {
    status: 'disabled',
    reason: 'manual_payment',
    message: 'Stripe payments are disabled; customer will pay via Zelle/bank transfer.',
    ...(wooOrderId ? { wooOrderId, wooOrderNumber } : {}),
  };

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

  order.integrations = {
    wooCommerce: integrations.wooCommerce?.status,
    stripe: integrations.stripe?.status,
    shipEngine: integrations.shipEngine?.status,
    shipStation: integrations.shipStation?.status,
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

  try {
    integrations.mysql = await orderSqlRepository.persistOrder({
      order,
      wooOrderId,
      shipStationOrderId,
    });
    logger.info(
      {
        orderId: order.id,
        wooOrderId: wooOrderId || null,
        wooOrderNumber: wooOrderNumber || null,
        userId: order.userId,
        mysqlStatus: integrations.mysql?.status || null,
      },
      'Order persisted to MySQL',
    );
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

  const to = user?.email || order?.billingAddress?.email || null;
  if (to) {
    try {
      await emailService.sendOrderPaymentInstructionsEmail({
        to,
        customerName: user?.name || null,
        orderId: order.id,
        wooOrderNumber,
        total: order.total,
      });
    } catch (error) {
      logger.warn({ err: error, orderId: order.id }, 'Failed to send payment instructions email');
    }
  }

  return {
    success: true,
    order: sanitizeOrder(order),
    message: referralResult
      ? `${referralResult.referrerName} earned $${referralResult.commission.toFixed(2)} commission!`
      : null,
    integrations,
  };
};

const createOrder = async ({
  userId,
  idempotencyKey,
  items,
  total,
  referralCode,
  shippingAddress,
  shippingEstimate,
  shippingTotal,
  physicianCertification,
  taxTotal,
  paymentMethod,
  pricingMode,
}) => {
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  if (idempotencyKey && !normalizedIdempotencyKey) {
    const error = new Error('Invalid Idempotency-Key header');
    error.status = 400;
    error.code = 'INVALID_IDEMPOTENCY_KEY';
    throw error;
  }

  if (!normalizedIdempotencyKey) {
    return createOrderInternal({
      userId,
      idempotencyKey: null,
      orderId: null,
      items,
      total,
      referralCode,
      shippingAddress,
      shippingEstimate,
      shippingTotal,
      physicianCertification,
      taxTotal,
      paymentMethod,
      pricingMode,
    });
  }

  const orderId = buildIdempotentOrderId({ userId, idempotencyKey: normalizedIdempotencyKey });
  const existingOrder = orderRepository.findById(orderId)
    || orderRepository.findByUserIdAndIdempotencyKey(userId, normalizedIdempotencyKey);
  if (existingOrder) {
    return {
      success: true,
      order: sanitizeOrder(existingOrder),
      message: buildReferralMessageFromOrder(existingOrder),
      integrations: existingOrder.integrationDetails || {},
    };
  }

  const inFlightKey = `${userId}:${normalizedIdempotencyKey}`;
  const existingPromise = inFlightOrders.get(inFlightKey);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = createOrderInternal({
    userId,
    idempotencyKey: normalizedIdempotencyKey,
    orderId,
    items,
    total,
    referralCode,
    shippingAddress,
    shippingEstimate,
    shippingTotal,
    physicianCertification,
    taxTotal,
    paymentMethod,
    pricingMode,
  });

  inFlightOrders.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    inFlightOrders.delete(inFlightKey);
  }
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
  const taxExempt = await isUserTaxExemptForCheckout(user);
  if (taxExempt) {
    const grandTotal = roundCurrency(itemsSubtotal + shippingData.shippingTotal);
    return {
      success: true,
      totals: {
        itemsTotal: roundCurrency(itemsSubtotal),
        shippingTotal: roundCurrency(shippingData.shippingTotal),
        taxTotal: 0,
        grandTotal: roundCurrency(grandTotal),
        currency: 'USD',
        source: 'tax_exempt',
      },
      wooPreview: null,
    };
  }
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

  const wooStatus = String(wooOrder?.status || '').trim().toLowerCase().replace(/_/g, '-');
  const cancellableWooStatuses = new Set(['pending', 'on-hold']);
  if (wooStatus && !cancellableWooStatuses.has(wooStatus)) {
    const error = new Error('This order can no longer be cancelled');
    error.status = 400;
    throw error;
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
  const wooPaymentMethodLabel = wooOrder?.payment_method_title || wooOrder?.payment_method || null;
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
    const manualRefundReviewRequired = !stripeRefund && isManualPaymentMethod(wooPaymentMethodLabel);
    if (manualRefundReviewRequired) {
      if (typeof wooCommerceClient.addOrderNote === 'function') {
        try {
          await wooCommerceClient.addOrderNote({
            wooOrderId: normalizedWooOrderId,
            note:
              `Cancelled via account portal. Manual payment (${wooPaymentMethodLabel || 'Zelle / Bank transfer'}) — ` +
              `please review for refund if payment was already received.`,
            isCustomerNote: false,
          });
        } catch (noteError) {
          logger.warn({ err: noteError, wooOrderId: normalizedWooOrderId }, 'Failed to append WooCommerce refund review note');
        }
      }
      try {
        await emailService.sendManualRefundReviewEmail({
          orderId: String(normalizedWooOrderId),
          wooOrderNumber,
          customerName: user?.name || null,
          customerEmail: user?.email || null,
          paymentMethod: wooPaymentMethodLabel,
          total: Number.isFinite(Number(wooOrder?.total)) ? Number(wooOrder.total) : null,
          reason: cancellationReason,
        });
      } catch (emailError) {
        logger.warn({ err: emailError, wooOrderId: normalizedWooOrderId }, 'Failed to send manual refund review email for Woo-only cancellation');
      }
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
  let order = orderRepository.findById(orderId);
  if (!order && typeof orderSqlRepository.fetchById === 'function') {
    try {
      const sqlOrder = await orderSqlRepository.fetchById(orderId);
      if (sqlOrder) {
        order = {
          ...sqlOrder,
          integrationDetails: sqlOrder.integrationDetails
            || sqlOrder.payload?.integrations
            || sqlOrder.integrations
            || null,
          integrations: sqlOrder.integrations || null,
        };
      }
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to load order from MySQL during cancellation');
    }
  }
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
  const normalizedStatus = String(order.status || '').trim().toLowerCase().replace(/_/g, '-');
  const wooOrderNumber = getWooOrderNumberFromOrder(order);
  const cancellableStatuses = new Set(['pending', 'on-hold']);

  // If local record says cancellable, confirm against Woo (source of truth) when possible.
  if (cancellableStatuses.has(normalizedStatus) && order.wooOrderId && wooCommerceClient.isConfigured()) {
    try {
      const wooOrder = await wooCommerceClient.fetchOrderById(order.wooOrderId);
      const wooStatus = String(wooOrder?.status || '').trim().toLowerCase().replace(/_/g, '-');
      if (wooStatus && !cancellableStatuses.has(wooStatus)) {
        const error = new Error('This order can no longer be cancelled');
        error.status = 400;
        throw error;
      }
    } catch (error) {
      // If Woo lookup fails, fall back to local status gate.
      logger.warn({ err: error, orderId: order.id, wooOrderId: order.wooOrderId }, 'Woo status fetch failed during cancellation; falling back to local status');
    }
  }

  if (!cancellableStatuses.has(normalizedStatus)) {
    const error = new Error('This order can no longer be cancelled');
    error.status = 400;
    throw error;
  }

  let stripeRefund = null;
  const requiresRefund = Boolean(order.paymentIntentId);
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

  const manualPaymentUsed = isManualPaymentMethod(order.paymentMethod || order.paymentDetails);

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

  if (manualPaymentUsed && order.wooOrderId && typeof wooCommerceClient.addOrderNote === 'function') {
    try {
      await wooCommerceClient.addOrderNote({
        wooOrderId: order.wooOrderId,
        note:
          `Cancelled via account portal. Manual payment (${order.paymentMethod || 'Zelle / Bank transfer'}) — ` +
          `please review for refund if payment was already received.`,
        isCustomerNote: false,
      });
    } catch (error) {
      logger.warn({ err: error, orderId: order.id, wooOrderId: order.wooOrderId }, 'Failed to append WooCommerce refund review note');
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

  const manualRefundReviewRequired = manualPaymentUsed && !stripeRefund;
  if (manualRefundReviewRequired) {
    try {
      const customer = userRepository.findById(userId);
      await emailService.sendManualRefundReviewEmail({
        orderId: updatedOrder.id,
        wooOrderNumber: wooOrderNumber || updatedOrder.wooOrderNumber || updatedOrder.wooOrderId || null,
        customerName: customer?.name || null,
        customerEmail: customer?.email || null,
        paymentMethod: updatedOrder.paymentMethod || updatedOrder.paymentDetails || null,
        total: (updatedOrder.total ?? 0) + (updatedOrder.shippingTotal ?? 0) + (updatedOrder.taxTotal ?? 0),
        reason: cancellationReason,
      });
    } catch (error) {
      logger.warn({ err: error, orderId: updatedOrder.id }, 'Failed to send manual refund review email');
    }
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
    manualRefundReviewRequired,
  };
};

const getOrdersForUser = async (userId) => {
  const user = typeof userRepository.findById === 'function'
    ? userRepository.findById(userId)
    : null;
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  let localSummaries = [];

  let wooOrders = [];
  let wooError = null;
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (email && typeof wooCommerceClient.fetchOrdersByEmail === 'function') {
    try {
      wooOrders = await wooCommerceClient.fetchOrdersByEmail(email, { perPage: 20 });
      if (Array.isArray(wooOrders) && wooOrders.length > 0) {
        const enriched = [];
        // Preserve Stripe/local payment metadata while enriching with ShipStation status/tracking.
        // eslint-disable-next-line no-restricted-syntax
        for (const rawOrder of wooOrders) {
          const order = await enrichOrderWithShipStation(rawOrder);
          const pepproOrderId = order?.integrationDetails?.wooCommerce?.pepproOrderId
            || order?.integrationDetails?.wooCommerce?.peppro_order_id
            || null;
          if (!pepproOrderId) {
            enriched.push(order);
            // eslint-disable-next-line no-continue
            continue;
          }
          const localOrder = orderRepository.findById(pepproOrderId);
          if (!localOrder) {
            enriched.push(order);
            // eslint-disable-next-line no-continue
            continue;
          }
          const stripeMeta = localOrder.integrationDetails?.stripe || null;
          enriched.push({
            ...order,
            paymentMethod: localOrder.paymentMethod || order.paymentMethod,
            paymentDetails:
              localOrder.paymentDetails
              || localOrder.paymentMethod
              || order.paymentDetails
              || order.paymentMethod
              || null,
            integrationDetails: {
              ...(order.integrationDetails || {}),
              stripe: stripeMeta || order.integrationDetails?.stripe || null,
            },
          });
        }
        wooOrders = enriched;
      }
    } catch (error) {
      logger.error(
        { err: error, userId, email },
        'Failed to fetch WooCommerce orders for user',
      );
      wooError = {
        message: error.message || 'Unable to load WooCommerce orders.',
        details: error.response?.data || error.cause || null,
        status: error.response?.status ?? error.status ?? 502,
      };
    }
  }

  const sampleWoo = Array.isArray(wooOrders) && wooOrders.length > 0 ? wooOrders[0] : null;
  logger.info(
    {
      userId,
      wooCount: Array.isArray(wooOrders) ? wooOrders.length : 0,
      sampleOrderId: sampleWoo?.id || sampleWoo?.number || null,
      sampleTracking: sampleWoo?.trackingNumber
        || sampleWoo?.integrationDetails?.shipStation?.trackingNumber
        || null,
      sampleShipStationStatus: sampleWoo?.integrationDetails?.shipStation?.status || null,
    },
    'User orders response snapshot',
  );

  return {
    local: localSummaries,
    woo: wooOrders,
    fetchedAt: new Date().toISOString(),
    wooError,
  };
};

const getOrdersForSalesRep = async (
  salesRepId,
  {
    includeDoctors = false,
    includeSelfOrders = false,
    includeAllDoctors = false,
    alternateSalesRepIds = [],
  } = {},
) => {
  const normalizedSalesRepId = normalizeId(salesRepId);
  const normalizedAlternates = Array.isArray(alternateSalesRepIds)
    ? alternateSalesRepIds.map(normalizeId).filter(Boolean)
    : [];
  const allowedRepIds = new Set([normalizedSalesRepId, ...normalizedAlternates].filter(Boolean));
  logger.info(
    {
      salesRepId: normalizedSalesRepId,
      alternates: normalizedAlternates,
      includeDoctors,
      includeSelfOrders,
      includeAllDoctors,
    },
    'Sales rep order fetch: scope resolved',
  );

  const doctors = userRepository.getAll().filter((candidate) => {
    const role = normalizeRole(candidate.role);
    const isDoctorRole = role === 'doctor' || role === 'test_doctor';
    const includeSalesRepCustomers = includeAllDoctors && allowedRepIds.size === 0;
    const isSalesRepCustomerRole = includeSalesRepCustomers && (role === 'sales_rep' || role === 'rep');
    if (!isDoctorRole && !isSalesRepCustomerRole) {
      return false;
    }
    if (includeAllDoctors) {
      return allowedRepIds.size === 0 ? true : allowedRepIds.has(normalizeId(candidate.salesRepId));
    }
    const repId = normalizeId(candidate.salesRepId);
    return allowedRepIds.size === 0 ? false : allowedRepIds.has(repId);
  });

  const repDirectory = await fetchSalesRepDirectory([
    ...doctors.map((doctor) => doctor?.salesRepId),
    ...Array.from(allowedRepIds),
  ]);

  const doctorLookup = new Map(
    doctors.map((doctor) => {
      const id = normalizeId(doctor.id);
      const repId = normalizeId(doctor.salesRepId);
      const rep = repId ? repDirectory.get(repId) : null;
      return [
        id,
        {
          id,
          name: doctor.name || doctor.email || 'Doctor',
          email: doctor.email || null,
          profileImageUrl: doctor.profileImageUrl || null,
          salesRepId: repId || null,
          salesRepName: rep?.name || null,
          salesRepEmail: rep?.email || null,
        },
      ];
    }),
  );

  // Ensure prospects (e.g., referred doctors) show up in sales rep orders even if the doctor
  // user record hasn't been assigned a `salesRepId` yet. This removes the "delay" where orders
  // exist but the doctor doesn't show in "Your Sales" until a separate assignment sync happens.
  if (allowedRepIds.size > 0) {
    try {
      const prospects = await salesProspectRepository.getAll();
      const list = Array.isArray(prospects) ? prospects : [];
      const extraDoctors = new Map();
      list.forEach((prospect) => {
        const salesRepId = normalizeId(prospect?.salesRepId);
        if (!salesRepId || !allowedRepIds.has(salesRepId)) return;
        const doctorId = normalizeId(prospect?.doctorId);
        if (!doctorId) return;
        if (!extraDoctors.has(doctorId)) {
          extraDoctors.set(doctorId, salesRepId);
        }
      });
      extraDoctors.forEach((salesRepId, doctorId) => {
        if (doctorLookup.has(doctorId)) {
          return;
        }
        const user = userRepository.findById ? userRepository.findById(doctorId) : null;
        const name = user?.name || user?.email || 'Doctor';
        const email = user?.email || null;
        const profileImageUrl = user?.profileImageUrl || null;
        const rep = salesRepId ? repDirectory.get(salesRepId) : null;
        doctorLookup.set(doctorId, {
          id: doctorId,
          name,
          email,
          profileImageUrl,
          salesRepId: salesRepId || null,
          salesRepName: rep?.name || null,
          salesRepEmail: rep?.email || null,
        });
        doctors.push({
          id: doctorId,
          name,
          email,
          profileImageUrl,
          salesRepId: salesRepId || null,
        });
      });
    } catch (error) {
      logger.warn({ err: error }, 'Sales rep order fetch: unable to load sales prospects');
    }
  }

  const contactLeadByEmail = new Map();
  if (mysqlClient.isEnabled()) {
    try {
      const prospects = await salesProspectRepository.getAll();
      const list = Array.isArray(prospects) ? prospects : [];
      list.forEach((prospect) => {
        const contactFormId = normalizeId(prospect?.contactFormId);
        const email = normalizeEmail(prospect?.contactEmail);
        if (!contactFormId || !email) return;

        const prospectSalesRepId = normalizeId(prospect?.salesRepId);
        const matchesRep =
          prospectSalesRepId && allowedRepIds.has(normalizeId(prospectSalesRepId));

        if (includeAllDoctors) {
          if (allowedRepIds.size > 0 && !matchesRep) return;
        } else if (!matchesRep) {
          return;
        }

        const leadDoctorId =
          normalizeId(prospect?.doctorId) || `contact_form:${contactFormId}`;
        if (!leadDoctorId) return;

        const rep = prospectSalesRepId ? repDirectory.get(prospectSalesRepId) : null;
        const leadRecord = {
          id: leadDoctorId,
          name: prospect?.contactName || email,
          email,
          profileImageUrl: null,
          phone: prospect?.contactPhone || null,
          leadType: 'contact_form',
          leadTypeSource: 'contact_form',
          leadTypeLockedAt: prospect?.updatedAt || prospect?.createdAt || null,
          salesRepId: prospectSalesRepId || null,
          salesRepName: rep?.name || null,
          salesRepEmail: rep?.email || null,
        };

        if (!contactLeadByEmail.has(email)) {
          contactLeadByEmail.set(email, leadRecord);
        }

        const existing = doctorLookup.get(leadDoctorId);
        if (existing) {
          doctorLookup.set(leadDoctorId, {
            ...leadRecord,
            ...existing,
            id: leadDoctorId,
            name: existing.name || leadRecord.name,
            email: existing.email || leadRecord.email,
            profileImageUrl: existing.profileImageUrl || leadRecord.profileImageUrl,
          });
        } else {
          doctorLookup.set(leadDoctorId, leadRecord);
        }
      });
    } catch (error) {
      logger.warn({ err: error }, 'Sales rep order fetch: unable to load contact form prospects');
    }
  }

  if (includeSelfOrders && normalizedSalesRepId && !doctorLookup.has(normalizedSalesRepId)) {
    const selfUser = userRepository.findById ? userRepository.findById(normalizedSalesRepId) : null;
    doctorLookup.set(normalizedSalesRepId, {
      id: normalizedSalesRepId,
      name: (selfUser && (selfUser.name || selfUser.email)) || 'Your Orders',
      email: selfUser?.email || null,
      profileImageUrl: selfUser?.profileImageUrl || null,
    });
    doctors.push({
      id: normalizedSalesRepId,
      name: selfUser?.name || selfUser?.email || 'Your Orders',
      email: selfUser?.email || null,
    });
  }

  const summaries = [];
  const seenKeys = new Set();
  const doctorIds = doctors.map((d) => normalizeId(d.id)).filter(Boolean);
  const contactLeadEmails = Array.from(contactLeadByEmail.keys());

  // Only use MySQL/WooCommerce-backed orders for sales rep reporting
  if (mysqlClient.isEnabled()) {
    const sqlOrders = await orderSqlRepository.fetchByUserIds(doctorIds);
    logger.debug(
      {
        doctors: doctorIds.length,
        sqlOrders: Array.isArray(sqlOrders) ? sqlOrders.length : 0,
        mysqlEnabled: mysqlClient.isEnabled(),
      },
      'Sales rep fetch: using MySQL order source',
    );
    // Enrich each SQL-backed order with ShipStation metadata when configured.
    // eslint-disable-next-line no-restricted-syntax
    for (const rawOrder of sqlOrders) {
      // eslint-disable-next-line no-await-in-loop
      const order = await enrichOrderWithShipStation(rawOrder);
      const key = `sql:${order.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const doctorMeta = doctorLookup.get(normalizeId(order.userId)) || null;
      summaries.push({
        ...buildLocalOrderSummary(order),
        doctorId: order.userId,
        doctorName: doctorMeta?.name || 'Doctor',
        doctorEmail: doctorMeta?.email || null,
        doctorProfileImageUrl: doctorMeta?.profileImageUrl || null,
        doctorSalesRepId: doctorMeta?.salesRepId || null,
        doctorSalesRepName: doctorMeta?.salesRepName || null,
        doctorSalesRepEmail: doctorMeta?.salesRepEmail || null,
        source: 'mysql',
      });
    }

    if (
      typeof orderSqlRepository.fetchByBillingEmails === 'function'
      && contactLeadEmails.length > 0
    ) {
      const emailOrders = await orderSqlRepository.fetchByBillingEmails(contactLeadEmails);
      // eslint-disable-next-line no-restricted-syntax
      for (const rawOrder of emailOrders) {
        // eslint-disable-next-line no-await-in-loop
        const order = await enrichOrderWithShipStation(rawOrder);
        const key = `sql:${order.id}`;
        if (seenKeys.has(key)) continue;
        const billingEmail = normalizeEmail(
          order?.billingAddress?.email
            || order?.billingAddress?.emailAddress
            || order?.payload?.order?.billing?.email
            || order?.payload?.order?.billing_email
            || null,
        );
        const lead = billingEmail ? contactLeadByEmail.get(billingEmail) : null;
        if (!lead) continue;
        seenKeys.add(key);
        summaries.push({
          ...buildLocalOrderSummary(order),
          doctorId: lead.id,
          doctorName: lead.name || 'House / Contact Form',
          doctorEmail: lead.email || null,
          doctorProfileImageUrl: lead.profileImageUrl || null,
          doctorSalesRepId: lead.salesRepId || null,
          doctorSalesRepName: lead.salesRepName || null,
          doctorSalesRepEmail: lead.salesRepEmail || null,
          source: 'mysql',
        });
      }
    }
  } else if (wooCommerceClient?.isConfigured?.()) {
    for (const doctor of doctors) {
      const doctorEmail = (doctor.email || '').trim().toLowerCase();
      if (!doctorEmail) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const wooOrders = await wooCommerceClient.fetchOrdersByEmail(doctorEmail, { perPage: 50 });
        logger.debug(
          {
            doctorId: doctor.id,
            doctorEmail,
            count: Array.isArray(wooOrders) ? wooOrders.length : 0,
          },
          'Sales rep fetch: WooCommerce orders loaded for doctor',
        );
        // eslint-disable-next-line no-restricted-syntax
        for (const wooOrder of wooOrders) {
          const baseSummary = buildWooOrderSummary(wooOrder);
          if (!baseSummary) continue;
          // eslint-disable-next-line no-await-in-loop
          const summary = await enrichOrderWithShipStation(baseSummary);
	          const key = `woo:${summary.id || summary.number}`;
	          if (seenKeys.has(key)) continue;
	          seenKeys.add(key);
	          const doctorMeta = doctorLookup.get(doctor.id) || null;
	          summaries.push({
	            ...summary,
	            doctorId: doctor.id,
	            doctorName: doctorMeta?.name || doctor.name || 'Doctor',
	            doctorEmail: doctorMeta?.email || doctor.email || null,
	            doctorProfileImageUrl: doctorMeta?.profileImageUrl || doctor.profileImageUrl || null,
	            doctorSalesRepId: doctorMeta?.salesRepId || null,
	            doctorSalesRepName: doctorMeta?.salesRepName || null,
	            doctorSalesRepEmail: doctorMeta?.salesRepEmail || null,
	            source: 'woo',
	          });
	        }
      } catch (error) {
        logger.error({ err: error, doctorEmail }, 'Failed to fetch WooCommerce orders for doctor');
      }
    }
  } else {
    const doctorIdSet = new Set(doctorIds);
    const localOrders = orderRepository.getAll().filter((order) => doctorIdSet.has(normalizeId(order?.userId)));
    logger.info(
      {
        doctors: doctors.length,
        doctorIds: doctorIds.length,
        localOrders: localOrders.length,
        mysqlEnabled: mysqlClient.isEnabled(),
        wooConfigured: !!wooCommerceClient?.isConfigured?.(),
      },
      'Sales rep fetch: using local JSON order source',
    );

    // eslint-disable-next-line no-restricted-syntax
    for (const rawOrder of localOrders) {
      const baseSummary = buildLocalOrderSummary(rawOrder);
      if (!baseSummary) continue;
      // eslint-disable-next-line no-await-in-loop
      const summary = await enrichOrderWithShipStation(baseSummary);
      const key = `local:${summary.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const doctorMeta = doctorLookup.get(normalizeId(rawOrder.userId)) || null;
      summaries.push({
        ...summary,
        doctorId: rawOrder.userId,
        doctorName: doctorMeta?.name || 'Doctor',
        doctorEmail: doctorMeta?.email || null,
        doctorProfileImageUrl: doctorMeta?.profileImageUrl || null,
        doctorSalesRepId: doctorMeta?.salesRepId || null,
        doctorSalesRepName: doctorMeta?.salesRepName || null,
        doctorSalesRepEmail: doctorMeta?.salesRepEmail || null,
        source: 'local',
      });
    }
  }

  summaries.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

  const sample = summaries[0] || null;
  logger.info(
    {
      salesRepId: normalizedSalesRepId,
      orders: summaries.length,
      sampleOrderId: sample?.id || sample?.number || null,
      sampleTracking: sample?.trackingNumber || sample?.integrationDetails?.shipStation?.trackingNumber || null,
      sampleShipStationStatus: sample?.integrationDetails?.shipStation?.status || null,
    },
    'Sales rep orders response snapshot',
  );

  return includeDoctors
    ? {
      orders: summaries,
      doctors: Array.from(doctorLookup.values()),
      fetchedAt: new Date().toISOString(),
    }
    : summaries;
};

const getSalesByRep = async ({
  excludeSalesRepId = null,
  excludeDoctorIds = [],
  periodStart = null,
  periodEnd = null,
  timeZone = 'America/Los_Angeles',
} = {}) => {
  const excludeSalesRepIdNormalized = normalizeId(excludeSalesRepId);
  const excludeDoctorSet = new Set(excludeDoctorIds.map(normalizeId).filter(Boolean));
  const users = userRepository.getAll();
  const repsFromUsers = users.filter((u) => normalizeRole(u.role) === 'sales_rep');
  const repsFromStore = Array.isArray(salesRepRepository?.getAll?.())
    ? salesRepRepository.getAll()
    : [];
  const repLookup = new Map();

  // Seed with reps from the sales rep store (used by sales codes / contact forms).
  for (const rep of repsFromStore) {
    const repId = normalizeId(rep?.id || rep?.salesRepId);
    if (!repId) continue;
    const role = normalizeRole(rep?.role);
    if (role && role !== 'sales_rep') continue;
    repLookup.set(repId, {
      id: repId,
      name: rep?.name || rep?.email || 'Sales Rep',
      email: rep?.email || null,
    });
  }

  // Overlay any matching app users (more authoritative for name/email).
  for (const rep of repsFromUsers) {
    const repId = normalizeId(rep?.id);
    if (!repId) continue;
    repLookup.set(repId, {
      id: repId,
      name: rep?.name || rep?.email || 'Sales Rep',
      email: rep?.email || null,
    });
  }
  const doctors = users.filter((u) => {
    const role = (u.role || '').toLowerCase();
    return role === 'doctor' || role === 'test_doctor';
  });

  const doctorToRep = new Map();
  doctors.forEach((doc) => {
    const repId = normalizeId(doc.salesRepId);
    const doctorId = normalizeId(doc.id);
    if (!repId || !doctorId) return;
    if (!repLookup.has(repId)) {
      return;
    }
    doctorToRep.set(doctorId, repId);
  });

  const repTotals = new Map();
  for (const repId of repLookup.keys()) {
    if (excludeSalesRepIdNormalized && repId === excludeSalesRepIdNormalized) {
      // eslint-disable-next-line no-continue
      continue;
    }
    repTotals.set(repId, {
      totalOrders: 0,
      totalRevenue: 0,
      wholesaleRevenue: 0,
      retailRevenue: 0,
    });
  }

  const window = resolvePacificDayWindowUtc({ periodStart, periodEnd, timeZone });
  const shouldFilterByWindow = window.startMs !== null || window.endMs !== null;
  const coerceOrderTimeMs = (order) => {
    const raw = order?.createdAt || order?.created_at || order?.date_created || null;
    if (!raw) return null;
    const parsed = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const doctorIds = doctors.map((d) => d.id);
  const sourceOrders = mysqlClient.isEnabled()
    ? await orderSqlRepository.fetchByUserIds(doctorIds)
    : orderRepository.getAll();

  sourceOrders.forEach((order) => {
    if (shouldFilterByWindow) {
      const createdAtMs = coerceOrderTimeMs(order);
      if (createdAtMs === null) {
        return;
      }
      if (window.startMs !== null && createdAtMs < window.startMs) {
        return;
      }
      if (window.endMs !== null && createdAtMs > window.endMs) {
        return;
      }
    }
    const userId = order.userId || order.user_id || order.id;
    const normalizedUserId = normalizeId(userId);
    if (normalizedUserId && excludeDoctorSet.has(normalizedUserId)) {
      return;
    }
    const repId = doctorToRep.get(normalizedUserId);
    if (!repId) return;
    if (excludeSalesRepIdNormalized && repId === excludeSalesRepIdNormalized) return;
    const current = repTotals.get(repId) || {
      totalOrders: 0,
      totalRevenue: 0,
      wholesaleRevenue: 0,
      retailRevenue: 0,
    };
    current.totalOrders += 1;
    const orderTotal = Number(order.total) || 0;
    current.totalRevenue += orderTotal;
    const pricingMode = String(order.pricingMode || order.pricing_mode || '').trim().toLowerCase() === 'retail'
      ? 'retail'
      : 'wholesale';
    if (pricingMode === 'retail') {
      current.retailRevenue += orderTotal;
    } else {
      current.wholesaleRevenue += orderTotal;
    }
    repTotals.set(repId, current);
  });

  const rows = Array.from(repTotals.entries())
    .map(([repId, totals]) => {
      const rep = repLookup.get(repId) || {};
      return {
        salesRepId: repId,
        salesRepName: rep.name || rep.email || 'Sales Rep',
        salesRepEmail: rep.email || null,
        totalOrders: totals.totalOrders,
        totalRevenue: totals.totalRevenue,
        wholesaleRevenue: totals.wholesaleRevenue || 0,
        retailRevenue: totals.retailRevenue || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  const totals = rows.reduce((acc, row) => {
    acc.totalOrders += Number(row.totalOrders) || 0;
    acc.totalRevenue += Number(row.totalRevenue) || 0;
    acc.wholesaleRevenue += Number(row.wholesaleRevenue) || 0;
    acc.retailRevenue += Number(row.retailRevenue) || 0;
    return acc;
  }, {
    totalOrders: 0,
    totalRevenue: 0,
    wholesaleRevenue: 0,
    retailRevenue: 0,
  });

  return {
    orders: rows,
    periodStart: window.start?.raw || null,
    periodEnd: window.end?.raw || null,
    timeZone: window.timeZone,
    window: {
      startUtc: window.startMs !== null ? new Date(window.startMs).toISOString() : null,
      endUtc: window.endMs !== null ? new Date(window.endMs).toISOString() : null,
    },
    totals,
  };
};

const getWooOrderDetail = async ({ orderId, doctorEmail = null }) => {
  if (!orderId || !wooCommerceClient?.fetchOrderById) {
    return null;
  }
  const numericId = normalizeWooOrderId(orderId) || orderId;
  try {
    const wooOrder = await wooCommerceClient.fetchOrderById(numericId);
    const baseSummary = buildWooOrderSummary(wooOrder);
    const summary = await enrichOrderWithShipStation(baseSummary);
    logger.debug(
      {
        orderId: numericId,
        hasLineItems: Array.isArray(summary?.lineItems) ? summary.lineItems.length : 0,
        hasShippingEstimate: Boolean(summary?.shippingEstimate),
      },
      'Sales rep detail fetched from WooCommerce',
    );
    return summary;
  } catch (error) {
    logger.warn({ err: error, orderId: numericId }, 'WooCommerce detail fetch by ID failed; attempting fallback');
  }

  if (doctorEmail && typeof wooCommerceClient.fetchOrdersByEmail === 'function') {
    try {
      const matches = await wooCommerceClient.fetchOrdersByEmail(doctorEmail, { perPage: 50 });
      const normalizedKey = String(orderId).trim().replace(/^#/, '');
      const candidate = matches.find((entry) => {
        const idMatch = String(entry?.wooOrderId || entry?.id || '').replace(/^#/, '') === normalizedKey;
        const numberMatch = String(entry?.number || entry?.wooOrderNumber || '').replace(/^#/, '') === normalizedKey;
        return idMatch || numberMatch;
      });
      if (candidate) {
        logger.debug(
          {
            orderId,
            doctorEmail,
            hasLineItems: Array.isArray(candidate?.lineItems) ? candidate.lineItems.length : 0,
          },
          'Sales rep detail fetched via Woo email fallback',
        );
        const enrichedCandidate = await enrichOrderWithShipStation(candidate);
        return enrichedCandidate;
      }
    } catch (error) {
      logger.error({ err: error, orderId, doctorEmail }, 'WooCommerce email fallback failed');
    }
  }

  return null;
};

const syncOrderToMySql = async (order) => {
  if (!order) {
    return { status: 'skipped', reason: 'missing_order' };
  }
  const wooOrderNumber = await resolveWooOrderNumber(order);
  const payloadOrder = wooOrderNumber ? { ...order, wooOrderNumber } : order;
  const result = await orderSqlRepository.persistOrder({
    order: payloadOrder,
    wooOrderId: payloadOrder.wooOrderId || null,
    shipStationOrderId: payloadOrder.shipStationOrderId || null,
  });
  logger.info(
    {
      orderId: payloadOrder.id,
      wooOrderId: payloadOrder.wooOrderId || null,
      wooOrderNumber: wooOrderNumber || null,
      userId: payloadOrder.userId || null,
      mysqlStatus: result?.status || null,
    },
    'Order sync to MySQL (Woo linked)',
  );
  return result;
};

const syncOrdersToMySql = async () => {
  if (!env.mysql?.enabled) {
    logger.debug('MySQL disabled; skipping background order sync');
    return;
  }
  const orders = orderRepository.getAll();
  if (!Array.isArray(orders) || orders.length === 0) {
    return;
  }
  logger.debug({ count: orders.length }, 'Starting background order sync to MySQL');
  for (const order of orders) {
    // eslint-disable-next-line no-await-in-loop
    await syncOrderToMySql(order);
  }
};

const startOrderSyncJob = () => {
  if (env.orderSync?.enabled === false) {
    logger.info('Background order sync disabled by ORDER_SYNC_ENABLED=false');
    return;
  }
  if (orderSyncTimer) {
    return;
  }
  const intervalMs = Math.max(env.orderSync?.intervalMs || DEFAULT_ORDER_SYNC_INTERVAL_MS, 60_000);
  const runner = async () => {
    try {
      await syncOrdersToMySql();
    } catch (error) {
      logger.error({ err: error }, 'Background order sync failed');
    }
  };
  runner();
  orderSyncTimer = setInterval(runner, intervalMs);
  logger.info({ intervalMs }, 'Background order sync scheduled');
};

module.exports = {
  createOrder,
  estimateOrderTotals,
  getOrdersForUser,
  getOrdersForSalesRep,
  getSalesByRep,
  cancelOrder,
  startOrderSyncJob,
  syncOrdersToMySql,
  getWooOrderDetail,
};
