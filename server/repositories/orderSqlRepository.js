const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const sanitizeString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundCurrency = (value) => Math.max(0, Math.round((toNumber(value, 0) + 1e-9) * 100) / 100);
const HAND_DELIVERY_SERVICE_LABEL = 'Hand Delivered';

const toIsoDateTime = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const resolveOrderPlacedAt = (order, createdAtFallback) => {
  if (!order || typeof order !== 'object') {
    return toIsoDateTime(createdAtFallback);
  }
  const candidates = [
    order.orderPlacedAt,
    order.order_placed_at,
    order.placedAt,
    order.placed_at,
    order.createdAt,
    order.created_at,
    createdAtFallback,
  ];
  for (const candidate of candidates) {
    const parsed = toIsoDateTime(candidate);
    if (parsed) return parsed;
  }
  return null;
};

const resolveShippedAt = (order) => {
  if (!order || typeof order !== 'object') return null;

  const explicitCandidates = [
    order.shippedAt,
    order.shipped_at,
    order.shippingEstimate?.shipDate,
    order.shippingEstimate?.shippedAt,
    order.integrationDetails?.shipStation?.shipDate,
    order.integrationDetails?.shipStation?.shippedAt,
    order.integrations?.shipStation?.shipDate,
    order.integrations?.shipStation?.shippedAt,
    order.integrations?.shipstation?.shipDate,
    order.integrations?.shipstation?.shippedAt,
  ];
  for (const candidate of explicitCandidates) {
    const parsed = toIsoDateTime(candidate);
    if (parsed) return parsed;
  }

  return null;
};

const isHandDeliveryOrder = (order) => {
  if (!order || typeof order !== 'object') {
    return false;
  }
  const estimate = order.shippingEstimate;
  const estimateCandidates = estimate && typeof estimate === 'object'
    ? [estimate.serviceType, estimate.serviceCode, estimate.carrierId]
    : [];
  const orderCandidates = [
    order.shippingService,
    order.fulfillmentMethod,
    order.fulfillment_method,
    order.handDelivery === true ? 'hand_delivery' : '',
  ];
  const normalized = estimateCandidates
    .concat(orderCandidates)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return normalized.some((value) =>
    value === 'hand delivery'
    || value === 'hand delivered'
    || value === 'hand_delivery'
    || value === 'local hand delivery'
    || value === 'local_hand_delivery'
    || value === 'local_delivery'
    || value === 'hand-delivery'
    || value === 'hand-delivered'
    || value === 'facility_pickup');
};

const computeItemsSubtotal = (order) => {
  if (!order || typeof order !== 'object') {
    return 0;
  }
  const itemsSubtotal = toNumber(
    order.itemsSubtotal ?? order.items_subtotal ?? order.itemsTotal ?? order.items_total,
    NaN,
  );
  if (Number.isFinite(itemsSubtotal)) {
    return roundCurrency(itemsSubtotal);
  }
  const total = toNumber(order.total, NaN);
  const shippingTotal = toNumber(order.shippingTotal ?? order.shipping_total, 0);
  const taxTotal = toNumber(order.taxTotal ?? order.totalTax ?? order.total_tax, 0);
  if (Number.isFinite(total)) {
    return roundCurrency(total - shippingTotal - taxTotal);
  }
  return 0;
};

const computeGrandTotal = (order) => {
  if (!order || typeof order !== 'object') {
    return 0;
  }

  const grandTotal = toNumber(order.grandTotal, NaN);
  if (Number.isFinite(grandTotal)) {
    return roundCurrency(grandTotal);
  }

  const itemsSubtotal = toNumber(
    order.itemsSubtotal ?? order.items_subtotal ?? order.itemsTotal ?? order.items_total,
    NaN,
  );
  const shippingTotal = toNumber(order.shippingTotal ?? order.shipping_total, 0);
  const taxTotal = toNumber(order.taxTotal ?? order.totalTax ?? order.total_tax, 0);
  const discountTotal = toNumber(
    order.appliedReferralCredit ?? order.discountTotal ?? order.discount_total ?? order.totalDiscount,
    0,
  );

  if (Number.isFinite(itemsSubtotal)) {
    return roundCurrency(itemsSubtotal - discountTotal + shippingTotal + taxTotal);
  }

  // If we don't have a reliable subtotal, fall back to whatever the upstream total is.
  return roundCurrency(order.total ?? order.total_ex_tax ?? 0);
};

const persistOrder = async ({ order, wooOrderId, shipStationOrderId }) => {
  if (!mysqlClient.isEnabled()) {
    return {
      status: 'skipped',
      reason: 'mysql_disabled',
    };
  }

  const normalizePricingMode = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'retail') return 'retail';
    return 'wholesale';
  };

  const appendPstSuffix = (value) => {
    const trimmed = sanitizeString(value);
    if (!trimmed) return null;
    return /\bPST$/i.test(trimmed) ? trimmed : `${trimmed} PST`;
  };

  const createdAtRaw = sanitizeString(order.createdAt) || new Date().toISOString();
  const createdAtRawWithPst = appendPstSuffix(createdAtRaw);
  const orderPlacedAt = resolveOrderPlacedAt(order, createdAtRaw);
  const shippedAt = resolveShippedAt(order);

  const payload = {
    id: sanitizeString(order.id),
    userId: sanitizeString(order.userId),
    pricingMode: normalizePricingMode(order.pricingMode),
    wooOrderId: wooOrderId || null,
    shipStationOrderId: shipStationOrderId || null,
    itemsSubtotal: computeItemsSubtotal(order),
    total: computeGrandTotal(order),
    shippingTotal: toNumber(order.shippingTotal ?? order.shipping_total, 0),
    shippingCarrier: order.shippingEstimate?.carrierId || order.shippingEstimate?.serviceCode || null,
    shippingService: isHandDeliveryOrder(order)
      ? HAND_DELIVERY_SERVICE_LABEL
      : (order.shippingEstimate?.serviceType || order.shippingEstimate?.serviceCode || order.shippingService || null),
    handDelivery: order.handDelivery === true ? 1 : 0,
    fulfillmentMethod: sanitizeString(order.fulfillmentMethod || null),
    pickupLocation: sanitizeString(order.pickupLocation || null),
    pickupReadyNotice: sanitizeString(order.pickupReadyNotice || null),
    physicianCertified: order.physicianCertificationAccepted === true ? 1 : 0,
    status: order.status || 'pending',
    orderPlacedAt,
    shippedAt,
    paymentDetails: sanitizeString(order.paymentDetails || order.paymentMethod || null),
    payload: JSON.stringify({
      order: {
        ...(order && typeof order === 'object' ? order : {}),
        total: computeGrandTotal(order),
        grandTotal: computeGrandTotal(order),
        orderPlacedAt,
        order_placed_at: orderPlacedAt,
        shippedAt,
        shipped_at: shippedAt,
        createdAt: createdAtRawWithPst || createdAtRaw,
        created_at: createdAtRawWithPst || createdAtRaw,
      },
      orders: {
        created_at: createdAtRawWithPst || createdAtRaw,
      },
      integrations: order.integrationDetails,
    }),
    createdAt: createdAtRaw,
    updatedAt: new Date().toISOString(),
  };

  try {
    await mysqlClient.execute(
      `
        INSERT INTO peppro_orders (
          id,
          user_id,
          pricing_mode,
          woo_order_id,
          shipstation_order_id,
          items_subtotal,
          total,
          shipping_total,
          shipping_carrier,
          shipping_service,
          facility_pickup,
          fulfillment_method,
          pickup_location,
          pickup_ready_notice,
          physician_certified,
          status,
          order_placed_at,
          shipped_at,
          \`Payment Details\`,
          payload,
          created_at,
          updated_at
        ) VALUES (
          :id,
          :userId,
          :pricingMode,
          :wooOrderId,
          :shipStationOrderId,
          :itemsSubtotal,
          :total,
          :shippingTotal,
          :shippingCarrier,
          :shippingService,
          :handDelivery,
          :fulfillmentMethod,
          :pickupLocation,
          :pickupReadyNotice,
          :physicianCertified,
          :status,
          :orderPlacedAt,
          :shippedAt,
          :paymentDetails,
          :payload,
          :createdAt,
          :updatedAt
        )
        ON DUPLICATE KEY UPDATE
          woo_order_id = VALUES(woo_order_id),
          shipstation_order_id = VALUES(shipstation_order_id),
          items_subtotal = VALUES(items_subtotal),
          total = VALUES(total),
          shipping_total = VALUES(shipping_total),
          shipping_carrier = VALUES(shipping_carrier),
          shipping_service = VALUES(shipping_service),
          facility_pickup = VALUES(facility_pickup),
          fulfillment_method = VALUES(fulfillment_method),
          pickup_location = VALUES(pickup_location),
          pickup_ready_notice = VALUES(pickup_ready_notice),
          physician_certified = VALUES(physician_certified),
          status = VALUES(status),
          order_placed_at = COALESCE(order_placed_at, VALUES(order_placed_at)),
          shipped_at = COALESCE(shipped_at, VALUES(shipped_at)),
          \`Payment Details\` = VALUES(\`Payment Details\`),
          payload = VALUES(payload),
          pricing_mode = VALUES(pricing_mode),
          updated_at = VALUES(updated_at)
      `,
      payload,
    );

    return {
      status: 'success',
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to persist order to MySQL');
    return {
      status: 'error',
      message: error.message,
    };
  }
};

const mapRowToOrder = (row, options = {}) => {
  if (!row) return null;
  const parseJson = (value, fallback = null) => {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  };

  const payload = parseJson(row.payload, {});
  // Node backend stores payload as `{ order: {...}, integrations: ... }`, while the Python backend
  // stores the order dict directly as the payload. Tolerate both.
  const payloadOrder = (() => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (payload.order && typeof payload.order === 'object' && !Array.isArray(payload.order)) {
        return payload.order;
      }
      return payload;
    }
    return {};
  })();

  const coalesce = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  };

  const toIso = (value) => {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };

  const computedItemsSubtotal = (() => {
    const rowSubtotal = toNumber(row.items_subtotal, NaN);
    if (Number.isFinite(rowSubtotal) && rowSubtotal > 0) {
      return roundCurrency(rowSubtotal);
    }
    const payloadSubtotal = computeItemsSubtotal(payloadOrder);
    return payloadSubtotal > 0 ? payloadSubtotal : null;
  })();

  const normalized = {
    ...payloadOrder,
    id: sanitizeString(coalesce(payloadOrder.id, row.id)),
    userId: sanitizeString(coalesce(payloadOrder.userId, row.user_id)),
    pricingMode: sanitizeString(coalesce(payloadOrder.pricingMode, row.pricing_mode)) || 'wholesale',
    asDelegate: sanitizeString(coalesce(payloadOrder.asDelegate, payloadOrder.as_delegate, row.as_delegate)),
    as_delegate: sanitizeString(coalesce(payloadOrder.as_delegate, payloadOrder.asDelegate, row.as_delegate)),
    wooOrderId: sanitizeString(coalesce(payloadOrder.wooOrderId, row.woo_order_id)),
    wooOrderNumber: sanitizeString(coalesce(
      payloadOrder.wooOrderNumber,
      payload?.integrations?.wooCommerce?.response?.number,
      payloadOrder.wooOrderId,
      row.woo_order_id,
    )),
    shipStationOrderId: sanitizeString(coalesce(payloadOrder.shipStationOrderId, row.shipstation_order_id)),
    total: (() => {
      const rowTotal = toNumber(row.total, NaN);
      if (Number.isFinite(rowTotal) && rowTotal > 0) {
        return roundCurrency(rowTotal);
      }
      const payloadGrand = computeGrandTotal(payloadOrder);
      return payloadGrand > 0 ? payloadGrand : roundCurrency(payloadOrder.total ?? 0);
    })(),
    itemsSubtotal: computedItemsSubtotal,
    shippingTotal: (() => {
      const rowShipping = toNumber(row.shipping_total, NaN);
      if (Number.isFinite(rowShipping) && rowShipping > 0) {
        return roundCurrency(rowShipping);
      }
      return roundCurrency(payloadOrder.shippingTotal ?? payloadOrder.shipping_total ?? 0);
    })(),
    shippingCarrier: sanitizeString(coalesce(payloadOrder.shippingCarrier, row.shipping_carrier)),
    shippingService: sanitizeString(coalesce(payloadOrder.shippingService, row.shipping_service)),
    physicianCertificationAccepted: typeof payloadOrder.physicianCertificationAccepted === 'boolean'
      ? payloadOrder.physicianCertificationAccepted
      : Boolean(row.physician_certified),
    handDelivery: typeof payloadOrder.handDelivery === 'boolean'
      ? payloadOrder.handDelivery
      : Boolean(row.facility_pickup),
    fulfillmentMethod: sanitizeString(payloadOrder.fulfillmentMethod)
      || sanitizeString(row.fulfillment_method)
      || (Boolean(
        typeof payloadOrder.handDelivery === 'boolean'
          ? payloadOrder.handDelivery
          : row.facility_pickup,
      ) ? 'facility_pickup' : 'shipping'),
    pickupLocation: sanitizeString(payloadOrder.pickupLocation)
      || sanitizeString(row.pickup_location),
    pickupReadyNotice: sanitizeString(payloadOrder.pickupReadyNotice)
      || sanitizeString(row.pickup_ready_notice),
    status: payloadOrder.status || row.status || 'pending',
    orderPlacedAt: toIso(
      payloadOrder.orderPlacedAt
      || payloadOrder.order_placed_at
      || row.order_placed_at
      || payloadOrder.createdAt
      || payloadOrder.created_at
      || row.created_at,
    ),
    shippedAt: toIso(
      payloadOrder.shippedAt
      || payloadOrder.shipped_at
      || payloadOrder.shippingEstimate?.shipDate
      || payloadOrder.shippingEstimate?.shippedAt
      || payload?.integrations?.shipStation?.shipDate
      || payload?.integrations?.shipStation?.shippedAt
      || row.shipped_at,
    ),
    createdAt: toIso(payloadOrder.createdAt || payloadOrder.created_at || row.created_at || row.updated_at || payloadOrder.updatedAt || payloadOrder.updated_at),
    updatedAt: toIso(payloadOrder.updatedAt || payloadOrder.updated_at || row.updated_at || row.created_at || payloadOrder.createdAt || payloadOrder.created_at),
    integrationDetails: payloadOrder.integrationDetails
      || payloadOrder.integrations
      || payload.integrations
      || null,
    integrations: payloadOrder.integrations
      || payload.integrations
      || null,
    items: Array.isArray(payloadOrder.items) ? payloadOrder.items : [],
    shippingEstimate: payloadOrder.shippingEstimate || null,
    shippingAddress: payloadOrder.shippingAddress
      || payloadOrder.shipping_address
      || null,
    billingAddress: payloadOrder.billingAddress
      || payloadOrder.billing_address
      || null,
    paymentMethod: payloadOrder.paymentMethod
      || sanitizeString(row['Payment Details'])
      || null,
    paymentDetails: payloadOrder.paymentDetails
      || sanitizeString(row['Payment Details'])
      || payloadOrder.paymentMethod
      || null,
    referrerBonus: payloadOrder.referrerBonus || null,
    referralCode: payloadOrder.referralCode || null,
    taxTotal: payloadOrder.taxTotal ?? payloadOrder.tax_total ?? payloadOrder.totalTax ?? payloadOrder.total_tax ?? null,
    payload,
    source: options?.source || 'mysql',
  };

  return normalized;
};

const safeFetchAll = async (query, params = {}) => {
  try {
    return await mysqlClient.fetchAll(query, params);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ER_NO_SUCH_TABLE') {
      return [];
    }
    throw error;
  }
};

const safeFetchOne = async (query, params) => {
  try {
    return await mysqlClient.fetchOne(query, params);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }
};

const dedupeOrders = (orders) => {
  const byId = new Map();
  (orders || []).forEach((order) => {
    const id = sanitizeString(order?.id);
    if (!id) return;
    if (!byId.has(id)) {
      byId.set(id, order);
      return;
    }
    const existing = byId.get(id);
    const existingUpdated = Date.parse(String(existing?.updatedAt || '')) || 0;
    const nextUpdated = Date.parse(String(order?.updatedAt || '')) || 0;
    if (nextUpdated >= existingUpdated) {
      byId.set(id, order);
    }
  });
  return Array.from(byId.values());
};

const fetchAll = async () => {
  if (!mysqlClient.isEnabled()) return [];
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll('SELECT * FROM peppro_orders'),
    safeFetchAll('SELECT * FROM orders'),
  ]);
  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);
  return dedupeOrders(orders);
};

const fetchById = async (orderId) => {
  if (!mysqlClient.isEnabled() || !orderId) {
    return null;
  }
  const [pepproRow, legacyRow] = await Promise.all([
    safeFetchOne('SELECT * FROM peppro_orders WHERE id = :id LIMIT 1', { id: orderId }),
    safeFetchOne('SELECT * FROM orders WHERE id = :id LIMIT 1', { id: orderId }),
  ]);
  const candidates = [];
  if (pepproRow) candidates.push(mapRowToOrder(pepproRow, { source: 'mysql:peppro_orders' }));
  if (legacyRow) candidates.push(mapRowToOrder(legacyRow, { source: 'mysql:orders' }));
  return dedupeOrders(candidates)[0] || null;
};

const fetchByShipStationOrderId = async (shipStationOrderId) => {
  if (!mysqlClient.isEnabled() || !shipStationOrderId) {
    return null;
  }
  const row = await mysqlClient.fetchOne(
    'SELECT * FROM peppro_orders WHERE shipstation_order_id = :shipStationOrderId LIMIT 1',
    { shipStationOrderId: String(shipStationOrderId) },
  );
  return mapRowToOrder(row);
};

const fetchByWooOrderId = async (wooOrderId) => {
  if (!mysqlClient.isEnabled() || !wooOrderId) {
    return null;
  }
  const value = String(wooOrderId).trim();
  if (!value) return null;

  const safeFetchOneCompat = async (query, params) => {
    try {
      return await mysqlClient.fetchOne(query, params);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
        return null;
      }
      throw error;
    }
  };

  const [pepproRow, legacyRow] = await Promise.all([
    safeFetchOneCompat('SELECT * FROM peppro_orders WHERE woo_order_id = :wooOrderId LIMIT 1', { wooOrderId: value }),
    safeFetchOneCompat('SELECT * FROM orders WHERE woo_order_id = :wooOrderId LIMIT 1', { wooOrderId: value }),
  ]);

  const candidates = [];
  if (pepproRow) candidates.push(mapRowToOrder(pepproRow, { source: 'mysql:peppro_orders' }));
  if (legacyRow) candidates.push(mapRowToOrder(legacyRow, { source: 'mysql:orders' }));
  return dedupeOrders(candidates)[0] || null;
};

const fetchByWooOrderNumber = async (wooOrderNumber) => {
  if (!mysqlClient.isEnabled() || !wooOrderNumber) {
    return null;
  }
  const value = String(wooOrderNumber).trim();
  if (!value) return null;

  const safeFetchOneCompat = async (query, params) => {
    try {
      return await mysqlClient.fetchOne(query, params);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
        return null;
      }
      throw error;
    }
  };

  const jsonMatchPepPro = `
    SELECT *
    FROM peppro_orders
    WHERE JSON_VALID(payload)
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.order.wooOrderNumber')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.order.woo_order_number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.wooCommerce.response.number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.wooCommerce.wooOrderNumber')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.woocommerce.response.number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.woocommerce.wooOrderNumber')) = :value
      )
    LIMIT 1
  `;

  const jsonMatchLegacy = `
    SELECT *
    FROM orders
    WHERE JSON_VALID(payload)
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.order.wooOrderNumber')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.order.woo_order_number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.wooCommerce.response.number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.wooCommerce.wooOrderNumber')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.woocommerce.response.number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.integrations.woocommerce.wooOrderNumber')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.wooOrderNumber')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.woo_order_number')) = :value
        OR JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.number')) = :value
      )
    LIMIT 1
  `;

  const [pepproRow, legacyRow] = await Promise.all([
    safeFetchOneCompat(jsonMatchPepPro, { value }),
    safeFetchOneCompat(jsonMatchLegacy, { value }),
  ]);

  const candidates = [];
  if (pepproRow) candidates.push(mapRowToOrder(pepproRow, { source: 'mysql:peppro_orders' }));
  if (legacyRow) candidates.push(mapRowToOrder(legacyRow, { source: 'mysql:orders' }));
  return dedupeOrders(candidates)[0] || null;
};

const fetchByUserIds = async (userIds = []) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const placeholders = userIds.map((_, idx) => `:id${idx}`).join(', ');
  const params = userIds.reduce((acc, id, idx) => ({ ...acc, [`id${idx}`]: id }), {});
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll(`SELECT * FROM peppro_orders WHERE user_id IN (${placeholders})`, params),
    safeFetchAll(`SELECT * FROM orders WHERE user_id IN (${placeholders})`, params),
  ]);
  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);
  return dedupeOrders(orders);
};

const fetchByBillingEmails = async (emails = []) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(emails) || emails.length === 0) return [];
  const normalized = Array.from(
    new Set(
      emails
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (normalized.length === 0) return [];
  const placeholders = normalized.map((_, idx) => `:email${idx}`).join(', ');
  const params = normalized.reduce((acc, email, idx) => ({ ...acc, [`email${idx}`]: email }), {});
  const pepproRows = await safeFetchAll(
    `
      SELECT *
      FROM peppro_orders
      WHERE JSON_VALID(payload)
        AND (
          LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billing.email')
            )
          ) IN (${placeholders})
          OR LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billing_email')
            )
          ) IN (${placeholders})
          OR LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billingEmail')
            )
          ) IN (${placeholders})
          OR LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billingAddress.email')
            )
          ) IN (${placeholders})
          OR LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billing_address.email')
            )
          ) IN (${placeholders})
          OR LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billingAddress.emailAddress')
            )
          ) IN (${placeholders})
          OR LOWER(
            JSON_UNQUOTE(
              JSON_EXTRACT(CAST(payload AS JSON), '$.order.billing_address.email_address')
            )
          ) IN (${placeholders})
        )
    `,
    params,
  );

  const legacyRows = await safeFetchAll(
    `
      SELECT *
      FROM orders
      WHERE JSON_VALID(payload)
        AND (
          LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billing.email'))) IN (${placeholders})
          OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billing_email'))) IN (${placeholders})
          OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billingEmail'))) IN (${placeholders})
          OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billingAddress.email'))) IN (${placeholders})
          OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billing_address.email'))) IN (${placeholders})
          OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billingAddress.emailAddress'))) IN (${placeholders})
          OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(CAST(payload AS JSON), '$.billing_address.email_address'))) IN (${placeholders})
        )
    `,
    params,
  );

  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);

  return dedupeOrders(orders);
};

const fetchByUserId = async (userId) => {
  if (!mysqlClient.isEnabled() || !userId) return [];
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll('SELECT * FROM peppro_orders WHERE user_id = :userId ORDER BY created_at DESC', { userId }),
    safeFetchAll('SELECT * FROM orders WHERE user_id = :userId ORDER BY created_at DESC', { userId }),
  ]);
  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);
  return dedupeOrders(orders).sort((a, b) => (Date.parse(String(b.createdAt || '')) || 0) - (Date.parse(String(a.createdAt || '')) || 0));
};

const fetchByStatuses = async (statuses = [], options = {}) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(statuses) || statuses.length === 0) return [];

  const normalizedStatuses = Array.from(
    new Set(
      statuses
        .map((value) => (value == null ? '' : String(value).trim().toLowerCase()))
        .filter(Boolean),
    ),
  );
  if (normalizedStatuses.length === 0) return [];

  const placeholders = normalizedStatuses.map((_, idx) => `:status${idx}`).join(', ');
  const params = normalizedStatuses.reduce(
    (acc, status, idx) => ({ ...acc, [`status${idx}`]: status }),
    {},
  );

  const limitRaw = Number(options?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000)
    : 500;

  const statusExpr = "LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-'))";
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll(
      `
        SELECT *
        FROM peppro_orders
        WHERE COALESCE(status_normalized, '') IN (${placeholders})
        ORDER BY COALESCE(created_at, updated_at) DESC
        LIMIT ${limit}
      `,
      params,
    ),
    safeFetchAll(
      `
        SELECT *
        FROM orders
        WHERE ${statusExpr} IN (${placeholders})
        ORDER BY COALESCE(created_at, updated_at) DESC
        LIMIT ${limit}
      `,
      params,
    ),
  ]);

  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);

  return dedupeOrders(orders).sort(
    (a, b) =>
      (Date.parse(String(b.createdAt || b.updatedAt || '')) || 0)
      - (Date.parse(String(a.createdAt || a.updatedAt || '')) || 0),
  );
};

module.exports = {
  persistOrder,
  fetchAll,
  fetchByUserId,
  fetchByUserIds,
  fetchByBillingEmails,
  fetchById,
  fetchByWooOrderId,
  fetchByWooOrderNumber,
  fetchByShipStationOrderId,
  fetchByStatuses,
};
