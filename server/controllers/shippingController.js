const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const { ensureShippingAddress, createAddressFingerprint } = require('../services/shippingValidation');
const { logger } = require('../config/logger');

const validateItems = (items) => Array.isArray(items)
  && items.every((item) => Number(item?.quantity) > 0);

const DEFAULT_ITEM_WEIGHT_OZ = 16;
const calculateTotalWeightOz = (items = []) => {
  let total = 0;
  let missingWeightQty = 0;
  items.forEach((item) => {
    const quantity = Number(item?.quantity) || 0;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return;
    }
    const unitWeight = Number(item?.weightOz);
    if (Number.isFinite(unitWeight) && unitWeight > 0) {
      total += unitWeight * quantity;
      return;
    }
    missingWeightQty += quantity;
  });

  if (missingWeightQty > 0) {
    total += DEFAULT_ITEM_WEIGHT_OZ * missingWeightQty;
  }
  return total > 0 ? total : DEFAULT_ITEM_WEIGHT_OZ;
};

const getRates = async (req, res, next) => {
  try {
    const { shippingAddress, items } = req.body || {};

    if (!validateItems(items || [])) {
      const error = new Error('At least one item with quantity is required to price shipping');
      error.status = 400;
      throw error;
    }

    const normalizedAddress = ensureShippingAddress(shippingAddress);
    const totalWeightOz = calculateTotalWeightOz(items || []);

    // Prefer ShipStation; fall back to ShipEngine on failure.
    let rates;
    if (shipStationClient.isConfigured()) {
      try {
        rates = await shipStationClient.estimateRates({
          shippingAddress: normalizedAddress,
          items,
          totalWeightOz,
        });
      } catch (shipStationError) {
        logger.warn(
          { err: shipStationError },
          'ShipStation rate estimate failed; attempting ShipEngine fallback',
        );
        if (shipEngineClient.isConfigured()) {
          rates = await shipEngineClient.estimateRates({
            shippingAddress: normalizedAddress,
            items,
            totalWeightOz,
          });
        } else {
          throw shipStationError;
        }
      }
    } else if (shipEngineClient.isConfigured()) {
      rates = await shipEngineClient.estimateRates({
        shippingAddress: normalizedAddress,
        items,
        totalWeightOz,
      });
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
