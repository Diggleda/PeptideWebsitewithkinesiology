const { Router } = require('express');
const wooController = require('../controllers/wooController');
const wooCommerceClient = require('../integration/wooCommerceClient');
const { authenticate } = require('../middleware/authenticate');
const orderRepository = require('../repositories/orderRepository');
const userRepository = require('../repositories/userRepository');

const router = Router();
const MODEL_VERSION = 'heuristic-v1-node-fallback';
const SIMULATION_MODEL_VERSION = 'heuristic-v1-node-simulation';
const DEFAULT_SIMULATION_EMAILS = ['diggledadiggz@gmail.com'];

const recommendationsEnabled = () => {
  const raw = String(process.env.RECOMMENDATIONS_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
};

const normalizeRole = (role) => String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const isDoctorRole = (role) => ['doctor', 'test_doctor'].includes(normalizeRole(role));
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const simulationEmails = () => new Set(
  String(process.env.RECOMMENDATION_SIMULATION_EMAILS || DEFAULT_SIMULATION_EMAILS.join(','))
    .split(',')
    .map((entry) => normalizeEmail(entry))
    .filter(Boolean),
);
const isSimulationUser = (user) => simulationEmails().has(normalizeEmail(user?.email));
const canReadRecommendations = (user) => isDoctorRole(user?.role) || isSimulationUser(user);

const parsePositiveInt = (value) => {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed > 0 ? parsed : null;
  }
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const parsed = Number.parseInt(text, 10);
    return parsed > 0 ? parsed : null;
  }
  const match = text.match(/^woo-(?:product-)?(\d+)$/i) || text.match(/^product-(\d+)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return parsed > 0 ? parsed : null;
};

const orderItems = (order) => {
  if (Array.isArray(order?.items)) return order.items.filter((item) => item && typeof item === 'object');
  if (Array.isArray(order?.lineItems)) return order.lineItems.filter((item) => item && typeof item === 'object');
  return [];
};

const itemProductId = (item) => (
  parsePositiveInt(item?.wooProductId)
  || parsePositiveInt(item?.productWooId)
  || parsePositiveInt(item?.productId)
  || parsePositiveInt(item?.product_id)
  || parsePositiveInt(item?.id)
);

const itemQuantity = (item) => Math.max(1, Math.floor(Number(item?.quantity || item?.qty || 1) || 1));

const normalizeFilterKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const containsSubscription = (value) => String(value || '').trim().toLowerCase().includes('subscription');

const isExcludedCatalogProduct = (product) => {
  const status = String(product?.status || '').trim().toLowerCase();
  if (status && status !== 'publish') return true;
  if (containsSubscription(product?.type) || containsSubscription(product?.name)) return true;

  for (const category of Array.isArray(product?.categories) ? product.categories : []) {
    const name = category?.name;
    const slug = category?.slug;
    if (containsSubscription(name) || containsSubscription(slug)) return true;
    if (normalizeFilterKey(name) === 'add-on' || normalizeFilterKey(slug) === 'add-on') return true;
  }

  return normalizeFilterKey(product?.sku) === 'add-on' || normalizeFilterKey(product?.slug) === 'add-on';
};

const fetchCatalogSimulationCandidates = async (limit) => {
  const candidates = [];
  const seen = new Set();
  const safeLimit = Math.max(3, Math.min(Number(limit) || 100, 100));

  for (let page = 1; page <= 4 && candidates.length < safeLimit; page += 1) {
    const products = await wooCommerceClient.fetchCatalog('products', {
      per_page: 100,
      page,
      status: 'publish',
      orderby: 'id',
      order: 'asc',
    });
    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      const productId = parsePositiveInt(product?.id);
      if (!productId || seen.has(productId) || isExcludedCatalogProduct(product)) continue;
      seen.add(productId);
      candidates.push({
        productId,
        name: String(product?.name || '').trim(),
      });
      if (candidates.length >= safeLimit) break;
    }

    if (products.length < 100) break;
  }

  return candidates;
};

const buildRecommendations = (user, limit) => {
  const scores = new Map();
  const reasons = new Map();
  const addScore = (productId, amount, reason) => {
    if (!productId || !Number.isFinite(amount) || amount === 0) return;
    scores.set(productId, (scores.get(productId) || 0) + amount);
    if (!reasons.has(productId)) reasons.set(productId, new Set());
    reasons.get(productId).add(reason);
  };

  const userId = String(user?.id || '').trim();
  const allUsers = userRepository.getAll();
  const roleByUserId = new Map(allUsers.map((entry) => [String(entry?.id || ''), normalizeRole(entry?.role)]));
  const userOrders = orderRepository.findByUserId(userId);
  const purchased = new Set();

  for (const order of userOrders) {
    for (const item of orderItems(order)) {
      const productId = itemProductId(item);
      if (!productId) continue;
      purchased.add(productId);
      addScore(productId, 72 + 10 * Math.log1p(itemQuantity(item)), 'repeat_purchase');
    }
  }

  for (const item of Array.isArray(user?.cart) ? user.cart : []) {
    const productId = itemProductId(item);
    if (!productId) continue;
    addScore(productId, 82 + 8 * Math.log1p(itemQuantity(item)), 'cart_intent');
  }

  const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const globalQuantity = new Map();
  const coPurchaseCounts = new Map();
  for (const order of orderRepository.getAll()) {
    const orderUserId = String(order?.userId || order?.user_id || '').trim();
    const role = roleByUserId.get(orderUserId);
    if (role && !isDoctorRole(role)) continue;
    const createdMs = Date.parse(order?.createdAt || order?.created_at || '');
    if (Number.isFinite(createdMs) && createdMs < cutoffMs) continue;
    const productIds = new Set();
    for (const item of orderItems(order)) {
      const productId = itemProductId(item);
      if (!productId) continue;
      productIds.add(productId);
      globalQuantity.set(productId, (globalQuantity.get(productId) || 0) + itemQuantity(item));
    }
    if (orderUserId && orderUserId !== userId && purchased.size > 0) {
      const overlaps = [...productIds].some((productId) => purchased.has(productId));
      if (overlaps) {
        for (const productId of productIds) {
          if (!purchased.has(productId)) {
            coPurchaseCounts.set(productId, (coPurchaseCounts.get(productId) || 0) + 1);
          }
        }
      }
    }
  }

  for (const [productId, count] of coPurchaseCounts.entries()) {
    addScore(productId, Math.min(44, 14 * Math.log1p(count)), 'similar_physicians');
  }
  for (const [productId, quantity] of globalQuantity.entries()) {
    addScore(productId, Math.min(30, 5 * Math.log1p(quantity)), 'global_popularity');
  }

  const recommendations = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([productId, score]) => ({
      productId: `woo-${productId}`,
      wooProductId: productId,
      score: Math.round((score + Number.EPSILON) * 1_000_000) / 1_000_000,
      reasons: [...(reasons.get(productId) || [])].sort(),
      modelVersion: MODEL_VERSION,
    }));

  return {
    recommendations,
    modelVersion: MODEL_VERSION,
    fallback: purchased.size === 0,
    fallbackReason: purchased.size === 0 && recommendations.length > 0 ? 'cold_start_global_popularity' : null,
  };
};

const buildSimulatedRecommendations = async (user, existingResult, limit) => {
  if (!isSimulationUser(user)) {
    return existingResult;
  }

  const existing = Array.isArray(existingResult?.recommendations)
    ? existingResult.recommendations
    : [];
  const existingIds = new Set(
    existing
      .map((entry) => parsePositiveInt(entry?.wooProductId) || parsePositiveInt(entry?.productId))
      .filter(Boolean),
  );

  const candidates = await fetchCatalogSimulationCandidates(limit);
  const simulated = candidates
    .filter((candidate) => !existingIds.has(candidate.productId))
    .map((candidate, index) => ({
      productId: `woo-${candidate.productId}`,
      wooProductId: candidate.productId,
      score: Math.max(50, 415 - index * 22),
      reasons: ['node_simulation', 'global_popularity'],
      modelVersion: SIMULATION_MODEL_VERSION,
    }));

  const recommendations = [...existing, ...simulated].slice(0, limit);
  return {
    recommendations,
    modelVersion: SIMULATION_MODEL_VERSION,
    fallback: existingResult?.fallback ?? true,
    fallbackReason: recommendations.length > 0
      ? 'node_simulation_for_diggledadiggz'
      : (existingResult?.fallbackReason || null),
  };
};

// Reuse the same proxy as the /api/woo routes so the client can hit /api/catalog
router.get('/recommendations', authenticate, async (req, res, next) => {
  try {
    if (!recommendationsEnabled()) {
      return res.json({ recommendations: [], modelVersion: MODEL_VERSION, fallback: true, fallbackReason: 'disabled' });
    }
    if (!canReadRecommendations(req.user)) {
      return res.status(403).json({ error: 'Physician access required' });
    }
    const requestedLimit = Number.parseInt(String(req.query?.limit || '100'), 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
    const baseRecommendations = buildRecommendations(req.user, limit);
    return res.json(await buildSimulatedRecommendations(req.user, baseRecommendations, limit));
  } catch (error) {
    return next(error);
  }
});

router.post('/events', authenticate, (req, res) => {
  const eventType = String(req.body?.eventType || req.body?.event || '').trim();
  if (!eventType) {
    return res.status(400).json({ error: 'eventType is required' });
  }
  if (!canReadRecommendations(req.user)) {
    return res.status(403).json({ error: 'Physician access required' });
  }
  return res.status(201).json({ ok: true, tracked: false, eventType });
});

router.get('/media', wooController.proxyMedia);

router.use(wooController.proxyCatalog);

module.exports = router;
