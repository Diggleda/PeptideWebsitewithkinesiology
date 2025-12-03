const crypto = require('crypto');

const normalizeString = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const sanitizeShippingAddress = (address = {}) => ({
  name: normalizeString(address.name) || null,
  company: normalizeString(address.company) || null,
  addressLine1: normalizeString(address.addressLine1),
  addressLine2: normalizeString(address.addressLine2),
  city: normalizeString(address.city),
  state: normalizeString(address.state),
  postalCode: normalizeString(address.postalCode),
  country: normalizeString(address.country) || 'US',
  phone: normalizeString(address.phone) || null,
});

const isShippingAddressComplete = (address = {}) => Boolean(
  address.addressLine1
  && address.city
  && address.state
  && address.postalCode
  && address.country,
);

const ensureShippingAddress = (address) => {
  if (!address || typeof address !== 'object') {
    const error = new Error('Shipping address is required.');
    error.status = 400;
    throw error;
  }
  const sanitized = sanitizeShippingAddress(address);
  if (!isShippingAddressComplete(sanitized)) {
    const error = new Error('Shipping address must include street, city, state, postal code, and country.');
    error.status = 400;
    throw error;
  }
  return sanitized;
};

const normalizeAmount = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const ensureShippingTotal = (value) => {
  const normalized = normalizeAmount(value);
  if (normalized === null || normalized < 0) {
    const error = new Error('Shipping total must be provided after selecting a rate.');
    error.status = 400;
    throw error;
  }
  return normalized;
};

const hasCarrierOrService = (estimate = {}) => {
  if (!estimate || typeof estimate !== 'object') {
    return false;
  }
  return Boolean(
    normalizeString(estimate.serviceCode)
    || normalizeString(estimate.serviceType)
    || normalizeString(estimate.carrierId),
  );
};

const fallbackServiceTransitDays = [
  { pattern: /next[_-]?day|overnight|1day/i, days: 1 },
  { pattern: /(2nd|second)[_-]?day/i, days: 2 },
  { pattern: /(3rd|third|3)[_-]?day/i, days: 3 },
  { pattern: /(ground_saver|ground)/i, days: 5 },
];

const inferTransitDaysFromService = (serviceCode = '') => {
  if (!serviceCode) {
    return null;
  }
  const normalized = String(serviceCode).toLowerCase();
  for (const entry of fallbackServiceTransitDays) {
    if (entry.pattern.test(normalized)) {
      return entry.days;
    }
  }
  return null;
};

const calculateEstimatedArrivalDate = (estimate = {}, referenceDate) => {
  if (!estimate || typeof estimate !== 'object') {
    return null;
  }
  if (estimate.deliveryDateGuaranteed) {
    const guaranteedDate = new Date(estimate.deliveryDateGuaranteed);
    if (!Number.isNaN(guaranteedDate.getTime())) {
      return guaranteedDate.toISOString();
    }
  }
  const baseDate = referenceDate ? new Date(referenceDate) : new Date();
  if (Number.isNaN(baseDate.getTime())) {
    return null;
  }
  let deliveryDays = Number(estimate.estimatedDeliveryDays);
  if (!Number.isFinite(deliveryDays) || deliveryDays <= 0) {
    deliveryDays = inferTransitDaysFromService(
      estimate.serviceCode || estimate.serviceType || estimate.carrierId || '',
    );
  }
  if (!Number.isFinite(deliveryDays) || deliveryDays <= 0) {
    return null;
  }
  const projected = new Date(baseDate.getTime());
  projected.setDate(projected.getDate() + deliveryDays);
  return projected.toISOString();
};

const normalizeShippingEstimate = (estimate = {}) => {
  const normalizedCurrency = normalizeString(estimate.currency).toUpperCase();
  return {
    carrierId: normalizeString(estimate.carrierId) || null,
    serviceCode: normalizeString(estimate.serviceCode) || null,
    serviceType: normalizeString(estimate.serviceType) || null,
    estimatedDeliveryDays: Number.isFinite(Number(estimate.estimatedDeliveryDays))
      ? Number(estimate.estimatedDeliveryDays)
      : null,
    deliveryDateGuaranteed: estimate.deliveryDateGuaranteed || null,
    rate: normalizeAmount(estimate.rate),
    currency: normalizedCurrency || 'USD',
    addressFingerprint: normalizeString(estimate.addressFingerprint) || null,
  };
};

const ensureShippingEstimate = (estimate, { referenceDate } = {}) => {
  if (!estimate || typeof estimate !== 'object') {
    const error = new Error('Shipping rate selection is required.');
    error.status = 400;
    throw error;
  }
  if (!hasCarrierOrService(estimate)) {
    const error = new Error('Shipping rate is missing carrier/service information.');
    error.status = 400;
    throw error;
  }
  const normalized = normalizeShippingEstimate(estimate);
  if (!normalized.estimatedArrivalDate) {
    normalized.estimatedArrivalDate = calculateEstimatedArrivalDate(normalized, referenceDate);
  }
  if (!normalized.addressFingerprint) {
    const error = new Error('Shipping rate is missing address validation metadata. Please fetch rates again.');
    error.status = 400;
    throw error;
  }
  if (normalized.rate === null) {
    const error = new Error('Shipping rate must include a valid cost.');
    error.status = 400;
    throw error;
  }
  return normalized;
};

const createAddressFingerprint = (address) => {
  const sanitized = sanitizeShippingAddress(address);
  const parts = [
    sanitized.addressLine1,
    sanitized.addressLine2,
    sanitized.city,
    sanitized.state,
    sanitized.postalCode,
    sanitized.country,
  ]
    .map((part) => (part || '').toUpperCase())
    .join('|');

  return crypto.createHash('sha1').update(parts).digest('hex');
};

const ensureShippingData = ({ shippingAddress, shippingEstimate, shippingTotal }) => {
  const normalizedAddress = ensureShippingAddress(shippingAddress);
  const normalizedEstimate = ensureShippingEstimate(shippingEstimate);
  const normalizedTotal = ensureShippingTotal(shippingTotal);

  if (Math.abs(normalizedEstimate.rate - normalizedTotal) > 0.01) {
    const error = new Error('Shipping total does not match the selected rate.');
    error.status = 400;
    throw error;
  }

  const fingerprint = createAddressFingerprint(normalizedAddress);
  if (normalizedEstimate.addressFingerprint !== fingerprint) {
    const error = new Error('Shipping address changed after rates were calculated. Please fetch rates again.');
    error.status = 400;
    throw error;
  }

  return {
    shippingAddress: normalizedAddress,
    shippingEstimate: normalizedEstimate,
    shippingTotal: normalizedTotal,
  };
};

module.exports = {
  sanitizeShippingAddress,
  isShippingAddressComplete,
  ensureShippingAddress,
  normalizeAmount,
  ensureShippingTotal,
  normalizeShippingEstimate,
  ensureShippingEstimate,
  createAddressFingerprint,
  ensureShippingData,
  calculateEstimatedArrivalDate,
  inferTransitDaysFromService,
};
