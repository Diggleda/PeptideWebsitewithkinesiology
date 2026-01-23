const { logger } = require('../config/logger');
const shipStationClient = require('../integration/shipStationClient');
const wooCommerceClient = require('../integration/wooCommerceClient');
const orderSqlRepository = require('../repositories/orderSqlRepository');
const orderRepository = require('../repositories/orderRepository');

const normalizeToken = (value) => String(value || '').trim().replace(/^#/, '');

const safeLower = (value) => (value ? String(value).trim().toLowerCase() : '');

const parseWooOrderIdFromShipStationOrderKey = (orderKey) => {
  const raw = typeof orderKey === 'string' ? orderKey.trim() : '';
  const match = raw.match(/^woo-(\d+)$/i);
  return match ? Number(match[1]) : null;
};

const pickFirstString = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return null;
};

const findLocalOrderByShipStationOrderId = (shipStationOrderId) => {
  const normalized = pickFirstString(shipStationOrderId);
  if (!normalized) return null;
  const orders = orderRepository.getAll();
  return orders.find((order) => String(order?.shipStationOrderId || '').trim() === normalized) || null;
};

const shouldUpdateWooStatus = (currentWooStatus, nextWooStatus) => {
  const current = safeLower(currentWooStatus);
  const next = safeLower(nextWooStatus);
  if (!next) return false;
  if (current === next) return false;
  if (current === 'cancelled' || current === 'refunded' || current === 'trash') {
    return false;
  }
  return true;
};

const mapShipStationStatusToWooStatus = (shipStationStatus) => {
  const status = safeLower(shipStationStatus);
  if (status === 'shipped') return 'completed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return null;
};

const buildShipmentNote = ({ shipStationStatus, trackingNumber, carrierCode, shipDate }) => {
  const parts = [];
  const status = pickFirstString(shipStationStatus);
  if (status) parts.push(`ShipStation status: ${status}`);
  const tracking = pickFirstString(trackingNumber);
  if (tracking) parts.push(`Tracking: ${tracking}`);
  const carrier = pickFirstString(carrierCode);
  if (carrier) parts.push(`Carrier: ${carrier}`);
  const shippedAt = pickFirstString(shipDate);
  if (shippedAt) parts.push(`Ship date: ${shippedAt}`);
  return parts.join(' • ');
};

const resolveWooOrderId = async ({ orderNumber, shipStationOrderId, shipStationOrderKey }) => {
  const keyDerived = parseWooOrderIdFromShipStationOrderKey(shipStationOrderKey);
  if (keyDerived) {
    return { wooOrderId: keyDerived, source: 'shipstation_order_key' };
  }

  const normalizedShipId = pickFirstString(shipStationOrderId);
  if (normalizedShipId) {
    try {
      const sqlOrder = await orderSqlRepository.fetchByShipStationOrderId(normalizedShipId);
      if (sqlOrder?.wooOrderId) {
        return { wooOrderId: Number(sqlOrder.wooOrderId), source: 'mysql_shipstation_order_id' };
      }
    } catch (error) {
      logger.warn({ err: error, shipStationOrderId: normalizedShipId }, 'MySQL lookup by ShipStation order id failed');
    }
    const local = findLocalOrderByShipStationOrderId(normalizedShipId);
    if (local?.wooOrderId) {
      return { wooOrderId: Number(local.wooOrderId), source: 'local_shipstation_order_id' };
    }
  }

  const normalizedOrderNumber = pickFirstString(orderNumber);
  if (normalizedOrderNumber && /^\d+$/.test(normalizedOrderNumber)) {
    const candidateId = Number(normalizedOrderNumber);
    try {
      const wooOrder = await wooCommerceClient.fetchOrderById(candidateId);
      const matchesNumber = normalizeToken(wooOrder?.number) === normalizeToken(normalizedOrderNumber);
      if (wooOrder?.id && matchesNumber) {
        return { wooOrderId: Number(wooOrder.id), source: 'woo_number_equals_id' };
      }
    } catch (_error) {
      // ignore and fall back
    }
  }

  return { wooOrderId: null, source: 'unresolved' };
};

const syncWooFromShipStation = async ({
  orderNumber,
  shipStationOrderId,
  shipStationStatus,
  trackingNumber,
  carrierCode,
  shipDate,
}) => {
  if (!wooCommerceClient || typeof wooCommerceClient.fetchOrderById !== 'function') {
    throw new Error('WooCommerce client is unavailable');
  }
  if (typeof wooCommerceClient.isConfigured === 'function' && !wooCommerceClient.isConfigured()) {
    const error = new Error('WooCommerce is not configured');
    error.status = 503;
    throw error;
  }

  const normalizedOrderNumber = normalizeToken(orderNumber);

  let latest = null;
  if (shipStationClient.isConfigured() && normalizedOrderNumber) {
    try {
      latest = await shipStationClient.fetchOrderStatus(normalizedOrderNumber);
    } catch (error) {
      logger.warn(
        { err: error, orderNumber: normalizedOrderNumber },
        'ShipStation status fetch failed during sync; falling back to webhook payload',
      );
    }
  }

  const effectiveShipStationStatus = pickFirstString(latest?.status, shipStationStatus);
  const effectiveTrackingNumber = pickFirstString(latest?.trackingNumber, trackingNumber);
  const effectiveCarrierCode = pickFirstString(latest?.carrierCode, carrierCode);
  const effectiveShipDate = pickFirstString(latest?.shipDate, shipDate);
  const effectiveShipStationOrderId = pickFirstString(latest?.orderId, shipStationOrderId);
  const effectiveOrderKey = pickFirstString(latest?.orderKey, null);

  const { wooOrderId, source: wooLookupSource } = await resolveWooOrderId({
    orderNumber: normalizedOrderNumber,
    shipStationOrderId: effectiveShipStationOrderId,
    shipStationOrderKey: effectiveOrderKey,
  });

  if (!wooOrderId) {
    const error = new Error('Unable to resolve WooCommerce order id for ShipStation update');
    error.status = 404;
    error.details = {
      orderNumber: normalizedOrderNumber || null,
      shipStationOrderId: effectiveShipStationOrderId || null,
      shipStationOrderKey: effectiveOrderKey || null,
      wooLookupSource,
    };
    throw error;
  }

  const wooOrder = await wooCommerceClient.fetchOrderById(wooOrderId);
  if (!wooOrder) {
    const error = new Error('WooCommerce order not found');
    error.status = 404;
    error.details = { wooOrderId };
    throw error;
  }
  const currentWooStatus = wooOrder?.status || null;
  const nextWooStatus = mapShipStationStatusToWooStatus(effectiveShipStationStatus);

  const updateResult = await wooCommerceClient.applyShipStationShipmentUpdate({
    wooOrderId,
    currentWooStatus,
    nextWooStatus,
    shipStationStatus: effectiveShipStationStatus,
    trackingNumber: effectiveTrackingNumber,
    carrierCode: effectiveCarrierCode,
    shipDate: effectiveShipDate,
    existingWooMeta: Array.isArray(wooOrder?.meta_data) ? wooOrder.meta_data : [],
  });

  if (updateResult?.changed) {
    const note = buildShipmentNote({
      shipStationStatus: effectiveShipStationStatus,
      trackingNumber: effectiveTrackingNumber,
      carrierCode: effectiveCarrierCode,
      shipDate: effectiveShipDate,
    });
    if (note) {
      try {
        await wooCommerceClient.addOrderNote({ wooOrderId, note, isCustomerNote: false });
      } catch (error) {
        logger.warn({ err: error, wooOrderId }, 'Failed to append WooCommerce ShipStation sync note');
      }
    }
  }

  logger.info(
    {
      wooOrderId,
      wooLookupSource,
      shipStationStatus: effectiveShipStationStatus || null,
      trackingNumber: effectiveTrackingNumber || null,
      carrierCode: effectiveCarrierCode || null,
      shipDate: effectiveShipDate || null,
      currentWooStatus: currentWooStatus || null,
      nextWooStatus: nextWooStatus || null,
      updatedWooStatus: shouldUpdateWooStatus(currentWooStatus, nextWooStatus),
      updateResult: updateResult?.status || null,
    },
    'ShipStation → WooCommerce sync processed',
  );

  return {
    status: 'success',
    wooOrderId,
    wooLookupSource,
    shipStation: {
      status: effectiveShipStationStatus || null,
      trackingNumber: effectiveTrackingNumber || null,
      carrierCode: effectiveCarrierCode || null,
      shipDate: effectiveShipDate || null,
      orderId: effectiveShipStationOrderId || null,
      orderKey: effectiveOrderKey || null,
    },
    woo: {
      previousStatus: currentWooStatus || null,
      nextStatus: nextWooStatus || null,
      updated: updateResult?.status === 'success',
      changed: Boolean(updateResult?.changed),
    },
  };
};

module.exports = {
  syncWooFromShipStation,
  mapShipStationStatusToWooStatus,
};
