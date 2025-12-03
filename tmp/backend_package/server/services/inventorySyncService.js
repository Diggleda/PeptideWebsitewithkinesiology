const shipStationClient = require('../integration/shipStationClient');
const wooCommerceClient = require('../integration/wooCommerceClient');
const { logger } = require('../config/logger');

const normalizeSku = (value) => {
  if (!value) {
    return null;
  }
  return String(value).trim();
};

const collectSkus = (items = [], extraSkus = []) => {
  const unique = new Set();
  (items || []).forEach((item) => {
    const normalized = normalizeSku(item?.sku || item?.productId);
    if (normalized) {
      unique.add(normalized);
    }
  });
  (extraSkus || []).forEach((sku) => {
    const normalized = normalizeSku(sku);
    if (normalized) {
      unique.add(normalized);
    }
  });
  return Array.from(unique);
};

const syncShipStationInventoryToWoo = async (items = [], options = {}) => {
  const skus = collectSkus(items, options?.skus);

  if (skus.length === 0) {
    return {
      status: 'skipped',
      reason: 'no_skus',
    };
  }
  if (!shipStationClient.isConfigured() || !wooCommerceClient.isConfigured()) {
    return {
      status: 'skipped',
      reason: 'integrations_disabled',
    };
  }

  const results = [];

  for (const sku of skus) {
    try {
      const shipStationProduct = await shipStationClient.fetchProductBySku(sku);
      if (!shipStationProduct) {
        results.push({ sku, status: 'shipstation_not_found' });
        continue;
      }

      const resolvedStock = Number.isFinite(shipStationProduct.stockOnHand)
        ? shipStationProduct.stockOnHand
        : shipStationProduct.available;

      const wooProduct = await wooCommerceClient.findProductBySku(sku);
      if (!wooProduct?.id) {
        results.push({ sku, status: 'woo_not_found' });
        continue;
      }

      const inventoryResult = await wooCommerceClient.updateProductInventory(wooProduct.id, {
        stock_quantity: resolvedStock,
        parent_id: wooProduct.parent_id || null,
        type: wooProduct.type || null,
      });

      results.push({
        sku,
        status: 'updated',
        stockQuantity: resolvedStock,
        wooProductId: wooProduct.id,
        shipStation: {
          stockOnHand: shipStationProduct.stockOnHand,
          available: shipStationProduct.available,
        },
        wooInventory: {
          stock_quantity: inventoryResult?.response?.stock_quantity ?? null,
        },
      });
    } catch (error) {
      logger.error({ err: error, sku }, 'Inventory sync failed for SKU');
      results.push({
        sku,
        status: 'error',
        message: error.message,
      });
    }
  }

  return {
    status: 'completed',
    total: results.length,
    results,
  };
};

module.exports = {
  syncShipStationInventoryToWoo,
};
