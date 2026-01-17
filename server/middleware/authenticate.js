const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const userRepository = require('../repositories/userRepository');
const { logger } = require('../config/logger');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    logger.warn({ path: req.path, method: req.method }, 'Auth failed: missing Authorization header');
    return res.status(401).json({ error: 'Access token required' });
  }

  const [scheme, rawToken] = authHeader.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !rawToken) {
    logger.warn({ path: req.path, method: req.method }, 'Auth failed: malformed Authorization header');
    return res.status(401).json({ error: 'Access token required' });
  }

  const token = rawToken.trim();

  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = userRepository.findById(decoded.id);
    if (!user) {
      logger.warn({ path: req.path, method: req.method, userId: decoded.id }, 'Auth failed: user not found for token');
      return res.status(401).json({ error: 'User not found' });
    }
    const nowMs = Date.now();
    const sessionMaxMs = 24 * 60 * 60 * 1000; // 24 hours
    const idleMaxMs = 60 * 60 * 1000; // 1 hour

    const issuedAtMs = typeof decoded?.iat === 'number' && Number.isFinite(decoded.iat)
      ? decoded.iat * 1000
      : NaN;
    if (Number.isFinite(issuedAtMs) && nowMs - issuedAtMs >= sessionMaxMs) {
      logger.info(
        { path: req.path, method: req.method, userId: decoded.id, issuedAtMs },
        'Auth revoked: token max age exceeded',
      );
      return res.status(401).json({ error: 'Session expired', code: 'SESSION_MAX_AGE' });
    }

    const lastLoginMs = user?.lastLoginAt ? Date.parse(user.lastLoginAt) : NaN;
    if (!Number.isFinite(issuedAtMs) && Number.isFinite(lastLoginMs) && nowMs - lastLoginMs >= sessionMaxMs) {
      logger.info(
        { path: req.path, method: req.method, userId: decoded.id, lastLoginAt: user.lastLoginAt },
        'Auth revoked: session max age exceeded',
      );
      return res.status(401).json({ error: 'Session expired', code: 'SESSION_MAX_AGE' });
    }

    const lastInteractionMs = user?.lastInteractionAt ? Date.parse(user.lastInteractionAt) : NaN;
    // Idle should be driven by explicit user interactions, not presence heartbeats (`lastSeenAt`).
    // Fall back to the session start (login / token issuance) when we don't have interactions yet.
    const idleAnchorMs = Number.isFinite(lastInteractionMs)
      ? lastInteractionMs
      : (Number.isFinite(lastLoginMs) ? lastLoginMs : issuedAtMs);
    if (Number.isFinite(idleAnchorMs) && nowMs - idleAnchorMs >= idleMaxMs) {
      logger.info(
        {
          path: req.path,
          method: req.method,
          userId: decoded.id,
          lastInteractionAt: user.lastInteractionAt || null,
          lastSeenAt: user.lastSeenAt || null,
        },
        'Auth revoked: idle timeout exceeded',
      );
      return res.status(401).json({ error: 'Session expired', code: 'SESSION_IDLE_TIMEOUT' });
    }
    req.user = { ...user, id: user.id || decoded.id, email: user.email || decoded.email || null };
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.warn({ path: req.path, method: req.method, message: error.message }, 'Auth failed: token expired');
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (error.name === 'JsonWebTokenError') {
      logger.warn({ path: req.path, method: req.method, message: error.message }, 'Auth failed: invalid token');
      return res.status(403).json({ error: 'Invalid token signature', code: 'TOKEN_INVALID' });
    }
    logger.error({ path: req.path, method: req.method, err: error }, 'Auth failed: unexpected verify error');
    return res.status(403).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticate };
