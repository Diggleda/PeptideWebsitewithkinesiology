const authService = require('../services/authService');
const { verifyDoctorNpi } = require('../services/npiService');
const { logger } = require('../config/logger');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const userRepository = require('../repositories/userRepository');

const register = async (req, res, next) => {
  try {
    const { token, user } = await authService.register(req.body);
    res.json({ token, user });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { token, user } = await authService.login(req.body);
    res.json({ token, user });
  } catch (error) {
    next(error);
  }
};

const checkEmail = (req, res, next) => {
  try {
    const result = authService.checkEmail(req.query.email);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const getProfile = (req, res, next) => {
  try {
    const result = authService.getProfile(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const verifyNpi = async (req, res, next) => {
  try {
    await verifyDoctorNpi(req.body?.npiNumber);
    res.json({ status: 'verified' });
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'profileImageUrl')) {
      logger.info(
        {
          userId: req.user?.id || null,
          hasImage: typeof req.body.profileImageUrl === 'string' && req.body.profileImageUrl.length > 0,
          imageBytes: typeof req.body.profileImageUrl === 'string'
            ? Buffer.byteLength(req.body.profileImageUrl)
            : 0,
        },
        'Received profile image update payload',
      );
    }
    const updated = await authService.updateProfile(req.user.id, req.body || {});
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

const deleteAccount = async (req, res, next) => {
  try {
    const result = await authService.deleteAccount(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const requestPasswordReset = async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!email) {
      const error = new Error('EMAIL_REQUIRED');
      error.status = 400;
      throw error;
    }
    await authService.requestPasswordReset(email);
    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!token || !password) {
      const error = new Error('TOKEN_AND_PASSWORD_REQUIRED');
      error.status = 400;
      throw error;
    }
    await authService.resetPassword({ token, password });
    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const header = req.headers?.authorization || '';
    if (!header) {
      return res.json({ ok: true });
    }
    const parts = header.split(' ');
    const token = (parts.length === 2 ? parts[1] : parts[0]).trim();
    if (!token) {
      return res.json({ ok: true });
    }

    let decoded = null;
    try {
      decoded = jwt.verify(token, env.jwtSecret);
    } catch (error) {
      if (error && error.name === 'TokenExpiredError') {
        try {
          decoded = jwt.verify(token, env.jwtSecret, { ignoreExpiration: true });
        } catch {
          decoded = null;
        }
      } else {
        decoded = null;
      }
    }

    const userId = decoded?.id ? String(decoded.id) : '';
    if (!userId) {
      return res.json({ ok: true });
    }

    const user = userRepository.findById(userId);
    if (user) {
      // Force offline immediately by pushing lastSeenAt outside the online window.
      // Presence endpoints derive online from timestamps, so setting lastSeenAt to epoch ensures offline.
      const epochIso = new Date(0).toISOString();
      userRepository.update({
        ...user,
        isOnline: false,
        isIdle: false,
        lastSeenAt: epochIso,
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
  verifyNpi,
  updateProfile,
  deleteAccount,
  logout,
  requestPasswordReset,
  resetPassword,
};
