const axios = require('axios');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const API_BASE_URL = 'https://ssapi.shipstation.com';

const isConfigured = () => Boolean(
  env.shipStation.apiToken
  || (env.shipStation.apiKey && env.shipStation.apiSecret),
);

// ShipStation wants weights in ounces for rate quoting when using package dimensions/weight
const normalizeWeightOz = (items = []) => {
  const total = items.reduce((sum, item) => {
    const weightOz = Number(item?.weightOz) || 0;
    const qty = Number(item?.quantity) || 0;
    return sum + (weightOz * qty);
  }, 0);
  return total > 0 ? total : 16; // default 1 lb
};

const resolveTotalWeightOz = (items = [], totalWeightOz) => {
  const parsed = Number(totalWeightOz);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return normalizeWeightOz(items);
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

const buildOrderItems = (items = []) => items.map((item, index) => {
  const lineItemKey = item.cartItemId || item.id || item.productId || `item-${index + 1}`;
  const quantity = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
  const unitPrice = Number(item.price) || 0;
  const weightOz = Number(item.weightOz);

  const payload = {
    lineItemKey,
    sku: item.productId || item.sku || null,
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
  const totalWeightOz = normalizeWeightOz(order.items || []);
  const shippingTotal = Number(order.shippingTotal) || 0;

  return {
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
    requestedShippingService: env.shipStation.serviceCode || undefined,
    carrierCode: env.shipStation.carrierCode || undefined,
    serviceCode: env.shipStation.serviceCode || undefined,
    packageCode: env.shipStation.packageCode || 'package',
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
    },
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
    logger.error({ err: error, payload }, 'ShipStation rate estimate failed');
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
    return {
      id: product.productId || product.product_id || product.id || null,
      sku: product.sku || sku,
      name: product.name || '',
      // ShipStation product inventory fields are typically onHand / available.
      stockOnHand: Number(
        product.onHand
        ?? product.quantityOnHand
        ?? product.quantity_on_hand
        ?? product.stock
        ?? product.stockOnHand
        ?? 0,
      ),
      available: Number(
        product.available
        ?? product.quantityAvailable
        ?? product.quantity_available
        ?? 0,
      ),
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
};
