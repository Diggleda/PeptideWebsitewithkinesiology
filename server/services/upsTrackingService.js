const axios = require('axios');
const { logger } = require('../config/logger');

const UPS_TRACK_PAGE_URL = 'https://www.ups.com/track';
const UPS_TRACK_STATUS_API_URL = 'https://www.ups.com/track/api/Track/GetStatus';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // trackingNumber -> { expiresAt, value }

const safeString = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const deepGet = (obj, ...path) => {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur) && Number.isInteger(key)) {
      if (key < 0 || key >= cur.length) return null;
      cur = cur[key];
      continue;
    }
    if (typeof cur === 'object' && cur !== null) {
      cur = cur[key];
      continue;
    }
    return null;
  }
  return cur;
};

const sanitizeTrackingNumber = (value) => String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

const normalizeStatusToken = (value) => {
  const raw = safeString(value);
  if (!raw) return null;
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/_+/g, '_');
};

const mapStatusToPepPro = (rawStatus) => {
  const token = normalizeStatusToken(rawStatus);
  if (!token) return null;
  if (token.includes('delivered')) return 'delivered';
  if (token.includes('out_for_delivery') || token.includes('outfordelivery')) return 'out_for_delivery';
  if (token.includes('in_transit') || token.includes('intransit')) return 'in_transit';
  if (token.includes('label_created') || token.includes('labelcreated')) return 'label_created';
  if (token.includes('exception')) return 'exception';
  if (token.includes('shipped')) return 'shipped';
  return token;
};

const extractUpsStatus = (payload) => {
  const candidates = [
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'currentStatus', 'description'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'currentStatus', 'statusCode'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'activity', 0, 'status', 'description'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'activity', 0, 'status', 'statusCode'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'currentStatus', 'description'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'currentStatus', 'statusCode'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'statusType', 'description'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'statusType', 'statusCode'),
  ];
  for (const candidate of candidates) {
    const text = safeString(candidate);
    if (text) return text;
  }
  return null;
};

const extractDeliveredAt = (payload) => {
  const activities = deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'activity');
  if (!Array.isArray(activities)) return null;
  for (const entry of activities) {
    const statusDesc = safeString(deepGet(entry, 'status', 'description')) || '';
    if (statusDesc.toLowerCase().includes('delivered')) {
      return safeString(entry?.dateTime) || safeString(entry?.datetime) || safeString(entry?.date) || null;
    }
  }
  return null;
};

const buildCookieHeader = (setCookieHeader) => {
  const setCookies = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : (typeof setCookieHeader === 'string' ? [setCookieHeader] : []);
  const pairs = setCookies
    .map((cookie) => String(cookie || '').split(';')[0].trim())
    .filter(Boolean);
  return pairs.length ? pairs.join('; ') : '';
};

const parseCookieValue = (cookieHeader, name) => {
  if (!cookieHeader) return null;
  const parts = String(cookieHeader).split(';').map((part) => part.trim());
  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    if (key === name) {
      const value = rest.join('=');
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
};

const getCached = (trackingNumber) => {
  const entry = cache.get(trackingNumber);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(trackingNumber);
    return null;
  }
  return entry.value;
};

const setCached = (trackingNumber, value) => {
  cache.set(trackingNumber, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};

const fetchUpsTrackingStatus = async (trackingNumber) => {
  const normalized = sanitizeTrackingNumber(trackingNumber);
  if (!normalized) return null;

  const cached = getCached(normalized);
  if (cached) return cached;

  const client = axios.create({
    timeout: 15_000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: () => true,
  });

  try {
    const pageResp = await client.get(UPS_TRACK_PAGE_URL, {
      params: { loc: 'en_US', tracknum: normalized, requester: 'ST/trackdetails' },
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      maxRedirects: 5,
    });

    const cookieHeader = buildCookieHeader(pageResp.headers?.['set-cookie']);
    const xsrf = parseCookieValue(cookieHeader, 'XSRF-TOKEN') || parseCookieValue(cookieHeader, 'xsrf-token');

    const apiHeaders = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: 'https://www.ups.com',
      Referer: `${UPS_TRACK_PAGE_URL}?loc=en_US&tracknum=${normalized}&requester=ST/trackdetails`,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}),
    };

    const apiResp = await client.post(
      UPS_TRACK_STATUS_API_URL,
      { Locale: 'en_US', TrackingNumber: [normalized] },
      { params: { loc: 'en_US' }, headers: apiHeaders, maxRedirects: 0 },
    );

    if (apiResp.status < 200 || apiResp.status >= 300) {
      logger.warn({ status: apiResp.status, trackingNumber: normalized }, 'UPS tracking lookup failed');
      return null;
    }

    const payload = apiResp.data || {};
    const rawStatus = extractUpsStatus(payload);
    const mapped = mapStatusToPepPro(rawStatus);
    const deliveredAt = extractDeliveredAt(payload);

    const result = {
      carrier: 'ups',
      trackingNumber: normalized,
      trackingStatus: mapped,
      trackingStatusRaw: rawStatus,
      deliveredAt,
      checkedAt: new Date().toISOString(),
    };
    setCached(normalized, result);
    return result;
  } catch (error) {
    logger.warn({ err: error, trackingNumber: trackingNumber || null }, 'UPS tracking lookup errored');
    return null;
  }
};

module.exports = {
  fetchUpsTrackingStatus,
  sanitizeTrackingNumber,
};

