let passkeyService;
const getPasskeyService = () => {
  if (!passkeyService) {
    // Lazy-load to avoid startup hangs if WebAuthn deps misbehave under Node.
    // Errors will be surfaced when passkey endpoints are hit.
    // eslint-disable-next-line global-require
    passkeyService = require('../services/passkeyService');
  }
  return passkeyService;
};

const registrationOptions = async (req, res, next) => {
  try {
    const service = getPasskeyService();
    const result = await service.generateOptionsForRegistration(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const verifyRegistration = async (req, res, next) => {
  try {
    const service = getPasskeyService();
    const result = await service.verifyRegistration(req.body, req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const authenticationOptions = async (req, res, next) => {
  try {
    const service = getPasskeyService();
    const result = await service.generateOptionsForAuthentication(req.body?.email || '');
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const verifyAuthentication = async (req, res, next) => {
  try {
    const service = getPasskeyService();
    const result = await service.verifyAuthentication(req.body);
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
