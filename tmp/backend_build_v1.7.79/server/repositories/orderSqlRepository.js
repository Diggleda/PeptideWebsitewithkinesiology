const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const sanitizeString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const persistOrder = async ({ order, wooOrderId, shipStationOrderId }) => {
  if (!mysqlClient.isEnabled()) {
    return {
      status: 'skipped',
      reason: 'mysql_disabled',
    };
  }

  const payload = {
    id: sanitizeString(order.id),
    userId: sanitizeString(order.userId),
    wooOrderId: wooOrderId || null,
    shipStationOrderId: shipStationOrderId || null,
    total: Number(order.total) || 0,
    shippingTotal: Number(order.shippingTotal) || 0,
    shippingCarrier: order.shippingEstimate?.carrierId || order.shippingEstimate?.serviceCode || null,
    shippingService: order.shippingEstimate?.serviceType || order.shippingEstimate?.serviceCode || null,
    physicianCertified: order.physicianCertificationAccepted === true ? 1 : 0,
    status: order.status || 'pending',
    paymentDetails: sanitizeString(order.paymentDetails || order.paymentMethod || null),
    payload: JSON.stringify({
      order,
      integrations: order.integrationDetails,
    }),
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await mysqlClient.execute(
      `
        INSERT INTO peppro_orders (
          id,
          user_id,
          woo_order_id,
          shipstation_order_id,
          total,
          shipping_total,
          shipping_carrier,
          shipping_service,
          physician_certified,
          status,
          \`Payment Details\`,
          payload,
          created_at,
          updated_at
        ) VALUES (
          :id,
          :userId,
          :wooOrderId,
          :shipStationOrderId,
          :total,
          :shippingTotal,
          :shippingCarrier,
          :shippingService,
          :physicianCertified,
          :status,
          :paymentDetails,
          :payload,
          :createdAt,
          :updatedAt
        )
        ON DUPLICATE KEY UPDATE
          woo_order_id = VALUES(woo_order_id),
          shipstation_order_id = VALUES(shipstation_order_id),
          total = VALUES(total),
          shipping_total = VALUES(shipping_total),
          shipping_carrier = VALUES(shipping_carrier),
          shipping_service = VALUES(shipping_service),
          physician_certified = VALUES(physician_certified),
          status = VALUES(status),
          \`Payment Details\` = VALUES(\`Payment Details\`),
          payload = VALUES(payload),
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

const mapRowToOrder = (row) => {
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
  const payloadOrder = (payload && typeof payload.order === 'object')
    ? payload.order
    : {};

  const coalesce = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  };

  const normalized = {
    ...payloadOrder,
    id: sanitizeString(coalesce(payloadOrder.id, row.id)),
    userId: sanitizeString(coalesce(payloadOrder.userId, row.user_id)),
    wooOrderId: sanitizeString(coalesce(payloadOrder.wooOrderId, row.woo_order_id)),
    shipStationOrderId: sanitizeString(coalesce(payloadOrder.shipStationOrderId, row.shipstation_order_id)),
    total: Number(coalesce(payloadOrder.total, row.total)) || 0,
    shippingTotal: Number(coalesce(payloadOrder.shippingTotal, row.shipping_total)) || 0,
    shippingCarrier: sanitizeString(coalesce(payloadOrder.shippingCarrier, row.shipping_carrier)),
    shippingService: sanitizeString(coalesce(payloadOrder.shippingService, row.shipping_service)),
    physicianCertificationAccepted: typeof payloadOrder.physicianCertificationAccepted === 'boolean'
      ? payloadOrder.physicianCertificationAccepted
      : Boolean(row.physician_certified),
    status: payloadOrder.status || row.status || 'pending',
    createdAt: payloadOrder.createdAt
      || (row.created_at ? new Date(row.created_at).toISOString() : null),
    updatedAt: payloadOrder.updatedAt
      || (row.updated_at ? new Date(row.updated_at).toISOString() : null),
    integrationDetails: payloadOrder.integrationDetails
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
    taxTotal: payloadOrder.taxTotal ?? null,
    itemsSubtotal: payloadOrder.itemsSubtotal ?? null,
    payload,
    source: 'mysql',
  };

  return normalized;
};

const fetchAll = async () => {
  if (!mysqlClient.isEnabled()) return [];
  const rows = await mysqlClient.fetchAll('SELECT * FROM peppro_orders');
  return Array.isArray(rows) ? rows.map(mapRowToOrder).filter(Boolean) : [];
};

const fetchById = async (orderId) => {
  if (!mysqlClient.isEnabled() || !orderId) {
    return null;
  }
  const row = await mysqlClient.fetchOne(
    'SELECT * FROM peppro_orders WHERE id = :id LIMIT 1',
    { id: orderId },
  );
  return mapRowToOrder(row);
};

const fetchByUserIds = async (userIds = []) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const placeholders = userIds.map((_, idx) => `:id${idx}`).join(', ');
  const params = userIds.reduce((acc, id, idx) => ({ ...acc, [`id${idx}`]: id }), {});
  const rows = await mysqlClient.fetchAll(
    `SELECT * FROM peppro_orders WHERE user_id IN (${placeholders})`,
    params,
  );
  return Array.isArray(rows) ? rows.map(mapRowToOrder).filter(Boolean) : [];
};

const fetchByUserId = async (userId) => {
  if (!mysqlClient.isEnabled() || !userId) return [];
  const rows = await mysqlClient.fetchAll(
    'SELECT * FROM peppro_orders WHERE user_id = :userId ORDER BY created_at DESC',
    { userId },
  );
  return Array.isArray(rows) ? rows.map(mapRowToOrder).filter(Boolean) : [];
};

module.exports = {
  persistOrder,
  fetchAll,
  fetchByUserId,
  fetchByUserIds,
  fetchById,
};
