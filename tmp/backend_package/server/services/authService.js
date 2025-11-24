const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const salesRepRepository = require('../repositories/salesRepRepository');
const { env } = require('../config/env');
const { verifyDoctorNpi, normalizeNpiNumber } = require('./npiService');
const { logger } = require('../config/logger');

const BCRYPT_REGEX = /^\$2[abxy]\$/;

const DIRECT_SHIPPING_FIELDS = [
  'officeAddressLine1',
  'officeAddressLine2',
  'officeCity',
  'officeState',
  'officePostalCode',
];

const supportsHrtimeBigint = typeof process.hrtime === 'function'
  && typeof process.hrtime.bigint === 'function';

const startTimer = () => (supportsHrtimeBigint
  ? process.hrtime.bigint()
  : process.hrtime());

const elapsedMs = (start) => {
  if (supportsHrtimeBigint && typeof start === 'bigint') {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }
  const diff = process.hrtime(start);
  return (diff[0] * 1e3) + (diff[1] / 1e6);
};

const formatMs = (value) => Math.round(value * 100) / 100;

const maskEmailForLog = (value) => {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown';
  }
  const [local, domain] = trimmed.split('@');
  if (!domain) {
    if (local.length <= 1) {
      return `${local || '*'}***`;
    }
    if (local.length === 2) {
      return `${local[0]}*`;
    }
    return `${local.slice(0, 2)}***`;
  }
  if (local.length <= 1) {
    return `*@${domain}`;
  }
  if (local.length === 2) {
    return `${local[0]}*@${domain}`;
  }
  return `${local.slice(0, 2)}***@${domain}`;
};

const normalizeOptionalString = (value) => {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    return String(value).trim() || null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeUser = (user) => {
  const {
    password,
    passkeys,
    ...rest
  } = user;
  return {
    ...rest,
    hasPasskeys: Array.isArray(passkeys) && passkeys.length > 0,
  };
};

const normalizeHumanName = (value = '') =>
  String(value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const HONORIFIC_TOKENS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sir', 'madam']);
const SUFFIX_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

const tokenizeName = (value = '') =>
  normalizeHumanName(value)
    .split(' ')
    .map((token) => token.replace(/[.,]/g, ''))
    .filter(
      (token) =>
        token &&
        !HONORIFIC_TOKENS.has(token) &&
        !SUFFIX_TOKENS.has(token),
    );

const namesRoughlyMatch = (a = '', b = '') => {
  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (!tokensA.length || !tokensB.length) {
    return false;
  }
  if (tokensA.join(' ') === tokensB.join(' ')) {
    return true;
  }
  const firstA = tokensA[0];
  const lastA = tokensA[tokensA.length - 1];
  const firstB = tokensB[0];
  const lastB = tokensB[tokensB.length - 1];
  if (!firstA || !lastA || !firstB || !lastB) {
    return false;
  }
  if (firstA !== firstB || lastA !== lastB) {
    return false;
  }
  const middleA = tokensA.slice(1, -1).join(' ');
  const middleB = tokensB.slice(1, -1).join(' ');
  if (!middleA || !middleB) {
    return true;
  }
  return middleA === middleB;
};

const createAuthToken = (payload) => jwt.sign(payload, env.jwtSecret, { expiresIn: '7d' });

const comparePassword = async (plainText, hashed) => {
  if (typeof hashed !== 'string' || !BCRYPT_REGEX.test(hashed)) {
    // Treat malformed hashes as invalid credentials instead of throwing
    return false;
  }
  try {
    return await bcrypt.compare(plainText, hashed);
  } catch (error) {
    if (error instanceof Error && /invalid salt/i.test(error.message)) {
      return false;
    }
    throw error;
  }
};

const createError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const register = async ({
  name,
  email,
  password,
  npiNumber,
}) => {
  if (!name || !email || !password) {
    const error = new Error('All fields are required');
    error.status = 400;
    throw error;
  }

  const existing = userRepository.findByEmail(email);
  if (existing) {
    const error = new Error('EMAIL_EXISTS');
    error.status = 409;
    throw error;
  }

  const salesRepAccount = salesRepRepository.findByEmail(email);
  const isSalesRepEmail = Boolean(salesRepAccount);

  const normalizedNpi = normalizeNpiNumber(npiNumber);
  const hasValidNpi = /^\d{10}$/.test(normalizedNpi);

  if (!isSalesRepEmail && !hasValidNpi) {
    throw createError('NPI_INVALID', 400);
  }

  if (hasValidNpi) {
    const existingNpi = userRepository.findByNpiNumber(normalizedNpi);
    if (existingNpi) {
      throw createError('NPI_ALREADY_REGISTERED', 409);
    }
  }

  const npiVerification = hasValidNpi
    ? await verifyDoctorNpi(normalizedNpi)
    : null;

  if (!isSalesRepEmail && npiVerification?.name) {
    if (!namesRoughlyMatch(name, npiVerification.name)) {
      throw createError('NPI_NAME_MISMATCH', 422);
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();

  const user = userRepository.insert({
    id: Date.now().toString(),
    name,
    email,
    password: hashedPassword,
    referralCode: referralService.generateReferralCode(),
    referralCredits: 0,
    totalReferrals: 0,
    visits: 1,
    createdAt: now,
    lastLoginAt: now,
    role: isSalesRepEmail ? 'sales_rep' : 'doctor',
    salesRepId: isSalesRepEmail
      ? salesRepAccount?.id
        || salesRepAccount?.legacyUserId
        || salesRepAccount?.salesRepId
        || null
      : null,
    npiNumber: npiVerification ? npiVerification.npiNumber : null,
    npiLastVerifiedAt: npiVerification ? now : null,
    npiVerification: npiVerification
      ? {
        name: npiVerification.name,
        credential: npiVerification.credential,
        enumerationType: npiVerification.enumerationType,
        primaryTaxonomy: npiVerification.primaryTaxonomy,
        organizationName: npiVerification.organizationName,
      }
      : null,
  });

  const token = createAuthToken({ id: user.id, email: user.email });

  return {
    token,
    user: sanitizeUser(user),
  };
};

const login = async ({ email, password }) => {
  if (!email || !password) {
    const error = new Error('Email and password required');
    error.status = 400;
    throw error;
  }

  const maskedEmail = maskEmailForLog(email);
  const totalStart = startTimer();
  const lookupStart = startTimer();
  const user = userRepository.findByEmail(email);
  const lookupMs = elapsedMs(lookupStart);

  if (!user) {
    logger.warn(
      { email: maskedEmail, lookupMs: formatMs(lookupMs) },
      'AuthService login email lookup failed',
    );
    const error = new Error('EMAIL_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const passwordStart = startTimer();
  const validPassword = await comparePassword(password, user.password);
  const passwordMs = elapsedMs(passwordStart);

  if (!validPassword) {
    logger.warn(
      { email: maskedEmail, passwordMs: formatMs(passwordMs) },
      'AuthService login invalid password',
    );
    const error = new Error('INVALID_PASSWORD');
    error.status = 401;
    throw error;
  }

  const persistStart = startTimer();
  const updated = userRepository.update({
    ...user,
    visits: (user.visits || 1) + 1,
    lastLoginAt: new Date().toISOString(),
  });
  const persistMs = elapsedMs(persistStart);

  const token = createAuthToken({ id: user.id, email: user.email });
  const totalMs = elapsedMs(totalStart);
  const sanitizedUser = sanitizeUser(updated || user);

  logger.debug(
    {
      email: maskedEmail,
      userId: sanitizedUser.id,
      lookupMs: formatMs(lookupMs),
      passwordMs: formatMs(passwordMs),
      persistMs: formatMs(persistMs),
      totalMs: formatMs(totalMs),
    },
    'AuthService login timings',
  );

  return {
    token,
    user: sanitizedUser,
  };
};

const checkEmail = (email) => {
  if (!email) {
    const error = new Error('EMAIL_REQUIRED');
    error.status = 400;
    throw error;
  }
  const exists = Boolean(userRepository.findByEmail(email));
  return { exists };
};

const getProfile = (userId) => {
  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }
  return sanitizeUser(user);
};

const updateProfile = async (userId, data) => {
  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  const next = { ...user };
  if (typeof data.name === 'string' && data.name.trim()) next.name = data.name.trim();
  if (typeof data.phone === 'string') next.phone = data.phone.trim();
  if (typeof data.email === 'string' && data.email.trim() && data.email.trim() !== user.email) {
    const existing = userRepository.findByEmail(data.email.trim());
    if (existing && existing.id !== user.id) {
      const error = new Error('EMAIL_EXISTS');
      error.status = 409;
      throw error;
    }
    next.email = data.email.trim();
  }

  DIRECT_SHIPPING_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      next[field] = normalizeOptionalString(data[field]);
    }
  });

  const updated = userRepository.update(next) || next;

  if (updated.role === 'sales_rep' && updated.salesRepId) {
    salesRepRepository.update({
      id: updated.salesRepId,
      phone: updated.phone,
    });
  }

  return sanitizeUser(updated);
};

const crypto = require('crypto');
const emailService = require('./emailService');

// In-memory store for password reset tokens.
// TODO: Replace this with a database table.
const passwordResetTokens = new Map();

const requestPasswordReset = async (email) => {
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';

  if (!normalizedEmail) {
    throw createError('EMAIL_REQUIRED', 400);
  }

  const lookupEmails = [normalizedEmail];
  const lowered = normalizedEmail.toLowerCase();
  if (!lookupEmails.includes(lowered)) {
    lookupEmails.push(lowered);
  }

  const user = lookupEmails
    .map((candidate) => userRepository.findByEmail(candidate))
    .find(Boolean);
  if (!user) {
    // Don't reveal if a user doesn't exist.
    // Just log it and return successfully.
    logger.info({ email: maskEmailForLog(normalizedEmail) }, 'Password reset request for non-existent user');
    return null;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 3600000; // 1 hour

  passwordResetTokens.set(token, { userId: user.id, expires });

  await emailService.sendPasswordResetEmail(user.email || normalizedEmail, token);
  return { token };
};

const resetPassword = async ({ token, password }) => {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const nextPassword = typeof password === 'string' ? password.trim() : '';

  if (!normalizedToken) {
    throw createError('TOKEN_REQUIRED', 400);
  }

  if (!nextPassword) {
    throw createError('PASSWORD_REQUIRED', 400);
  }

  const tokenData = passwordResetTokens.get(normalizedToken);

  if (!tokenData || tokenData.expires < Date.now()) {
    throw createError('Invalid or expired password reset token', 400);
  }

  const user = userRepository.findById(tokenData.userId);
  if (!user) {
    throw createError('User not found', 404);
  }

  const hashedPassword = await bcrypt.hash(nextPassword, 10);
  userRepository.update({ ...user, password: hashedPassword, mustResetPassword: false });

  passwordResetTokens.delete(normalizedToken);
};

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
  updateProfile,
  sanitizeUser,
  createAuthToken,
  requestPasswordReset,
  resetPassword,
};
