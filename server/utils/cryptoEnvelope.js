const crypto = require('crypto');
const { env } = require('../config/env');

const ENVELOPE_VERSION = 1;
const ENVELOPE_ALGORITHM = 'aes-256-gcm';

const stableSort = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSort(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableSort(value[key]);
        return acc;
      }, {});
  }
  return value;
};

const stableJson = (value) => JSON.stringify(stableSort(value));

const deriveKey = (secret) => {
  const raw = String(secret || '').trim();
  if (!raw) {
    throw new Error('DATA_ENCRYPTION_KEY is required for encrypted data access');
  }
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
      return decoded;
    }
  } catch (_error) {
    // ignore and fall back to a deterministic digest of the configured secret
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
};

const getMasterKey = () => deriveKey(env.encryption?.key);
const getBlindIndexKey = () => deriveKey(env.encryption?.blindIndexKey || env.encryption?.key);
const getKeyVersion = () => String(env.encryption?.keyVersion || 'local-v1').trim() || 'local-v1';
const getKmsKeyId = () => {
  const value = String(env.encryption?.kmsKeyId || '').trim();
  return value || null;
};

const canonicalAad = (aad) => {
  if (!aad || typeof aad !== 'object') {
    return Buffer.alloc(0);
  }
  return Buffer.from(stableJson(aad), 'utf8');
};

const wrapDataKey = (dataKey) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const aad = canonicalAad({
    purpose: 'wrapped_data_key',
    key_version: getKeyVersion(),
    kms_key_id: getKmsKeyId(),
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final(), cipher.getAuthTag()]);
  return {
    alg: ENVELOPE_ALGORITHM,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

const unwrapDataKey = (wrappedDataKey) => {
  if (!wrappedDataKey || typeof wrappedDataKey !== 'object') {
    throw new Error('wrapped_data_key must be an object');
  }
  const iv = Buffer.from(String(wrappedDataKey.iv || ''), 'base64');
  const ciphertext = Buffer.from(String(wrappedDataKey.ciphertext || ''), 'base64');
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const payload = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
  const aad = canonicalAad({
    purpose: 'wrapped_data_key',
    key_version: getKeyVersion(),
    kms_key_id: getKmsKeyId(),
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
};

const computeBlindIndex = (value, { label, normalizer } = {}) => {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return null;
  const normalized = typeof normalizer === 'function' ? normalizer(text) : text;
  return crypto
    .createHmac('sha256', getBlindIndexKey())
    .update(`${label || 'default'}:${normalized}`, 'utf8')
    .digest('hex');
};

const encryptText = (value, { aad, blindIndex } = {}) => {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return null;
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const aadBuffer = canonicalAad(aad);
  if (aadBuffer.length) {
    cipher.setAAD(aadBuffer);
  }
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    version: ENVELOPE_VERSION,
    alg: ENVELOPE_ALGORITHM,
    kms_key_id: getKmsKeyId(),
    key_version: getKeyVersion(),
    wrapped_data_key: wrapDataKey(dataKey),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    aad: aad && typeof aad === 'object' ? stableSort(aad) : {},
  };
  if (blindIndex) {
    envelope.blind_index = blindIndex;
  }
  return JSON.stringify(envelope);
};

const decryptText = (value, { aad } = {}) => {
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value).trim();
  if (!text) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    return text;
  }
  if (!payload || typeof payload !== 'object') {
    return text;
  }

  if (payload.version === ENVELOPE_VERSION && payload.wrapped_data_key) {
    const dataKey = unwrapDataKey(payload.wrapped_data_key);
    const iv = Buffer.from(String(payload.iv || ''), 'base64');
    const ciphertext = Buffer.from(String(payload.ciphertext || ''), 'base64');
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
    const aadBuffer = canonicalAad(aad || payload.aad || {});
    if (aadBuffer.length) {
      decipher.setAAD(aadBuffer);
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  if (payload.iv && payload.payload) {
    const iv = Buffer.from(String(payload.iv || ''), 'base64');
    const ciphertext = Buffer.from(String(payload.payload || ''), 'base64');
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  return text;
};

const encryptJson = (value, options = {}) => {
  if (value === null || value === undefined) return null;
  return encryptText(stableJson(value), options);
};

const decryptJson = (value, options = {}) => {
  const text = decryptText(value, options);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
};

module.exports = {
  ENVELOPE_ALGORITHM,
  ENVELOPE_VERSION,
  computeBlindIndex,
  decryptJson,
  decryptText,
  encryptJson,
  encryptText,
};
