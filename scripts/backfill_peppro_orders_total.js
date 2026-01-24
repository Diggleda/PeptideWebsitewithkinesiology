#!/usr/bin/env node
/*
Backfill MySQL `peppro_orders.total` to the true grand total and normalize payload totals.

Why:
  Some historical rows stored the items subtotal in `peppro_orders.total`. Downstream reporting
  expects `total` to be the full order total (subtotal - discounts + shipping + tax).

Usage (dry-run):
  node scripts/backfill_peppro_orders_total.js --limit 200

Apply:
  node scripts/backfill_peppro_orders_total.js --apply --limit 200
*/

const mysqlClient = require('../server/database/mysqlClient');
const { logger } = require('../server/config/logger');

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundCurrency = (value) => Math.max(0, Math.round((toNumber(value, 0) + 1e-9) * 100) / 100);

const computeGrandTotal = (order) => {
  if (!order || typeof order !== 'object') {
    return 0;
  }

  const explicit = toNumber(order.grandTotal, NaN);
  if (Number.isFinite(explicit)) {
    return roundCurrency(explicit);
  }

  const itemsSubtotal = toNumber(
    order.itemsSubtotal ?? order.items_subtotal ?? order.itemsTotal ?? order.items_total ?? order.peppro_items_subtotal,
    NaN,
  );
  const shippingTotal = toNumber(order.shippingTotal ?? order.shipping_total ?? order.peppro_shipping_total, 0);
  const taxTotal = toNumber(order.taxTotal ?? order.totalTax ?? order.total_tax, 0);
  const discountTotal = toNumber(
    order.appliedReferralCredit ?? order.discountTotal ?? order.discount_total ?? order.totalDiscount,
    0,
  );

  if (Number.isFinite(itemsSubtotal)) {
    return roundCurrency(itemsSubtotal - discountTotal + shippingTotal + taxTotal);
  }

  return roundCurrency(order.total ?? order.total_ex_tax ?? 0);
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    apply: false,
    limit: 5000,
    onlyMismatched: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') parsed.apply = true;
    else if (arg === '--only-mismatched') parsed.onlyMismatched = true;
    else if (arg === '--limit') {
      const next = args[i + 1];
      if (next) {
        parsed.limit = Math.max(1, Math.min(Number(next) || 5000, 200000));
        i += 1;
      }
    }
  }

  return parsed;
};

const main = async () => {
  const args = parseArgs();

  if (!mysqlClient.isEnabled()) {
    // eslint-disable-next-line no-console
    console.error('MySQL is disabled (MYSQL_ENABLED is not true); nothing to backfill.');
    process.exitCode = 2;
    return;
  }

  await mysqlClient.configure();

  const rows = await mysqlClient.fetchAll(
    `
      SELECT id, total, payload
      FROM peppro_orders
      ORDER BY created_at DESC
      LIMIT :limit
    `,
    { limit: args.limit },
  );

  let scanned = 0;
  let updated = 0;

  for (const row of rows || []) {
    scanned += 1;
    const orderId = row?.id ? String(row.id) : null;
    const totalDb = roundCurrency(row?.total ?? 0);
    if (!orderId || !row?.payload) {
      continue;
    }

    let payloadObj;
    try {
      payloadObj = JSON.parse(row.payload);
    } catch (_error) {
      continue;
    }
    if (!payloadObj || typeof payloadObj !== 'object') {
      continue;
    }

    const order = payloadObj?.order && typeof payloadObj.order === 'object' ? payloadObj.order : payloadObj;
    const totalCalc = computeGrandTotal(order);
    if (args.onlyMismatched && Math.abs(totalCalc - totalDb) < 0.005) {
      continue;
    }

    if (!args.apply) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] order_id=${orderId} total_db=${totalDb.toFixed(2)} total_calc=${totalCalc.toFixed(2)}`);
      updated += 1;
      continue;
    }

    const normalizedOrder = {
      ...(order && typeof order === 'object' ? order : {}),
      total: totalCalc,
      grandTotal: totalCalc,
    };
    const normalizedPayload = {
      ...(payloadObj && typeof payloadObj === 'object' ? payloadObj : {}),
      order: normalizedOrder,
    };

    // eslint-disable-next-line no-await-in-loop
    await mysqlClient.execute(
      `
        UPDATE peppro_orders
        SET total = :total, payload = :payload, updated_at = NOW()
        WHERE id = :id
      `,
      { id: orderId, total: totalCalc, payload: JSON.stringify(normalizedPayload) },
    );
    updated += 1;
  }

  const mode = args.apply ? 'APPLIED' : 'DRY-RUN';
  logger.info({ mode, scanned, updated }, 'peppro_orders total backfill complete');
  // eslint-disable-next-line no-console
  console.log(`${mode}: scanned=${scanned} updated=${updated}`);
};

main().catch((error) => {
  logger.error({ err: error }, 'peppro_orders total backfill failed');
  // eslint-disable-next-line no-console
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

