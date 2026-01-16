const shipEngineClient = require('../integration/shipEngineClient');
const shipStationClient = require('../integration/shipStationClient');
const { ensureShippingAddress, createAddressFingerprint } = require('../services/shippingValidation');
const { logger } = require('../config/logger');
const { env } = require('../config/env');

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

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isFallbackEnabled = () => {
  const configured = String(process.env.SHIPPING_FALLBACK_ENABLED || '').toLowerCase().trim();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return env.nodeEnv !== 'production';
};

const buildFallbackRates = () => {
  const rate = Math.max(0, toNumber(process.env.SHIPPING_FALLBACK_RATE, 0));
  return [
    {
      carrierId: 'manual',
      serviceCode: 'fallback',
      serviceType: 'Standard Shipping',
      estimatedDeliveryDays: null,
      deliveryDateGuaranteed: null,
      rate,
      currency: 'USD',
      fallback: true,
    },
  ];
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

    const addressFingerprint = createAddressFingerprint(normalizedAddress);

    // Prefer ShipStation; fall back to ShipEngine on failure.
    let rates;
    try {
      if (shipStationClient.isConfigured()) {
        rates = await shipStationClient.estimateRates({
          shippingAddress: normalizedAddress,
          items,
          totalWeightOz,
        });
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
    } catch (primaryError) {
      const primaryStatus = Number.isFinite(primaryError?.status)
        ? primaryError.status
        : (primaryError?.response?.status ?? null);

      if (shipStationClient.isConfigured() && shipEngineClient.isConfigured()) {
        try {
          rates = await shipEngineClient.estimateRates({
            shippingAddress: normalizedAddress,
            items,
            totalWeightOz,
          });
        } catch (secondaryError) {
          const fallbackAllowed = isFallbackEnabled();
          if (primaryStatus === 400) {
            throw primaryError;
          }
          if (!fallbackAllowed) {
            throw secondaryError;
          }
          logger.warn(
            { err: secondaryError },
            'Shipping rate providers failed; returning fallback rate',
          );
          return res.json({
            success: true,
            rates: buildFallbackRates().map((rate) => ({ ...rate, addressFingerprint })),
            addressFingerprint,
            warning: 'Shipping rates are temporarily unavailable. Using a fallback rate.',
          });
        }
      } else {
        const fallbackAllowed = isFallbackEnabled();
        if (primaryStatus === 400) {
          throw primaryError;
        }
        if (!fallbackAllowed) {
          throw primaryError;
        }
        logger.warn(
          { err: primaryError },
          'Shipping rate provider failed; returning fallback rate',
        );
        return res.json({
          success: true,
          rates: buildFallbackRates().map((rate) => ({ ...rate, addressFingerprint })),
          addressFingerprint,
          warning: 'Shipping rates are temporarily unavailable. Using a fallback rate.',
        });
      }
    }
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
