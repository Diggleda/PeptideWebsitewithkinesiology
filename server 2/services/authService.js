const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const { env } = require('../config/env');

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

const register = async ({ name, email, password }) => {
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

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
};
