const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const salesRepRepository = require('../repositories/salesRepRepository');
const { env } = require('../config/env');
const { verifyDoctorNpi, normalizeNpiNumber } = require('./npiService');

const BCRYPT_REGEX = /^\$2[abxy]\$/;

const sanitizeUser = (user) => {
  const {
    password,
    ...rest
  } = user;
  return rest;
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

  const user = userRepository.findByEmail(email);
  if (!user) {
    const error = new Error('EMAIL_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const validPassword = await comparePassword(password, user.password);
  if (!validPassword) {
    const error = new Error('INVALID_PASSWORD');
    error.status = 401;
    throw error;
  }

  const updated = userRepository.update({
    ...user,
    visits: (user.visits || 1) + 1,
    lastLoginAt: new Date().toISOString(),
  });

  const token = createAuthToken({ id: user.id, email: user.email });

  return {
    token,
    user: sanitizeUser(updated || user),
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

  const updated = userRepository.update(next) || next;
  return sanitizeUser(updated);
};

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
  updateProfile,
};
