const axios = require('axios');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const API_BASE_URL = 'https://api.shipengine.com/v1';

const isConfigured = () => Boolean(env.shipEngine.apiKey);

const shouldAutoCreateLabels = env.shipEngine.autoCreateLabels === true;
const hasCarrierForRates = () => Boolean(env.shipEngine.defaultCarrierId || env.shipEngine.defaultServiceCode);

const hasShippingAddress = (order) => Boolean(order?.shippingAddress?.postalCode);

const buildShipFromAddress = () => ({
  name: env.shipEngine.shipFromName || 'PepPro Fulfillment',
  address_line1: env.shipEngine.shipFromAddress1 || '',
  address_line2: env.shipEngine.shipFromAddress2 || '',
  city_locality: env.shipEngine.shipFromCity || '',
  state_province: env.shipEngine.shipFromState || '',
  postal_code: env.shipEngine.shipFromPostalCode || '',
  country_code: env.shipEngine.shipFromCountry || 'US',
});

const normalizeWeightOz = (items = []) => {
  const total = items.reduce((sum, item) => {
    const weightOz = Number(item?.weightOz) || 0;
    const qty = Number(item?.quantity) || 0;
    return sum + (weightOz * qty);
  }, 0);
  // Default to 1 lb if no weights provided
  return total > 0 ? total : 16;
};

const buildShipmentPayload = ({ order, customer }) => {
  if (!hasShippingAddress(order)) {
    return null;
  }

  const totalWeightOz = normalizeWeightOz(order.items || []);

  return {
    service_code: env.shipEngine.defaultServiceCode || 'usps_priority_mail',
    ship_to: {
      name: customer.name || 'PepPro Customer',
      phone: customer.phone || '',
      email: customer.email || '',
      address_line1: order.shippingAddress.addressLine1,
      address_line2: order.shippingAddress.addressLine2 || '',
      city_locality: order.shippingAddress.city,
      state_province: order.shippingAddress.state,
      postal_code: order.shippingAddress.postalCode,
      country_code: order.shippingAddress.country || 'US',
    },
    ship_from: buildShipFromAddress(),
    packages: [
      {
        package_code: 'package',
        weight: {
          value: totalWeightOz > 0 ? totalWeightOz : 16,
          unit: 'ounce',
        },
      },
    ],
    external_order_id: order.id,
  };
};

const forwardShipment = async ({ order, customer }) => {
  if (!isConfigured()) {
    return {
      status: 'skipped',
      reason: 'not_configured',
    };
  }

  const payload = buildShipmentPayload({ order, customer });

  if (!payload) {
    return {
      status: 'skipped',
      reason: 'missing_shipping_address',
    };
  }

  if (!shouldAutoCreateLabels) {
    return {
      status: 'pending',
      reason: 'auto_create_disabled',
      payload,
    };
  }

  try {
    const client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'API-Key': env.shipEngine.apiKey,
      },
      timeout: 10_000,
    });

    const response = await client.post('/labels', payload);
    return {
      status: 'success',
      payload,
      response: {
        labelId: response.data?.label_id,
        status: response.data?.status,
        trackingNumber: response.data?.tracking_number,
      },
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to create ShipEngine label');
    const integrationError = new Error('ShipEngine label creation failed');
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

const estimateRates = async ({ shippingAddress, items }) => {
  if (!isConfigured()) {
    const error = new Error('ShipEngine is not configured');
    error.status = 503;
    throw error;
  }
  if (!hasCarrierForRates()) {
    const error = new Error('ShipEngine requires a default carrier or service code for rate estimates');
    error.status = 400;
    throw error;
  }
  if (!shippingAddress?.postalCode || !shippingAddress?.state || !shippingAddress?.city || !shippingAddress?.addressLine1) {
    const error = new Error('Shipping address is incomplete');
    error.status = 400;
    throw error;
  }

  const weightOz = normalizeWeightOz(items || []);
  const payload = {
    carrier_ids: env.shipEngine.defaultCarrierId ? [env.shipEngine.defaultCarrierId] : undefined,
    service_code: env.shipEngine.defaultServiceCode || undefined,
    ship_to: {
      name: shippingAddress.name || 'PepPro Customer',
      address_line1: shippingAddress.addressLine1,
      address_line2: shippingAddress.addressLine2 || '',
      city_locality: shippingAddress.city,
      state_province: shippingAddress.state,
      postal_code: shippingAddress.postalCode,
      country_code: shippingAddress.country || 'US',
    },
    ship_from: buildShipFromAddress(),
    packages: [
      {
        package_code: 'package',
        weight: {
          value: weightOz,
          unit: 'ounce',
        },
      },
    ],
  };

  try {
    const client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'API-Key': env.shipEngine.apiKey,
      },
      timeout: 10_000,
    });
    const response = await client.post('/rates/estimate', payload);
    const rates = Array.isArray(response.data?.rate_response?.rates)
      ? response.data.rate_response.rates
      : [];
    return rates.map((rate) => ({
      carrierId: rate.carrier_id || null,
      serviceCode: rate.service_code || null,
      serviceType: rate.service_type || null,
      estimatedDeliveryDays: rate.estimated_delivery_days ?? null,
      deliveryDateGuaranteed: rate.guaranteed_delivery_date ?? null,
      rate: rate.shipping_amount?.amount,
      currency: rate.shipping_amount?.currency,
    }));
  } catch (error) {
    logger.error({ err: error }, 'ShipEngine rate estimate failed');
    const integrationError = new Error('ShipEngine rate estimate failed');
    integrationError.status = error.response?.status ?? 502;
    integrationError.cause = error.response?.data || error;
    throw integrationError;
  }
};

module.exports = {
  isConfigured,
  forwardShipment,
  buildShipmentPayload,
  estimateRates,
};
