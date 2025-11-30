#!/usr/bin/env node
const path = require('path');

// Ensure env is loaded before using any integrations
require('../server/config/env');

const { env } = require('../server/config/env');
const shipStationClient = require('../server/integration/shipStationClient');
const wooClient = require('../server/integration/wooCommerceClient');
const inventorySyncService = require('../server/services/inventorySyncService');

async function main() {
  const args = process.argv.slice(2).map((arg) => arg.trim()).filter(Boolean);

  if (args.length === 0) {
    console.error('Usage: node scripts/sync-shipstation-inventory.js <SKU1> [SKU2 SKU3 ...]');
    process.exit(1);
  }

  if (!shipStationClient.isConfigured()) {
    console.error('[sync-shipstation-inventory] ShipStation credentials are not configured (.env)');
    process.exit(1);
  }

  if (!wooClient.isConfigured()) {
    console.error('[sync-shipstation-inventory] WooCommerce credentials are not configured (.env)');
    process.exit(1);
  }

  console.log('[sync-shipstation-inventory] Using Woo store:', env.wooCommerce.storeUrl);
  console.log('[sync-shipstation-inventory] Syncing SKUs from ShipStation → WooCommerce:', args.join(', '));

  const items = args.map((sku) => ({
    productId: sku,
    sku,
    quantity: 1,
  }));

  try {
    const result = await inventorySyncService.syncShipStationInventoryToWoo(items);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[sync-shipstation-inventory] Unhandled error:', error.message || error);
    process.exit(1);
  }
}

main();

