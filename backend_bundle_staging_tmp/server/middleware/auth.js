const { logger } = require('../config/logger');

const normalizeRole = (role) => (role || '').toString().trim().toLowerCase();

const ensureAdmin = (req, res, next) => {
  const role = normalizeRole(req.user?.role);
  if (req.user && role === 'admin') {
    return next();
  }
  logger.warn(
    {
      context: 'ensureAdmin',
      userId: req.user?.id || null,
      role: req.user?.role || null,
    },
    'Admin access required but not satisfied',
  );
  const error = new Error('Admin access required');
  error.status = 403;
  next(error);
};

module.exports = {
  ensureAdmin,
};
