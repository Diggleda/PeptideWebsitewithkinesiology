const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const userRepository = require('../repositories/userRepository');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = userRepository.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = { ...user, id: user.id || decoded.id, email: user.email || decoded.email || null };
    return next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticate };
