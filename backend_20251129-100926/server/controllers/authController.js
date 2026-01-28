const authService = require('../services/authService');
const { verifyDoctorNpi } = require('../services/npiService');

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
    const updated = await authService.updateProfile(req.user.id, req.body || {});
    res.json(updated);
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

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
  verifyNpi,
  updateProfile,
  requestPasswordReset,
  resetPassword,
};
