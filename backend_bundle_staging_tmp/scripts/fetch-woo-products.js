#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { env } = require('../server/config/env');
const wooClient = require('../server/integration/wooCommerceClient');

const OUTPUT_DIR = path.join(process.cwd(), 'tmp');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'woo-products.json');
const DEFAULT_PAGE_SIZE = 48;

async function main() {
  if (!wooClient.isConfigured()) {
    console.error('[fetch-woo-products] WooCommerce credentials are not configured (.env)');
    process.exit(1);
  }

  const pageSize = Number(process.argv[2]) || DEFAULT_PAGE_SIZE;
  console.log(`[fetch-woo-products] Fetching up to ${pageSize} published products from ${env.wooCommerce.storeUrl}`);

  const products = await wooClient.fetchCatalog('products', {
    per_page: pageSize,
    status: 'publish',
    orderby: 'date',
    order: 'desc',
  });

  const normalizedProducts = Array.isArray(products) ? products : [];
  const variationsMap = {};

  for (const product of normalizedProducts) {
    if (!Array.isArray(product?.variations) || product.variations.length === 0) {
      continue;
    }

    try {
      const variations = await wooClient.fetchCatalog(`products/${product.id}/variations`, {
        per_page: 100,
        status: 'publish',
      });
      variationsMap[product.id] = Array.isArray(variations) ? variations : [];
    } catch (error) {
      console.warn(`[fetch-woo-products] Failed to load variations for product ${product.id}`, error.cause || error.message || error);
      variationsMap[product.id] = [];
    }
  }

  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const payload = {
    fetchedAt: new Date().toISOString(),
    count: normalizedProducts.length,
    products: normalizedProducts,
    variations: variationsMap,
  };
  await fs.promises.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2));

  console.log(`[fetch-woo-products] Saved catalog snapshot (${normalizedProducts.length} products) to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error('[fetch-woo-products] Unhandled error', error);
  process.exit(1);
});
