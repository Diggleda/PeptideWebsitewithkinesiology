const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const { getShopEnabled, setShopEnabled } = require('../services/settingsService');
const userRepository = require('../repositories/userRepository');

const router = Router();

const normalizeRole = (role) => (role || '').toLowerCase();
const isAdmin = (role) => normalizeRole(role) === 'admin';

const requireAdmin = (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = userRepository.findById(userId);
  const role = normalizeRole(user?.role);
  if (!isAdmin(role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.currentUser = user;
  return next();
};

router.get('/shop', async (_req, res) => {
  const enabled = await getShopEnabled();
  res.json({ shopEnabled: enabled });
});

router.put('/shop', authenticate, requireAdmin, async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const updated = await setShopEnabled(enabled);
  res.json({ shopEnabled: updated });
});

module.exports = router;
