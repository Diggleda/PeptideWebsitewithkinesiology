const crypto = require('crypto');
const { Router } = require('express');
const { authenticate, authenticateOptional } = require('../middleware/authenticate');
const { JsonStore } = require('../storage/jsonStore');
const { env } = require('../config/env');
const userRepository = require('../repositories/userRepository');

const router = Router();

const store = new JsonStore(env.dataDir, 'delegation-links.json', {
  byDoctorId: {},
});
store.init();

const DEFAULT_MARKUP_PERCENT = 15;
const LINK_EXPIRY_HOURS = 72;

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeMarkupPercent = (value, fallback = DEFAULT_MARKUP_PERCENT) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(500, parsed));
};

const getState = () => {
  const state = store.read() || {};
  if (!state.byDoctorId || typeof state.byDoctorId !== 'object') {
    return { byDoctorId: {} };
  }
  return state;
};

const saveState = (state) => {
  store.write(state);
};

const ensureDoctorBucket = (state, doctorId) => {
  const key = String(doctorId || '').trim();
  if (!key) return null;
  if (!state.byDoctorId[key] || typeof state.byDoctorId[key] !== 'object') {
    state.byDoctorId[key] = {
      config: { markupPercent: DEFAULT_MARKUP_PERCENT },
      links: [],
    };
  }
  if (!state.byDoctorId[key].config || typeof state.byDoctorId[key].config !== 'object') {
    state.byDoctorId[key].config = { markupPercent: DEFAULT_MARKUP_PERCENT };
  }
  if (!Array.isArray(state.byDoctorId[key].links)) {
    state.byDoctorId[key].links = [];
  }
  return state.byDoctorId[key];
};

const makeToken = () => crypto.randomBytes(12).toString('hex');

router.get('/links', authenticate, (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const links = Array.isArray(bucket?.links) ? bucket.links : [];
  const config = bucket?.config || { markupPercent: DEFAULT_MARKUP_PERCENT };
  return res.json({
    links: [...links].sort((a, b) => Date.parse(b?.createdAt || 0) - Date.parse(a?.createdAt || 0)),
    config: {
      markupPercent: normalizeMarkupPercent(config.markupPercent, DEFAULT_MARKUP_PERCENT),
    },
  });
});

router.post('/links', authenticate, (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const now = Date.now();
  const markupPercent = normalizeMarkupPercent(
    req.body?.markupPercent,
    normalizeMarkupPercent(bucket?.config?.markupPercent, DEFAULT_MARKUP_PERCENT),
  );
  const link = {
    token: makeToken(),
    referenceLabel: normalizeOptionalString(req.body?.referenceLabel),
    patientId: normalizeOptionalString(req.body?.patientId),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LINK_EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
    markupPercent,
    paymentMethod: normalizeOptionalString(req.body?.paymentMethod) || 'none',
    paymentInstructions: normalizeOptionalString(req.body?.paymentInstructions) || '',
    receivedPayment: false,
    lastUsedAt: null,
    revokedAt: null,
    delegateSharedAt: null,
    delegateOrderId: null,
    proposalStatus: null,
  };
  bucket.links.push(link);
  bucket.config.markupPercent = markupPercent;
  saveState(state);
  return res.status(201).json({ link });
});

router.patch('/links/:token', authenticate, (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const token = String(req.params?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const link = bucket.links.find((candidate) => String(candidate?.token || '') === token);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'referenceLabel')) {
    link.referenceLabel = normalizeOptionalString(req.body.referenceLabel);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientId')) {
    link.patientId = normalizeOptionalString(req.body.patientId);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'markupPercent')) {
    link.markupPercent = normalizeMarkupPercent(req.body.markupPercent, link.markupPercent || DEFAULT_MARKUP_PERCENT);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'paymentMethod')) {
    link.paymentMethod = normalizeOptionalString(req.body.paymentMethod) || 'none';
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'paymentInstructions')) {
    link.paymentInstructions = normalizeOptionalString(req.body.paymentInstructions) || '';
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'receivedPayment')) {
    const value = req.body.receivedPayment;
    link.receivedPayment = value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
  }
  if (req.body?.revoke) {
    link.revokedAt = new Date().toISOString();
  }

  saveState(state);
  return res.json({ link });
});

router.patch('/config', authenticate, (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'markupPercent')) {
    bucket.config.markupPercent = normalizeMarkupPercent(req.body.markupPercent, DEFAULT_MARKUP_PERCENT);
  }
  saveState(state);
  return res.json({
    config: {
      markupPercent: normalizeMarkupPercent(bucket.config.markupPercent, DEFAULT_MARKUP_PERCENT),
    },
  });
});

router.get('/links/:token/proposal', authenticate, (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const token = String(req.params?.token || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const link = bucket.links.find((candidate) => String(candidate?.token || '') === token);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  return res.json({
    token: link.token,
    status: link.proposalStatus || 'pending',
    delegateOrderId: link.delegateOrderId || null,
    delegateSharedAt: link.delegateSharedAt || null,
  });
});

router.post('/links/:token/proposal/review', authenticate, (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const token = String(req.params?.token || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const link = bucket.links.find((candidate) => String(candidate?.token || '') === token);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  link.proposalStatus = normalizeOptionalString(req.body?.status) || 'pending';
  saveState(state);
  return res.json({ ok: true, status: link.proposalStatus });
});

router.get('/resolve', authenticateOptional, (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });
  const state = getState();
  const doctorIds = Object.keys(state.byDoctorId || {});
  for (const doctorId of doctorIds) {
    const bucket = ensureDoctorBucket(state, doctorId);
    const link = bucket.links.find((candidate) => String(candidate?.token || '') === token);
    if (!link) continue;
    if (link.revokedAt) return res.status(404).json({ error: 'Invalid or expired delegation link.' });
    const expiresAtMs = Date.parse(link.expiresAt || '');
    if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) {
      return res.status(404).json({ error: 'Invalid or expired delegation link.' });
    }
    link.lastUsedAt = new Date().toISOString();
    saveState(state);
    const doctor = userRepository.findById(doctorId);
    return res.json({
      token: link.token,
      doctorId,
      doctorName: doctor?.name || 'Doctor',
      markupPercent: normalizeMarkupPercent(link.markupPercent, DEFAULT_MARKUP_PERCENT),
      paymentMethod: link.paymentMethod || 'none',
      paymentInstructions: link.paymentInstructions || '',
      createdAt: link.createdAt || null,
      expiresAt: link.expiresAt || null,
      delegateSharedAt: link.delegateSharedAt || null,
      delegateOrderId: link.delegateOrderId || null,
      proposalStatus: link.proposalStatus || null,
    });
  }
  return res.status(404).json({ error: 'Invalid or expired delegation link.' });
});

module.exports = router;
