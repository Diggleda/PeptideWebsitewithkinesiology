const { logger } = require('../config/logger');
const { env } = require('../config/env');
const shipStationClient = require('../integration/shipStationClient');
const wooCommerceClient = require('../integration/wooCommerceClient');
const orderSqlRepository = require('../repositories/orderSqlRepository');
const orderRepository = require('../repositories/orderRepository');

const normalizeToken = (value) => String(value || '').trim().replace(/^#/, '');

const safeLower = (value) => (value ? String(value).trim().toLowerCase() : '');

const normalizeShipStationStatus = (value) => {
  const raw = safeLower(value);
  if (!raw) return '';
  return raw
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/_+/g, '_');
};

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
  const status = normalizeShipStationStatus(shipStationStatus);
  if (status === 'shipped') return 'completed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'awaiting_shipment') return 'processing';
  if (status === 'awaiting_payment' || status === 'on_hold' || status === 'onhold') return 'on-hold';
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

  if (normalizedOrderNumber && typeof wooCommerceClient.fetchOrderByNumber === 'function') {
    try {
      const wooOrder = await wooCommerceClient.fetchOrderByNumber(normalizedOrderNumber, { perPage: 50, maxPages: 20 });
      if (wooOrder?.id) {
        return { wooOrderId: Number(wooOrder.id), source: 'woo_search_by_number' };
      }
    } catch (error) {
      logger.warn({ err: error, orderNumber: normalizedOrderNumber }, 'WooCommerce lookup by order number failed');
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

let shipStationStatusSyncTimer = null;
let shipStationStatusSyncInFlight = false;

const normalizeWooOrderNumber = (order) => {
  const candidates = [
    order?.number,
    order?.order_number,
    order?.id,
  ];
  for (const candidate of candidates) {
    const normalized = pickFirstString(candidate);
    if (normalized) return normalized;
  }
  return null;
};

const fetchRecentWooOrdersForSync = async ({ lookbackDays = 14, maxOrders = 80 } = {}) => {
  if (typeof wooCommerceClient?.isConfigured === 'function' && !wooCommerceClient.isConfigured()) {
    return [];
  }
  if (typeof wooCommerceClient?.fetchCatalog !== 'function') {
    return [];
  }

  const safeLookbackDays = Math.min(Math.max(Number(lookbackDays) || 14, 1), 90);
  const safeMaxOrders = Math.min(Math.max(Number(maxOrders) || 80, 1), 500);
  const afterIso = new Date(Date.now() - safeLookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const perPage = Math.min(100, safeMaxOrders);
  const maxPages = Math.min(Math.ceil(safeMaxOrders / perPage) + 2, 20);
  const collected = [];

  for (let page = 1; page <= maxPages && collected.length < safeMaxOrders; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await wooCommerceClient.fetchCatalog('orders', {
      per_page: perPage,
      page,
      orderby: 'date',
      order: 'desc',
      status: 'any',
      after: afterIso,
    });
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    collected.push(...batch);
    if (batch.length < perPage) {
      break;
    }
  }

  return collected.slice(0, safeMaxOrders);
};

const runShipStationStatusSyncOnce = async () => {
  if (shipStationStatusSyncInFlight) {
    return { status: 'skipped', reason: 'in_flight' };
  }
  if (env.shipStationSync?.enabled === false) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (!shipStationClient.isConfigured()) {
    return { status: 'skipped', reason: 'shipstation_not_configured' };
  }
  if (typeof wooCommerceClient?.isConfigured === 'function' && !wooCommerceClient.isConfigured()) {
    return { status: 'skipped', reason: 'woocommerce_not_configured' };
  }
  if (typeof wooCommerceClient?.applyShipStationShipmentUpdate !== 'function') {
    return { status: 'skipped', reason: 'woocommerce_sync_unavailable' };
  }

  shipStationStatusSyncInFlight = true;
  const startedAt = Date.now();

  let processed = 0;
  let updated = 0;
  let failed = 0;
  let missing = 0;

  try {
    const lookbackDays = env.shipStationSync?.lookbackDays;
    const maxOrders = env.shipStationSync?.maxOrders;
    const wooOrders = await fetchRecentWooOrdersForSync({ lookbackDays, maxOrders });

    logger.info(
      {
        lookbackDays,
        maxOrders,
        fetchedWooOrders: wooOrders.length,
      },
      'ShipStation status sync: starting',
    );

    for (const wooOrder of wooOrders) {
      const wooOrderId = wooOrder?.id || null;
      const wooOrderNumber = normalizeWooOrderNumber(wooOrder);
      if (!wooOrderNumber || !wooOrderId) {
        // eslint-disable-next-line no-continue
        continue;
      }

      processed += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const ship = await shipStationClient.fetchOrderStatus(wooOrderNumber);
        if (!ship) {
          missing += 1;
          // eslint-disable-next-line no-continue
          continue;
        }

        const nextWooStatus = mapShipStationStatusToWooStatus(ship.status);
        const result = await wooCommerceClient.applyShipStationShipmentUpdate({
          wooOrderId,
          currentWooStatus: wooOrder?.status || null,
          nextWooStatus,
          shipStationStatus: ship.status,
          trackingNumber: ship.trackingNumber,
          carrierCode: ship.carrierCode,
          shipDate: ship.shipDate,
          existingWooMeta: Array.isArray(wooOrder?.meta_data) ? wooOrder.meta_data : [],
        });

        if (result?.changed) {
          updated += 1;
          const note = buildShipmentNote({
            shipStationStatus: ship.status,
            trackingNumber: ship.trackingNumber,
            carrierCode: ship.carrierCode,
            shipDate: ship.shipDate,
          });
          if (note && typeof wooCommerceClient.addOrderNote === 'function') {
            try {
              // eslint-disable-next-line no-await-in-loop
              await wooCommerceClient.addOrderNote({ wooOrderId, note, isCustomerNote: false });
            } catch (error) {
              logger.warn({ err: error, wooOrderId }, 'ShipStation status sync: failed to append order note');
            }
          }
        }
      } catch (error) {
        failed += 1;
        logger.warn(
          {
            err: error,
            wooOrderId,
            wooOrderNumber,
          },
          'ShipStation status sync: order failed',
        );
      }
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      { processed, updated, missing, failed, elapsedMs },
      'ShipStation status sync: finished',
    );

    return { status: 'success', processed, updated, missing, failed, elapsedMs };
  } finally {
    shipStationStatusSyncInFlight = false;
  }
};

const startShipStationStatusSyncJob = () => {
  if (env.shipStationSync?.enabled === false) {
    logger.info('ShipStation status sync disabled by SHIPSTATION_STATUS_SYNC_ENABLED=false');
    return;
  }
  if (shipStationStatusSyncTimer) {
    return;
  }
  const intervalMs = Math.max(Number(env.shipStationSync?.intervalMs) || (5 * 60 * 1000), 60_000);
  const runner = async () => {
    try {
      await runShipStationStatusSyncOnce();
    } catch (error) {
      logger.error({ err: error }, 'ShipStation status sync job failed');
    }
  };
  runner();
  shipStationStatusSyncTimer = setInterval(runner, intervalMs);
  logger.info({ intervalMs }, 'ShipStation status sync scheduled');
};

module.exports = {
  syncWooFromShipStation,
  mapShipStationStatusToWooStatus,
  startShipStationStatusSyncJob,
};
