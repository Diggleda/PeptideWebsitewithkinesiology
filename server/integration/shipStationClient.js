const axios = require('axios');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const API_BASE_URL = 'https://ssapi.shipstation.com';

const isConfigured = () => Boolean(
  env.shipStation.apiToken
  || (env.shipStation.apiKey && env.shipStation.apiSecret),
);

const DEFAULT_ITEM_WEIGHT_OZ = 16;
// ShipStation wants weights in ounces for rate quoting when using package dimensions/weight.
const normalizeWeightOz = (items = []) => {
  let total = 0;
  let missingWeightQty = 0;
  items.forEach((item) => {
    const qty = Number(item?.quantity) || 0;
    if (!Number.isFinite(qty) || qty <= 0) {
      return;
    }
    const weightOz = Number(item?.weightOz);
    if (Number.isFinite(weightOz) && weightOz > 0) {
      total += weightOz * qty;
      return;
    }
    missingWeightQty += qty;
  });
  if (missingWeightQty > 0) {
    total += DEFAULT_ITEM_WEIGHT_OZ * missingWeightQty;
  }
  return total > 0 ? total : DEFAULT_ITEM_WEIGHT_OZ; // default 1 lb
};

const aggregatePackageDimensions = (items = []) => {
  const totals = (items || []).reduce((acc, item) => {
    const quantity = Number(item?.quantity) || 0;
    if (quantity <= 0) {
      return acc;
    }
    const length = Number(item?.lengthIn ?? item?.dimensions?.lengthIn);
    const width = Number(item?.widthIn ?? item?.dimensions?.widthIn);
    const height = Number(item?.heightIn ?? item?.dimensions?.heightIn);
    if (Number.isFinite(length) && length > 0) {
      acc.length = Math.max(acc.length, length);
    }
    if (Number.isFinite(width) && width > 0) {
      acc.width = Math.max(acc.width, width);
    }
    if (Number.isFinite(height) && height > 0) {
      acc.height += height * quantity;
    }
    return acc;
  }, { length: 0, width: 0, height: 0 });

  if (totals.length <= 0 || totals.width <= 0 || totals.height <= 0) {
    return null;
  }
  const round = (value) => Math.round(value * 100) / 100;
  return {
    length: round(totals.length),
    width: round(totals.width),
    height: round(totals.height),
  };
};

const resolveTotalWeightOz = (items = [], totalWeightOz) => {
  const parsed = Number(totalWeightOz);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return normalizeWeightOz(items);
};

const resolveShippingMeta = (order = {}) => {
  const estimate = order.shippingEstimate || {};
  const carrierId = estimate.carrierId || estimate.carrierCode || null;
  const serviceCode = estimate.serviceCode || estimate.serviceType || null;
  const requestedService = estimate.serviceType || estimate.serviceCode || null;
  const packageCode = estimate.packageCode || env.shipStation.packageCode || 'package';
  return {
    carrierCode: carrierId || env.shipStation.carrierCode || undefined,
    serviceCode: serviceCode || env.shipStation.serviceCode || undefined,
    requestedService: requestedService || env.shipStation.serviceCode || undefined,
    packageCode,
  };
};

const buildShipTo = (shippingAddress = {}, customer = {}) => ({
  name: shippingAddress.name || customer.name || 'Customer',
  company: shippingAddress.company || customer.company || '',
  street1: shippingAddress.addressLine1,
  street2: shippingAddress.addressLine2 || '',
  city: shippingAddress.city,
  state: shippingAddress.state,
  postalCode: shippingAddress.postalCode,
  country: shippingAddress.country || 'US',
  phone: shippingAddress.phone || customer.phone || '',
});

const buildShipFrom = () => ({
  name: env.shipStation.shipFrom.name || env.shipStation.shipFrom.company || 'PepPro',
  company: env.shipStation.shipFrom.company || '',
  street1: env.shipStation.shipFrom.addressLine1 || '',
  street2: env.shipStation.shipFrom.addressLine2 || '',
  city: env.shipStation.shipFrom.city || '',
  state: env.shipStation.shipFrom.state || '',
  postalCode: env.shipStation.shipFrom.postalCode || '',
  country: env.shipStation.shipFrom.countryCode || 'US',
  phone: env.shipStation.shipFrom.phone || '',
});

const getHttpClient = () => {
  const headers = {
    'Content-Type': 'application/json',
  };

  const config = {
    baseURL: API_BASE_URL,
    timeout: 15000,
    headers,
  };

  if (env.shipStation.apiToken) {
    headers.Authorization = `Bearer ${env.shipStation.apiToken}`;
  } else {
    config.auth = {
      username: env.shipStation.apiKey,
      password: env.shipStation.apiSecret,
    };
  }

  return axios.create(config);
};

const safeString = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const buildOrderItems = (items = []) => items.map((item, index) => {
  const lineItemKey = item.cartItemId || item.id || item.productId || `item-${index + 1}`;
  const quantity = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
  const unitPrice = Number(item.price) || 0;
  const weightOz = Number(item.weightOz);
  const resolvedSku = item.sku
    || item.productSku
    || item.variantSku
    || (typeof item.productId === 'string' ? item.productId : null);

  const payload = {
    lineItemKey,
    sku: resolvedSku || null,
    name: item.name || `Item ${index + 1}`,
    quantity,
    unitPrice,
  };

  if (Number.isFinite(weightOz) && weightOz > 0) {
    payload.weight = {
      value: weightOz,
      units: 'ounces',
    };
  }

  return payload;
});

const buildOrderPayload = ({ order, customer, wooOrder }) => {
  if (!order?.shippingAddress) {
    return null;
  }

  const wooOrderId = wooOrder?.response?.id || wooOrder?.response?.orderId || null;
  const wooMetaData = Array.isArray(wooOrder?.payload?.meta_data) ? wooOrder.payload.meta_data : [];
  const wooOrderNumber = wooOrder?.response?.number
    || (wooMetaData.find((meta) => meta?.key === 'peppro_order_id')?.value)
    || null;
  const estimatedWeight = order?.shippingEstimate?.weightOz;
  const totalWeightOz = resolveTotalWeightOz(order.items || [], estimatedWeight);
  const shippingTotal = Number(order.shippingTotal) || 0;
  const packageDimensions = order?.shippingEstimate?.packageDimensions
    || order?.shippingEstimate?.dimensions
    || aggregatePackageDimensions(order.items || []);
  const shippingMeta = resolveShippingMeta(order);

  const payload = {
    orderNumber: wooOrderNumber || order.id,
    orderKey: wooOrderId ? `woo-${wooOrderId}` : order.id,
    orderSource: 'PepPro Checkout',
    orderStatus: 'awaiting_shipment',
    orderDate: order.createdAt,
    paymentDate: order.createdAt,
    customerEmail: customer.email || '',
    customerNotes: order.referralCode
      ? `Referral code: ${order.referralCode}`
      : undefined,
    requestedShippingService: shippingMeta.requestedService,
    carrierCode: shippingMeta.carrierCode,
    serviceCode: shippingMeta.serviceCode,
    packageCode: shippingMeta.packageCode,
    amountPaid: Math.max(Number(order.total) || 0, 0),
    shippingPaid: shippingTotal,
    taxAmount: Number(order.taxTotal) || 0,
    billTo: {
      name: customer.name || 'PepPro Customer',
      company: customer.company || '',
      street1: order.shippingAddress.addressLine1,
      street2: order.shippingAddress.addressLine2 || '',
      city: order.shippingAddress.city,
      state: order.shippingAddress.state,
      postalCode: order.shippingAddress.postalCode,
      country: order.shippingAddress.country || 'US',
      phone: order.shippingAddress.phone || customer.phone || '',
      email: customer.email || '',
    },
    shipTo: buildShipTo(order.shippingAddress, customer),
    shipFrom: buildShipFrom(),
    weight: {
      value: totalWeightOz,
      units: 'ounces',
    },
    items: buildOrderItems(order.items || []),
    advancedOptions: {
      storeId: env.shipStation.storeId
        ? Number(env.shipStation.storeId)
        : undefined,
      source: 'woocommerce',
      customOrderNumber: wooOrderNumber || order.id,
      requestedPackageType: shippingMeta.packageCode,
    },
  };

  if (packageDimensions) {
    payload.dimensions = {
      units: 'inches',
      length: packageDimensions.length,
      width: packageDimensions.width,
      height: packageDimensions.height,
    };
  }

  return payload;
};

/**
 * Fetch ShipStation order status + basic shipment info for a given order number.
 * Mirrors the Python backend's fetch_order_status helper.
 */
const fetchOrderStatus = async (orderNumber) => {
  const normalized = safeString(orderNumber);
  if (!isConfigured() || !normalized) {
    return null;
  }

  let order = null;
  try {
    const client = getHttpClient();
    const response = await client.get('/orders', {
      params: {
        orderNumber: normalized,
        pageSize: 1,
      },
    });
    const data = response.data || {};
    const orders = Array.isArray(data.orders) ? data.orders : [];
    if (!orders.length) {
      return null;
    }
    [order] = orders;
  } catch (error) {
    const statusCode = error.response?.status ?? error.status ?? 502;
    let responsePayload = null;
    try {
      responsePayload = error.response?.data || null;
    } catch {
      responsePayload = null;
    }
    logger.error(
      {
        err: error,
        status: statusCode,
        response: responsePayload,
        orderNumber: normalized,
      },
      'ShipStation order lookup failed',
    );
    const integrationError = new Error('ShipStation order lookup failed');
    integrationError.status = statusCode;
    integrationError.cause = responsePayload || error;
    throw integrationError;
  }

  if (!order) {
    return null;
  }

  let trackingNumber = safeString(order.trackingNumber);

  // Older ShipStation payloads may embed shipments under the order.
  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  for (const shipment of shipments) {
    if (shipment && safeString(shipment.trackingNumber)) {
      trackingNumber = safeString(shipment.trackingNumber);
      break;
    }
  }

  // If tracking is still missing, best-effort lookup via shipments endpoint.
  if (!trackingNumber) {
    try {
      const client = getHttpClient();
      const shipmentResp = await client.get('/shipments', {
        params: {
          orderNumber: normalized,
          pageSize: 5,
        },
      });
      const shipmentData = shipmentResp.data || {};
      const shipmentList = Array.isArray(shipmentData.shipments) ? shipmentData.shipments : [];
      let nonVoidedTracking = null;
      let anyTracking = null;
      for (const shipment of shipmentList) {
        const candidate = shipment ? safeString(shipment.trackingNumber) : null;
        if (!candidate) {
          continue;
        }
        if (!anyTracking) {
          anyTracking = candidate;
        }
        if (!shipment.voided && !nonVoidedTracking) {
          nonVoidedTracking = candidate;
        }
      }
      trackingNumber = nonVoidedTracking || anyTracking || trackingNumber;
    } catch (lookupError) {
      logger.warn(
        {
          err: lookupError,
          orderNumber: normalized,
        },
        'ShipStation shipment tracking lookup failed',
      );
    }
  }

  return {
    status: safeString(order.orderStatus),
    shipDate: safeString(order.shipDate),
    trackingNumber,
    carrierCode: safeString(order.carrierCode),
    serviceCode: safeString(order.serviceCode),
    orderNumber: safeString(order.orderNumber),
    orderId: order.orderId || order.id || null,
  };
};

/**
 * ShipStation rate estimation: create a temporary order and list rates.
 * We keep this minimal: single package, summed weight, caller provides items+address.
 */
const estimateRates = async ({ shippingAddress, items, totalWeightOz }) => {
  if (!isConfigured()) {
    const error = new Error('ShipStation is not configured');
    error.status = 503;
    throw error;
  }

  if (!shippingAddress?.postalCode || !shippingAddress?.state || !shippingAddress?.city || !shippingAddress?.addressLine1) {
    const error = new Error('Shipping address is incomplete');
    error.status = 400;
    throw error;
  }

  const weightOz = resolveTotalWeightOz(items || [], totalWeightOz);

  const shipFrom = buildShipFrom();
  const packageDimensions = aggregatePackageDimensions(items || []);
  const payload = {
    carrierCode: env.shipStation.carrierCode || undefined,
    serviceCode: env.shipStation.serviceCode || undefined,
    packageCode: env.shipStation.packageCode || undefined,
    confirmation: 'none',
    fromCity: shipFrom.city,
    fromState: shipFrom.state,
    fromPostalCode: shipFrom.postalCode,
    fromCountry: shipFrom.country,
    toCity: shippingAddress.city,
    toState: shippingAddress.state,
    toPostalCode: shippingAddress.postalCode,
    toCountry: shippingAddress.country || 'US',
    weight: {
      value: weightOz,
      units: 'ounces',
    },
  };
  if (packageDimensions) {
    payload.dimensions = {
      units: 'inches',
      length: packageDimensions.length,
      width: packageDimensions.width,
      height: packageDimensions.height,
    };
  }

  try {
    const client = getHttpClient();
    // ShipStation supports a List Rates endpoint without creating an order: POST /shipments/getrates
    const response = await client.post('/shipments/getrates', payload);
    const rates = Array.isArray(response.data) ? response.data : [];
    return rates.map((rate) => ({
      carrierId: rate.carrierCode || null,
      serviceCode: rate.serviceCode || null,
      serviceType: rate.serviceType || rate.serviceCode || null,
      estimatedDeliveryDays: rate.estimatedDeliveryDays ?? null,
      deliveryDateGuaranteed: rate.guaranteedDeliveryDate ?? null,
      rate: rate.shippingAmount?.amount ?? rate.shipmentCost ?? null,
      currency: rate.shippingAmount?.currency || 'USD',
    }));
  } catch (error) {
    logger.error(
      {
        err: error,
        status: error.response?.status ?? null,
        response: error.response?.data || null,
        payload,
      },
      'ShipStation rate estimate failed',
    );
    const integrationError = new Error('ShipStation rate estimate failed');
    integrationError.status = error.response?.status ?? 502;
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const forwardOrder = async ({ order, customer, wooOrder }) => {
  if (!isConfigured()) {
    return {
      status: 'skipped',
      reason: 'not_configured',
    };
  }

  const payload = buildOrderPayload({ order, customer, wooOrder });
  if (!payload) {
    return {
      status: 'skipped',
      reason: 'missing_shipping_address',
    };
  }

  try {
    const client = getHttpClient();
    const response = await client.post('/orders/createorder', payload);
    const responseData = response.data || {};
    return {
      status: 'success',
      payload,
      response: {
        orderId: responseData.orderId || responseData.order_id || responseData.id || null,
        orderKey: responseData.orderKey || responseData.order_key || null,
        orderNumber: responseData.orderNumber || responseData.order_number || payload.orderNumber,
      },
    };
  } catch (error) {
    logger.error({ err: error, orderId: order?.id }, 'ShipStation order forward failed');
    const integrationError = new Error('ShipStation order creation failed');
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const coerceInventoryNumber = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

const fetchProductBySku = async (sku) => {
  if (!isConfigured() || !sku) {
    return null;
  }

  try {
    const client = getHttpClient();
    const response = await client.get('/products', {
      params: {
        sku,
        includeInactive: false,
        pageSize: 1,
      },
    });
    const products = Array.isArray(response.data?.products) ? response.data.products : [];
    if (products.length === 0) {
      return null;
    }
    const product = products[0];
    const stockOnHand = coerceInventoryNumber(
      product.onHand,
      product.quantityOnHand,
      product.quantity_on_hand,
      product.stock,
      product.stockOnHand,
    );
    const available = coerceInventoryNumber(
      product.available,
      product.quantityAvailable,
      product.quantity_available,
    );
    return {
      id: product.productId || product.product_id || product.id || null,
      sku: product.sku || sku,
      name: product.name || '',
      // ShipStation product inventory fields are typically onHand / available.
      stockOnHand,
      available,
    };
  } catch (error) {
    logger.error({ err: error, sku }, 'ShipStation product fetch failed');
    const integrationError = new Error('ShipStation product lookup failed');
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

module.exports = {
  isConfigured,
  estimateRates,
  forwardOrder,
  fetchProductBySku,
  fetchOrderStatus,
};
