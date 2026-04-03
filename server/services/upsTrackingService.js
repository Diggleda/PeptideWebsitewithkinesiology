const axios = require('axios');
const crypto = require('crypto');
const { env } = require('../config/env');
const { logger } = require('../config/logger');

const UPS_CIE_BASE_URL = 'https://wwwcie.ups.com';
const UPS_PROD_BASE_URL = 'https://onlinetools.ups.com';
const UPS_TOKEN_PATH = '/security/v1/oauth/token';
const UPS_TRACK_PATH = '/api/track/v1/details';
const TRACKING_CACHE_TTL_MS = 5 * 60 * 1000;

const trackingCache = new Map(); // trackingNumber -> { value, expiresAt }
const tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

const safeString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const deepGet = (obj, ...path) => {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) {
      return null;
    }
    if (Array.isArray(current) && Number.isInteger(key)) {
      if (key < 0 || key >= current.length) {
        return null;
      }
      current = current[key];
      continue;
    }
    if (typeof current === 'object') {
      current = current[key];
      continue;
    }
    return null;
  }
  return current;
};

const sanitizeTrackingNumber = (value) => String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

const looksLikeUpsTrackingNumber = (value) => {
  const normalized = sanitizeTrackingNumber(value);
  return normalized.startsWith('1Z') && normalized.length >= 8;
};

const normalizeStatusToken = (value) => {
  const raw = safeString(value);
  if (!raw) {
    return null;
  }
  return raw
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const normalizeTrackingStatus = (value) => {
  const token = normalizeStatusToken(value);
  if (!token) {
    return null;
  }
  if (token.includes('delivered')) {
    return 'delivered';
  }
  if (token.includes('out_for_delivery') || token.includes('outfordelivery')) {
    return 'out_for_delivery';
  }
  if (['exception', 'delay', 'delayed', 'hold', 'held'].some((part) => token.includes(part))) {
    return 'exception';
  }
  if (
    [
      'label_created',
      'shipment_ready_for_ups',
      'order_processed',
      'billing_information_received',
      'manifest_picked_up',
      'shipment_information_received',
    ].some((part) => token.includes(part))
  ) {
    return 'label_created';
  }
  if (
    [
      'in_transit',
      'intransit',
      'on_the_way',
      'ontheway',
      'departed',
      'arrived',
      'pickup_scan',
      'origin_scan',
      'destination_scan',
      'processing_at_ups_facility',
      'loaded_on_delivery_vehicle',
      'received_by_post_office_for_delivery',
    ].some((part) => token.includes(part))
  ) {
    return 'in_transit';
  }
  return 'unknown';
};

const isConfigured = () => Boolean(env.ups?.clientId && env.ups?.clientSecret);

const resolveBaseUrl = () => (env.ups?.useCie === true ? UPS_CIE_BASE_URL : UPS_PROD_BASE_URL);

const getCachedTrackingStatus = (trackingNumber) => {
  const cached = trackingCache.get(trackingNumber);
  if (!cached) {
    return null;
  }
  if (Date.now() >= cached.expiresAt) {
    trackingCache.delete(trackingNumber);
    return null;
  }
  return cached.value;
};

const setCachedTrackingStatus = (trackingNumber, value) => {
  trackingCache.set(trackingNumber, {
    value,
    expiresAt: Date.now() + TRACKING_CACHE_TTL_MS,
  });
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getCachedAccessToken = () => {
  if (!tokenCache.accessToken || Date.now() >= tokenCache.expiresAt) {
    return null;
  }
  return tokenCache.accessToken;
};

const setCachedAccessToken = (accessToken, expiresIn) => {
  const ttlSeconds = parsePositiveInt(expiresIn, 3600);
  const refreshBufferSeconds = Math.max(30, Math.min(Math.trunc(ttlSeconds * 0.1), 300));
  tokenCache.accessToken = accessToken;
  tokenCache.expiresAt = Date.now() + (Math.max(30, ttlSeconds - refreshBufferSeconds) * 1000);
};

const requestAccessToken = async () => {
  if (!isConfigured()) {
    throw new Error('UPS credentials are not configured');
  }

  const clientId = String(env.ups.clientId);
  const clientSecret = String(env.ups.clientSecret);
  const merchantId = safeString(env.ups.merchantId);
  const authValue = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const response = await axios.post(
    `${resolveBaseUrl()}${UPS_TOKEN_PATH}`,
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      timeout: env.ups?.requestTimeoutMs || 15_000,
      validateStatus: () => true,
      headers: {
        Authorization: `Basic ${authValue}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
      },
    },
  );

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`UPS OAuth failed with status ${response.status}`);
    error.status = response.status;
    error.details = response.data;
    throw error;
  }

  const accessToken = safeString(response.data?.access_token);
  if (!accessToken) {
    throw new Error('UPS token response did not include access_token');
  }

  setCachedAccessToken(accessToken, response.data?.expires_in);
  return accessToken;
};

const getAccessToken = async () => {
  const cached = getCachedAccessToken();
  if (cached) {
    return cached;
  }
  return requestAccessToken();
};

const firstPackage = (payload) => {
  const pkg = deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0);
  return pkg && typeof pkg === 'object' ? pkg : {};
};

const extractStatusObject = (payload) => {
  const candidates = [
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'currentStatus'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'currentStatus'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'activity', 0, 'status'),
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') || {};
};

const extractUpsStatus = (payload) => {
  const pkg = firstPackage(payload);
  const statusObject = extractStatusObject(payload);
  const rawStatusCandidates = [
    statusObject?.simplifiedTextDescription,
    statusObject?.description,
    pkg?.statusDescription,
    pkg?.currentStatusDescription,
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'activity', 0, 'status', 'simplifiedTextDescription'),
    deepGet(payload, 'trackResponse', 'shipment', 0, 'package', 0, 'activity', 0, 'status', 'description'),
  ];
  const rawStatus = rawStatusCandidates.map(safeString).find(Boolean) || null;
  const statusCode = safeString(statusObject?.statusCode || statusObject?.code);
  return { rawStatus, statusCode };
};

const formatActivityDateTime = (dateValue, timeValue, gmtOffset = null) => {
  const dateText = safeString(dateValue);
  if (!dateText || dateText.length !== 8 || !/^\d{8}$/.test(dateText)) {
    return null;
  }
  const baseTime = (safeString(timeValue) || '000000').padStart(6, '0');
  if (!/^\d{6}$/.test(baseTime)) {
    return null;
  }
  const stamp =
    `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`
    + `T${baseTime.slice(0, 2)}:${baseTime.slice(2, 4)}:${baseTime.slice(4, 6)}`;
  const offsetText = safeString(gmtOffset);
  if (offsetText && /^[+-]\d{2}:\d{2}$/.test(offsetText)) {
    const withOffset = `${stamp}${offsetText}`;
    const parsed = Date.parse(withOffset);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : withOffset;
  }
  const parsed = Date.parse(`${stamp}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : stamp;
};

const extractDeliveredAt = (payload) => {
  const pkg = firstPackage(payload);
  const deliveryDates = Array.isArray(pkg?.deliveryDate) ? pkg.deliveryDate : [];
  const deliveredDateEntry = deliveryDates.find((entry) => entry && entry.type === 'DEL');
  const deliveredDate = deliveredDateEntry?.date || null;
  const deliveryTime = pkg?.deliveryTime && typeof pkg.deliveryTime === 'object' ? pkg.deliveryTime : null;
  if (deliveredDate && deliveryTime?.type === 'DEL') {
    const formatted = formatActivityDateTime(deliveredDate, deliveryTime?.endTime);
    if (formatted) {
      return formatted;
    }
  }
  if (deliveredDate) {
    const formatted = formatActivityDateTime(deliveredDate, '000000');
    if (formatted) {
      return formatted;
    }
  }

  const activities = Array.isArray(pkg?.activity) ? pkg.activity : [];
  for (const entry of activities) {
    const rawStatus =
      safeString(entry?.status?.simplifiedTextDescription)
      || safeString(entry?.status?.description)
      || '';
    if (normalizeTrackingStatus(rawStatus) !== 'delivered') {
      continue;
    }
    const formatted = formatActivityDateTime(
      entry?.gmtDate || entry?.date,
      entry?.gmtTime || entry?.time,
      entry?.gmtOffset,
    );
    if (formatted) {
      return formatted;
    }
  }
  return null;
};

const createTransactionId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
};

const fetchUpsTrackingStatus = async (trackingNumber) => {
  const normalized = sanitizeTrackingNumber(trackingNumber);
  if (!normalized || !isConfigured()) {
    return null;
  }

  const cached = getCachedTrackingStatus(normalized);
  if (cached) {
    return cached;
  }

  try {
    const accessToken = await getAccessToken();
    const response = await axios.get(
      `${resolveBaseUrl()}${UPS_TRACK_PATH}/${encodeURIComponent(normalized)}`,
      {
        timeout: env.ups?.requestTimeoutMs || 15_000,
        validateStatus: () => true,
        params: {
          locale: env.ups?.locale || 'en_US',
        },
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          transId: createTransactionId(),
          transactionSrc: env.ups?.transactionSrc || 'peppro',
        },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      logger.warn(
        { status: response.status, trackingNumber: normalized, body: response.data },
        'UPS tracking lookup failed',
      );
      return null;
    }

    const payload = response.data || {};
    const { rawStatus, statusCode } = extractUpsStatus(payload);
    const trackingStatus = normalizeTrackingStatus(rawStatus || statusCode);
    const result = {
      carrier: 'ups',
      trackingNumber: normalized,
      trackingStatus,
      trackingStatusRaw: rawStatus,
      trackingStatusCode: statusCode,
      deliveredAt: extractDeliveredAt(payload),
      checkedAt: new Date().toISOString(),
    };
    setCachedTrackingStatus(normalized, result);
    return result;
  } catch (error) {
    logger.warn({ err: error, trackingNumber: normalized }, 'UPS tracking lookup errored');
    return null;
  }
};

const clearCachesForTest = () => {
  trackingCache.clear();
  tokenCache.accessToken = null;
  tokenCache.expiresAt = 0;
};

module.exports = {
  clearCachesForTest,
  fetchUpsTrackingStatus,
  isConfigured,
  looksLikeUpsTrackingNumber,
  normalizeTrackingStatus,
  sanitizeTrackingNumber,
};
