#!/usr/bin/env node
/*
Backfill MySQL `peppro_orders.shipped_at` from ShipStation historical ship dates.

Usage (dry-run):
  node scripts/backfill_shipdates.js --limit 200

Apply:
  node scripts/backfill_shipdates.js --apply --limit 200

Options:
  --limit <n>         Max rows to scan (default 500)
  --offset <n>        Offset into result set (default 0)
  --sleep-ms <n>      Delay between ShipStation calls (default 120)
  --require-tracking  Only apply when tracking is present (default false)
*/

const mysqlClient = require('../server/database/mysqlClient');
const { logger } = require('../server/config/logger');
const shipStationClient = require('../server/integration/shipStationClient');
const orderSqlRepository = require('../server/repositories/orderSqlRepository');

const toInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
};

const normalizeToken = (value) => {
  if (value === null || value === undefined) return null;
  const token = String(value).trim().replace(/^#/, '');
  return token || null;
};

const sleep = async (ms) => {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
};

const parseJsonObject = (raw) => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    return {};
  }
  return {};
};

const pickCandidateOrderNumbers = (row) => {
  const payload = parseJsonObject(row?.payload);
  const order = payload?.order && typeof payload.order === 'object' ? payload.order : payload;
  const integrations = payload?.integrations && typeof payload.integrations === 'object'
    ? payload.integrations
    : {};
  const woo = integrations?.wooCommerce && typeof integrations.wooCommerce === 'object'
    ? integrations.wooCommerce
    : {};

  const candidates = [
    row?.woo_order_id,
    order?.wooOrderNumber,
    order?.woo_order_number,
    order?.number,
    woo?.wooOrderNumber,
    woo?.response?.number,
    woo?.response?.id,
    payload?.wooOrderNumber,
    payload?.woo_order_number,
    payload?.number,
  ]
    .map((value) => normalizeToken(value))
    .filter(Boolean);

  return Array.from(new Set(candidates));
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    apply: false,
    limit: 500,
    offset: 0,
    sleepMs: 120,
    requireTracking: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--require-tracking') {
      parsed.requireTracking = true;
      continue;
    }
    if (arg === '--limit') {
      parsed.limit = Math.max(1, Math.min(toInt(args[i + 1], parsed.limit), 100000));
      i += 1;
      continue;
    }
    if (arg === '--offset') {
      parsed.offset = Math.max(0, toInt(args[i + 1], parsed.offset));
      i += 1;
      continue;
    }
    if (arg === '--sleep-ms') {
      parsed.sleepMs = Math.max(0, Math.min(toInt(args[i + 1], parsed.sleepMs), 10000));
      i += 1;
    }
  }
  return parsed;
};

const findShipStationRecord = async (orderNumbers, sleepMs) => {
  for (const orderNumber of orderNumbers) {
    let info = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      info = await shipStationClient.fetchOrderStatus(orderNumber);
    } catch (error) {
      logger.warn({ err: error, orderNumber }, 'ShipStation lookup failed during shipdate backfill');
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(sleepMs);

    if (info && info.shipDate) {
      return {
        ...info,
        queriedOrderNumber: orderNumber,
      };
    }
  }
  return null;
};

const buildPatchedOrder = (baseOrder, shipInfo) => {
  const integrationDetails = {
    ...(baseOrder?.integrationDetails && typeof baseOrder.integrationDetails === 'object'
      ? baseOrder.integrationDetails
      : {}),
  };
  integrationDetails.shipStation = {
    ...(integrationDetails?.shipStation && typeof integrationDetails.shipStation === 'object'
      ? integrationDetails.shipStation
      : {}),
    status: shipInfo?.status || integrationDetails?.shipStation?.status || null,
    shipDate: shipInfo?.shipDate || integrationDetails?.shipStation?.shipDate || null,
    trackingNumber: shipInfo?.trackingNumber || integrationDetails?.shipStation?.trackingNumber || null,
    carrierCode: shipInfo?.carrierCode || integrationDetails?.shipStation?.carrierCode || null,
    serviceCode: shipInfo?.serviceCode || integrationDetails?.shipStation?.serviceCode || null,
    orderId: shipInfo?.orderId || integrationDetails?.shipStation?.orderId || null,
    orderNumber: shipInfo?.orderNumber || integrationDetails?.shipStation?.orderNumber || null,
  };

  const shippingEstimate = {
    ...(baseOrder?.shippingEstimate && typeof baseOrder.shippingEstimate === 'object'
      ? baseOrder.shippingEstimate
      : {}),
  };
  if (shipInfo?.shipDate && !shippingEstimate.shipDate) {
    shippingEstimate.shipDate = shipInfo.shipDate;
  }
  if (shipInfo?.carrierCode && !shippingEstimate.carrierId) {
    shippingEstimate.carrierId = shipInfo.carrierCode;
  }
  if (shipInfo?.serviceCode && !shippingEstimate.serviceType) {
    shippingEstimate.serviceType = shipInfo.serviceCode;
  }
  if (shipInfo?.status && !shippingEstimate.status) {
    shippingEstimate.status = String(shipInfo.status).trim().toLowerCase();
  }

  return {
    ...baseOrder,
    status: baseOrder?.status || shipInfo?.status || 'shipped',
    trackingNumber: baseOrder?.trackingNumber || shipInfo?.trackingNumber || null,
    shipStationOrderId: baseOrder?.shipStationOrderId || shipInfo?.orderId || null,
    shippedAt: shipInfo?.shipDate || baseOrder?.shippedAt || null,
    shippingEstimate: Object.keys(shippingEstimate).length > 0 ? shippingEstimate : null,
    integrationDetails,
  };
};

const main = async () => {
  const args = parseArgs();

  if (!mysqlClient.isEnabled()) {
    // eslint-disable-next-line no-console
    console.error('MySQL is disabled (MYSQL_ENABLED is not true); nothing to backfill.');
    process.exitCode = 2;
    return;
  }
  if (!shipStationClient.isConfigured()) {
    // eslint-disable-next-line no-console
    console.error('ShipStation is not configured; cannot fetch historical ship dates.');
    process.exitCode = 2;
    return;
  }

  await mysqlClient.configure();

  const rows = await mysqlClient.fetchAll(
    `
      SELECT id, woo_order_id, shipstation_order_id, status, payload
      FROM peppro_orders
      WHERE shipped_at IS NULL
        AND LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-')) IN ('shipped', 'completed')
      ORDER BY created_at DESC
      LIMIT :limit OFFSET :offset
    `,
    { limit: args.limit, offset: args.offset },
  );

  let scanned = 0;
  let matched = 0;
  let updated = 0;
  let skippedNoCandidate = 0;
  let skippedNoShipDate = 0;
  let skippedTrackingRequired = 0;

  for (const row of rows || []) {
    scanned += 1;
    const orderId = normalizeToken(row?.id);
    if (!orderId) {
      continue;
    }

    const candidates = pickCandidateOrderNumbers(row);
    if (candidates.length === 0) {
      skippedNoCandidate += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const shipInfo = await findShipStationRecord(candidates, args.sleepMs);
    if (!shipInfo?.shipDate) {
      skippedNoShipDate += 1;
      continue;
    }
    if (args.requireTracking && !normalizeToken(shipInfo?.trackingNumber)) {
      skippedTrackingRequired += 1;
      continue;
    }
    matched += 1;

    if (!args.apply) {
      // eslint-disable-next-line no-console
      console.log(
        `[dry-run] order_id=${orderId} ship_date=${shipInfo.shipDate} tracking=${shipInfo.trackingNumber || ''} via=${shipInfo.queriedOrderNumber}`,
      );
      continue;
    }

    let baseOrder = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      baseOrder = await orderSqlRepository.fetchById(orderId);
    } catch (error) {
      logger.warn({ err: error, orderId }, 'Failed to fetch order before shipdate backfill write');
      continue;
    }
    if (!baseOrder) {
      continue;
    }

    const nextOrder = buildPatchedOrder(baseOrder, shipInfo);
    try {
      // eslint-disable-next-line no-await-in-loop
      await orderSqlRepository.persistOrder({
        order: nextOrder,
        wooOrderId: nextOrder.wooOrderId || row?.woo_order_id || null,
        shipStationOrderId: nextOrder.shipStationOrderId || row?.shipstation_order_id || null,
      });
      updated += 1;
      // eslint-disable-next-line no-console
      console.log(
        `[updated] order_id=${orderId} ship_date=${shipInfo.shipDate} tracking=${shipInfo.trackingNumber || ''} via=${shipInfo.queriedOrderNumber}`,
      );
    } catch (error) {
      logger.warn({ err: error, orderId }, 'Failed to persist shipdate backfill update');
    }
  }

  const mode = args.apply ? 'APPLIED' : 'DRY-RUN';
  logger.info(
    {
      mode,
      scanned,
      matched,
      updated,
      skippedNoCandidate,
      skippedNoShipDate,
      skippedTrackingRequired,
      limit: args.limit,
      offset: args.offset,
      sleepMs: args.sleepMs,
    },
    'Ship date backfill finished',
  );

  // eslint-disable-next-line no-console
  console.log(
    `${mode}: scanned=${scanned} matched=${matched} updated=${updated} `
    + `skipped_no_candidate=${skippedNoCandidate} skipped_no_ship_date=${skippedNoShipDate} `
    + `skipped_tracking_required=${skippedTrackingRequired}`,
  );
};

main().catch((error) => {
  logger.error({ err: error }, 'Ship date backfill failed');
  // eslint-disable-next-line no-console
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

