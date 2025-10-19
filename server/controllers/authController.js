const authService = require('../services/authService');

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

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
};
