const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const { ensureShippingAddress, createAddressFingerprint } = require('../services/shippingValidation');
const { logger } = require('../config/logger');

const validateItems = (items) => Array.isArray(items)
  && items.every((item) => Number(item?.quantity) > 0);

const getRates = async (req, res, next) => {
  try {
    const { shippingAddress, items } = req.body || {};

    if (!validateItems(items || [])) {
      const error = new Error('At least one item with quantity is required to price shipping');
      error.status = 400;
      throw error;
    }

    const normalizedAddress = ensureShippingAddress(shippingAddress);

    // Prefer ShipStation if configured; otherwise, fall back to ShipEngine.
    let rates;
    if (shipStationClient.isConfigured()) {
      rates = await shipStationClient.estimateRates({ shippingAddress: normalizedAddress, items });
    } else if (shipEngineClient.isConfigured()) {
      rates = await shipEngineClient.estimateRates({ shippingAddress: normalizedAddress, items });
    } else {
      const error = new Error('Shipping is not configured');
      error.status = 503;
      throw error;
    }

    const addressFingerprint = createAddressFingerprint(normalizedAddress);
    const decoratedRates = Array.isArray(rates)
      ? rates.map((rate) => ({
        ...rate,
        addressFingerprint,
      }))
      : [];

    res.json({
      success: true,
      rates: decoratedRates,
      addressFingerprint,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch shipping rates');
    next(error);
  }
};

module.exports = {
  getRates,
};
