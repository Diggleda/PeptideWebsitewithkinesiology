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

module.exports = {
  persistOrder,
};
