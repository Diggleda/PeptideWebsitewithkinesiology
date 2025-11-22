const shipEngineClient = require('../integration/shipEngineClient');
const { logger } = require('../config/logger');

const validateItems = (items) => Array.isArray(items)
  && items.every((item) => Number(item?.quantity) > 0);

const getRates = async (req, res, next) => {
  try {
    if (!shipEngineClient.isConfigured()) {
      const error = new Error('Shipping is not configured');
      error.status = 503;
      throw error;
    }

    const { shippingAddress, items } = req.body || {};

    if (!validateItems(items || [])) {
      const error = new Error('At least one item with quantity is required to price shipping');
      error.status = 400;
      throw error;
    }

    const rates = await shipEngineClient.estimateRates({
      shippingAddress,
      items,
    });

    res.json({
      success: true,
      rates,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch shipping rates');
    next(error);
  }
};

module.exports = {
  getRates,
};
