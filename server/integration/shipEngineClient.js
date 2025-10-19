const axios = require('axios');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const API_BASE_URL = 'https://api.shipengine.com/v1';

const isConfigured = () => Boolean(env.shipEngine.apiKey);

const shouldAutoCreateLabels = env.shipEngine.autoCreateLabels === true;

const hasShippingAddress = (order) => Boolean(order?.shippingAddress?.postalCode);

const buildShipmentPayload = ({ order, customer }) => {
  if (!hasShippingAddress(order)) {
    return null;
  }

  const totalWeightOz = (order.items || []).reduce((sum, item) => {
    const weightOz = item.weightOz || 0;
    return sum + (weightOz * item.quantity);
  }, 0);

  return {
    service_code: env.shipEngine.defaultServiceCode || 'usps_priority_mail',
    ship_to: {
      name: customer.name || 'Protixa Customer',
      phone: customer.phone || '',
      email: customer.email || '',
      address_line1: order.shippingAddress.addressLine1,
      address_line2: order.shippingAddress.addressLine2 || '',
      city_locality: order.shippingAddress.city,
      state_province: order.shippingAddress.state,
      postal_code: order.shippingAddress.postalCode,
      country_code: order.shippingAddress.country || 'US',
    },
    ship_from: {
      name: env.shipEngine.shipFromName || 'Protixa Fulfillment',
      address_line1: env.shipEngine.shipFromAddress1 || '',
      address_line2: env.shipEngine.shipFromAddress2 || '',
      city_locality: env.shipEngine.shipFromCity || '',
      state_province: env.shipEngine.shipFromState || '',
      postal_code: env.shipEngine.shipFromPostalCode || '',
      country_code: env.shipEngine.shipFromCountry || 'US',
    },
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

module.exports = {
  isConfigured,
  forwardShipment,
  buildShipmentPayload,
};
