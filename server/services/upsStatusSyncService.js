const { env } = require('../config/env');
const { logger } = require('../config/logger');
const mysqlClient = require('../database/mysqlClient');
const orderSqlRepository = require('../repositories/orderSqlRepository');
const {
  fetchUpsTrackingStatus,
  isConfigured: isUpsConfigured,
  looksLikeUpsTrackingNumber,
  normalizeTrackingStatus,
} = require('./upsTrackingService');

let upsStatusSyncTimer = null;
let upsStatusSyncInFlight = false;

const upsStatusSyncState = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastResult: null,
  lastError: null,
};

const safeLower = (value) => String(value || '').trim().toLowerCase();

const isHandDeliveryOrder = (order) => {
  if (!order || typeof order !== 'object') {
    return false;
  }
  if (order.handDelivery === true) {
    return true;
  }
  const shippingEstimate = order.shippingEstimate && typeof order.shippingEstimate === 'object'
    ? order.shippingEstimate
    : {};
  const candidates = [
    order.shippingService,
    order.fulfillmentMethod,
    order.fulfillment_method,
    shippingEstimate.serviceType,
    shippingEstimate.serviceCode,
    shippingEstimate.carrierId,
  ];
  const normalized = new Set(candidates.map((value) => safeLower(value)).filter(Boolean));
  return [
    'hand delivery',
    'hand delivered',
    'hand_delivery',
    'hand_delivered',
    'hand-delivery',
    'hand-delivered',
    'local hand delivery',
    'local_hand_delivery',
    'local_delivery',
    'facility_pickup',
    'fascility_pickup',
  ].some((value) => normalized.has(value));
};

const isTerminalLocalStatus = (value) => ['cancelled', 'canceled', 'trash', 'refunded', 'failed'].includes(safeLower(value));

const isUpsOrder = (order) => {
  if (!order || typeof order !== 'object') {
    return false;
  }
  if (looksLikeUpsTrackingNumber(order.trackingNumber || order.tracking_number)) {
    return true;
  }
  const shippingEstimate = order.shippingEstimate && typeof order.shippingEstimate === 'object'
    ? order.shippingEstimate
    : {};
  const integrationDetails = order.integrationDetails && typeof order.integrationDetails === 'object'
    ? order.integrationDetails
    : {};
  const shipStation = integrationDetails.shipStation && typeof integrationDetails.shipStation === 'object'
    ? integrationDetails.shipStation
    : {};
  const candidates = [
    order.shippingCarrier,
    order.shipping_carrier,
    shippingEstimate.carrierId,
    shippingEstimate.carrier_id,
    shipStation.carrierCode,
    shipStation.carrier_code,
  ];
  return candidates.some((value) => {
    const token = safeLower(value).replace(/[\s-]+/g, '_');
    return token === 'ups' || token.startsWith('ups_');
  });
};

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const fetchOrdersForSync = async ({ lookbackDays, maxOrders }) => {
  if (typeof orderSqlRepository.fetchRecentForUpsSync !== 'function') {
    return [];
  }
  const scanLimit = Math.max(maxOrders * 5, 100);
  const recentOrders = await orderSqlRepository.fetchRecentForUpsSync({
    lookbackDays,
    limit: scanLimit,
  });
  return (Array.isArray(recentOrders) ? recentOrders : [])
    .filter((order) => {
      if (!order?.id) return false;
      if (!order.trackingNumber) return false;
      if (isHandDeliveryOrder(order)) return false;
      if (isTerminalLocalStatus(order.status)) return false;
      if (safeLower(order.upsTrackingStatus) === 'delivered') return false;
      return isUpsOrder(order);
    })
    .slice(0, maxOrders);
};

const runUpsStatusSyncOnce = async () => {
  if (upsStatusSyncInFlight) {
    const result = { status: 'skipped', reason: 'in_flight' };
    upsStatusSyncState.lastResult = result;
    return result;
  }
  if (env.upsSync?.enabled === false) {
    const result = { status: 'skipped', reason: 'disabled' };
    upsStatusSyncState.lastResult = result;
    return result;
  }
  if (!mysqlClient.isEnabled()) {
    const result = { status: 'skipped', reason: 'mysql_disabled' };
    upsStatusSyncState.lastResult = result;
    return result;
  }
  if (!isUpsConfigured()) {
    const result = { status: 'skipped', reason: 'ups_not_configured' };
    upsStatusSyncState.lastResult = result;
    return result;
  }
  if (typeof orderSqlRepository.updateUpsTrackingStatus !== 'function') {
    const result = { status: 'skipped', reason: 'sql_update_unavailable' };
    upsStatusSyncState.lastResult = result;
    return result;
  }

  upsStatusSyncInFlight = true;
  upsStatusSyncState.lastStartedAt = new Date().toISOString();
  upsStatusSyncState.lastFinishedAt = null;
  upsStatusSyncState.lastError = null;
  const startedAt = Date.now();

  let processed = 0;
  let updated = 0;
  let missing = 0;
  let failed = 0;

  try {
    const lookbackDays = Number(env.upsSync?.lookbackDays) || 60;
    const maxOrders = Number(env.upsSync?.maxOrders) || 50;
    const throttleMs = Math.max(0, Number(env.upsSync?.throttleMs) || 0);
    const orders = await fetchOrdersForSync({ lookbackDays, maxOrders });

    logger.info({ lookbackDays, maxOrders, fetchedOrders: orders.length }, 'UPS status sync: starting');

    for (const order of orders) {
      processed += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const info = await fetchUpsTrackingStatus(order.trackingNumber);
        const normalized = normalizeTrackingStatus(info?.trackingStatus || info?.trackingStatusRaw);
        if (!normalized) {
          missing += 1;
          // eslint-disable-next-line no-continue
          continue;
        }
        if (normalized !== order.upsTrackingStatus) {
          // eslint-disable-next-line no-await-in-loop
          await orderSqlRepository.updateUpsTrackingStatus(order.id, { upsTrackingStatus: normalized });
          updated += 1;
        }
        if (throttleMs > 0) {
          // eslint-disable-next-line no-await-in-loop
          await delay(throttleMs);
        }
      } catch (error) {
        failed += 1;
        logger.warn(
          { err: error, orderId: order.id, trackingNumber: order.trackingNumber || null },
          'UPS status sync: order failed',
        );
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const result = { status: 'success', processed, updated, missing, failed, elapsedMs };
    upsStatusSyncState.lastFinishedAt = new Date().toISOString();
    upsStatusSyncState.lastResult = result;
    logger.info(result, 'UPS status sync: finished');
    return result;
  } catch (error) {
    upsStatusSyncState.lastFinishedAt = new Date().toISOString();
    upsStatusSyncState.lastError = {
      message: error?.message || String(error),
      status: error?.status ?? error?.response?.status ?? null,
    };
    upsStatusSyncState.lastResult = null;
    throw error;
  } finally {
    upsStatusSyncInFlight = false;
  }
};

const getUpsStatusSyncState = () => ({
  ...upsStatusSyncState,
  inFlight: upsStatusSyncInFlight,
  intervalMs: env.upsSync?.intervalMs ?? null,
  lookbackDays: env.upsSync?.lookbackDays ?? null,
  maxOrders: env.upsSync?.maxOrders ?? null,
  enabled: env.upsSync?.enabled !== false,
});

const startUpsStatusSyncJob = () => {
  if (env.upsSync?.enabled === false) {
    logger.info('UPS status sync disabled by UPS_STATUS_SYNC_ENABLED=false');
    return;
  }
  if (upsStatusSyncTimer) {
    return;
  }
  const intervalMs = Math.max(Number(env.upsSync?.intervalMs) || (5 * 60 * 1000), 60_000);
  const runner = async () => {
    try {
      await runUpsStatusSyncOnce();
    } catch (error) {
      logger.error({ err: error }, 'UPS status sync job failed');
    }
  };
  runner();
  upsStatusSyncTimer = setInterval(runner, intervalMs);
  logger.info({ intervalMs }, 'UPS status sync scheduled');
};

module.exports = {
  fetchOrdersForSync,
  getUpsStatusSyncState,
  runUpsStatusSyncOnce,
  startUpsStatusSyncJob,
};
