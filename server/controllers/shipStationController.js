const { XMLParser } = require('fast-xml-parser');
const { logger } = require('../config/logger');
const { syncWooFromShipStation } = require('../services/shipStationSyncService');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

const flattenObject = (value, out = {}) => {
  if (value === null || value === undefined) {
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => flattenObject(entry, out));
    return out;
  }
  if (typeof value !== 'object') {
    return out;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (child === null || child === undefined) {
      return;
    }
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
      const str = String(child).trim();
      if (str) {
        const normalizedKey = String(key || '').trim().toLowerCase();
        if (normalizedKey) {
          out[normalizedKey] = out[normalizedKey] ?? str;
        }
      }
      return;
    }
    flattenObject(child, out);
  });
  return out;
};

const pick = (flat, ...keys) => {
  for (const key of keys) {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) continue;
    const value = flat?.[normalized];
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return null;
};

const parseShipStationWebhookBody = (req) => {
  const contentType = typeof req.headers?.['content-type'] === 'string' ? req.headers['content-type'] : '';
  const body = req.body;

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const flat = flattenObject(body, {});
    return {
      rawType: 'json',
      orderNumber: pick(flat, 'ordernumber', 'order_number', 'order', 'orderno', 'order_no'),
      shipStationOrderId: pick(flat, 'orderid', 'order_id', 'shipstationorderid', 'shipstation_order_id'),
      shipStationStatus: pick(flat, 'orderstatus', 'status', 'shipstationstatus', 'shipstation_status'),
      trackingNumber: pick(flat, 'trackingnumber', 'tracking_number', 'tracking'),
      carrierCode: pick(flat, 'carriercode', 'carrier_code', 'carrier', 'carriername'),
      shipDate: pick(flat, 'shipdate', 'shipmentdate', 'shipment_date', 'shippedat'),
    };
  }

  if (typeof body === 'string' && body.trim()) {
    const raw = body.trim();
    try {
      const parsed = xmlParser.parse(raw);
      const flat = flattenObject(parsed, {});
      return {
        rawType: contentType.includes('xml') ? 'xml' : 'text',
        orderNumber: pick(flat, 'ordernumber', 'order_number', 'order', 'orderno', 'order_no'),
        shipStationOrderId: pick(flat, 'orderid', 'order_id', 'shipstationorderid', 'shipstation_order_id'),
        shipStationStatus: pick(flat, 'orderstatus', 'status', 'shipstationstatus', 'shipstation_status'),
        trackingNumber: pick(flat, 'trackingnumber', 'tracking_number', 'tracking'),
        carrierCode: pick(flat, 'carriercode', 'carrier_code', 'carrier', 'carriername'),
        shipDate: pick(flat, 'shipdate', 'shipmentdate', 'shipment_date', 'shippedat'),
      };
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse ShipStation webhook body as XML');
      return {
        rawType: 'text',
        orderNumber: null,
        shipStationOrderId: null,
        shipStationStatus: null,
        trackingNumber: null,
        carrierCode: null,
        shipDate: null,
      };
    }
  }

  return {
    rawType: 'unknown',
    orderNumber: null,
    shipStationOrderId: null,
    shipStationStatus: null,
    trackingNumber: null,
    carrierCode: null,
    shipDate: null,
  };
};

const webhook = async (req, res, next) => {
  try {
    const parsed = parseShipStationWebhookBody(req);
    const orderNumber = parsed.orderNumber || null;
    const shipStationOrderId = parsed.shipStationOrderId || null;

    if (!orderNumber && !shipStationOrderId) {
      logger.warn(
        {
          rawType: parsed.rawType,
          contentType: req.headers?.['content-type'] || null,
        },
        'ShipStation webhook received without an order identifier',
      );
      // Return 200 so ShipStation doesn't retry indefinitely.
      return res.status(200).json({ ok: true, skipped: true, reason: 'missing_order_identifier' });
    }

    const result = await syncWooFromShipStation({
      orderNumber,
      shipStationOrderId,
      shipStationStatus: parsed.shipStationStatus || null,
      trackingNumber: parsed.trackingNumber || null,
      carrierCode: parsed.carrierCode || null,
      shipDate: parsed.shipDate || null,
    });

    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  webhook,
};
