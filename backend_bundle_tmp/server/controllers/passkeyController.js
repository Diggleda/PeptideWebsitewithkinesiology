const passkeyService = require('../services/passkeyService');

const registrationOptions = async (req, res, next) => {
  try {
    const result = await passkeyService.generateOptionsForRegistration(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const verifyRegistration = async (req, res, next) => {
  try {
    const result = await passkeyService.verifyRegistration(req.body, req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const authenticationOptions = async (req, res, next) => {
  try {
    const result = await passkeyService.generateOptionsForAuthentication(req.body?.email || '');
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const verifyAuthentication = async (req, res, next) => {
  try {
    const result = await passkeyService.verifyAuthentication(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
};
