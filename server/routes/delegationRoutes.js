const crypto = require('crypto');
const { Router } = require('express');
const { authenticate, authenticateOptional } = require('../middleware/authenticate');
const { JsonStore } = require('../storage/jsonStore');
const { env } = require('../config/env');
const patientLinksRepository = require('../repositories/patientLinksRepository');
const userRepository = require('../repositories/userRepository');

const router = Router();

const store = new JsonStore(env.dataDir, 'delegation-links.json', {
  byDoctorId: {},
});
store.init();

const DEFAULT_MARKUP_PERCENT = 15;
const LINK_EXPIRY_HOURS = 72;
const DEFAULT_PRICING_DISCLOSURE =
  'Prices may include physician-directed service, handling, administrative, or research coordination fees.';
const ALLOWED_PRODUCT_SCOPES = new Set([
  'all_physician_approved',
  'specific_cart_only',
  'specific_products',
  'category_or_protocol',
]);
const ENABLED_DELEGATE_PERMISSIONS = new Set([
  'view_products_only',
  'submit_for_physician_review',
]);
const RESTRICTED_LEGACY_DELEGATE_PERMISSIONS = new Set([
  'build_cart_only',
  'submit_payment_info_only',
  'direct_checkout',
]);
const SUPPORTED_LINK_TYPES = new Set(['delegate', 'brochure']);

const normalizeOptionalString = (value, maxLength = 4000) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
};

const normalizeMarkupPercent = (value, fallback = DEFAULT_MARKUP_PERCENT) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
};

const normalizeUsageCount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const normalizeUsageLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
};

const normalizeRequiredLinkLimit = (value, defaultValue, label) => {
  if (value === undefined || value === null || value === '') {
    return { value: defaultValue };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: `${label} must be greater than zero` };
  }
  return { value: Math.max(1, Math.min(10_000, Math.floor(parsed))) };
};

const normalizeProductScope = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_PRODUCT_SCOPES.has(normalized) ? normalized : 'all_physician_approved';
};

const normalizeDelegatePermission = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (RESTRICTED_LEGACY_DELEGATE_PERMISSIONS.has(normalized)) return 'view_products_only';
  return ENABLED_DELEGATE_PERMISSIONS.has(normalized) ? normalized : 'submit_for_physician_review';
};

const normalizeLinkType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return SUPPORTED_LINK_TYPES.has(normalized) ? normalized : 'delegate';
};

const capabilitiesForLinkType = (value) => patientLinksRepository.capabilitiesForLinkType(value);

const normalizeBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const shouldCountResolvePageLoad = (query = {}) => {
  const rawValue =
    query.countPageLoad
    ?? query.countUsage
    ?? query.trackPageLoad
    ?? query.track_usage
    ?? query.trackUsage;
  if (rawValue === undefined || rawValue === null) return true;
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return true;
  return !['0', 'false', 'no', 'off', 'read', 'readonly', 'poll'].includes(normalized);
};

const hashPublicViewValue = (value) => {
  const text = String(value || '').trim();
  return text ? crypto.createHash('sha256').update(text).digest('hex') : null;
};

const resolvePublicViewContext = (req) => {
  const ipRaw = req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']
    || req.socket?.remoteAddress
    || req.ip
    || '';
  const ip = Array.isArray(ipRaw)
    ? String(ipRaw[0] || '').split(',')[0].trim()
    : String(ipRaw || '').split(',')[0].trim();
  return {
    ipHash: hashPublicViewValue(ip),
    userAgentHash: hashPublicViewValue(req.headers['user-agent'] || ''),
  };
};

const recordResolveOpenFallback = (link, nowMs = Date.now(), viewContext = {}) => {
  if (!link || typeof link !== 'object') return null;
  const nextOpenCount = normalizeUsageCount(link.openCount ?? link.open_count) + 1;
  const nextViewCount = normalizeUsageCount(link.viewCount ?? link.view_count ?? link.openCount ?? link.open_count) + 1;
  const timestamp = new Date(nowMs).toISOString();
  link.openCount = nextOpenCount;
  link.viewCount = nextViewCount;
  link.lastUsedAt = timestamp;
  link.lastOpenedAt = timestamp;
  link.firstViewedAt = link.firstViewedAt || timestamp;
  link.lastViewedAt = timestamp;
  if (viewContext.ipHash) link.lastIpHash = viewContext.ipHash;
  if (viewContext.userAgentHash) link.lastUserAgentHash = viewContext.userAgentHash;
  return {
    openCount: nextOpenCount,
    viewCount: nextViewCount,
    lastUsedAt: timestamp,
    lastOpenedAt: timestamp,
    firstViewedAt: link.firstViewedAt,
    lastViewedAt: timestamp,
  };
};

const normalizeAllowedProducts = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.replace(/\n/g, ',').split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
};

const syncPatientLinkSnapshot = async (link, doctorId) => {
  if (!patientLinksRepository.isEnabled()) return false;
  try {
    return await patientLinksRepository.createLinkSnapshot(link, doctorId);
  } catch (_error) {
    return false;
  }
};

const mergePatientLinkSqlMetrics = async (links) => {
  if (!patientLinksRepository.isEnabled()) return links;
  try {
    return await patientLinksRepository.mergeMetricsIntoLinks(links);
  } catch (_error) {
    return links;
  }
};

const recordResolveOpen = async (token, link, doctorId, nowMs = Date.now(), viewContext = {}) => {
  if (patientLinksRepository.isEnabled()) {
    try {
      await patientLinksRepository.createLinkSnapshot(link, doctorId);
      const metrics = await patientLinksRepository.touchLastUsed(token, viewContext);
      if (metrics) {
        Object.assign(link, metrics);
        return metrics;
      }
    } catch (_error) {
      // Fall back to local JSON counters when MySQL is unavailable during dev.
    }
  }
  return recordResolveOpenFallback(link, nowMs, viewContext);
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
const DEFAULT_DELEGATE_SECONDARY_COLOR = '#0b0679';

const buildDummyPaymentInstructions = (doctorName) =>
  `Reach out to ${doctorName || 'your physician'} for Zelle payment details.`;

const buildNodeDummyResolvePayload = (
  token,
  doctorName,
  doctorLogoUrl,
  doctorSecondaryColor,
  doctorBackgroundImageUrl,
  doctorBackgroundColor,
) => {
  const now = Date.now();
  const baseCreatedAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const baseExpiresAt = new Date(now + 71 * 60 * 60 * 1000).toISOString();
  const normalizedDoctorName = normalizeOptionalString(doctorName) || 'Demo Physician';
  const base = {
    token: 'node-ui-dummy-link',
    doctorId: 'node-ui-dummy-doctor',
    doctorName: normalizedDoctorName,
    doctorLogoUrl: normalizeOptionalString(doctorLogoUrl),
    doctorSecondaryColor: normalizeOptionalString(doctorSecondaryColor) || DEFAULT_DELEGATE_SECONDARY_COLOR,
    doctorBackgroundImageUrl: normalizeOptionalString(doctorBackgroundImageUrl),
    doctorBackgroundColor: normalizeOptionalString(doctorBackgroundColor),
    markupPercent: 15,
    paymentMethod: 'zelle',
    paymentInstructions: buildDummyPaymentInstructions(normalizedDoctorName),
    createdAt: baseCreatedAt,
    expiresAt: baseExpiresAt,
    subjectLabel: null,
    studyLabel: null,
    referenceLabel: null,
    delegateName: 'Demo delegate',
    delegateRole: 'patient',
    productScope: 'all_physician_approved',
    productScopeItems: [],
    delegatePermission: 'submit_for_physician_review',
    pricingDisclosure: DEFAULT_PRICING_DISCLOSURE,
    paymentConfirmationRequired: true,
    delegateInstructions: null,
    allowedProducts: ['BPC-157-5MG', 'TB-500-10MG'],
    instructions: null,
    delegateSharedAt: null,
    delegateOrderId: null,
    proposalStatus: null,
    proposalReviewedAt: null,
    proposalReviewOrderId: null,
    proposalReviewNotes: null,
    status: 'active',
  };
  if (token === 'node-ui-dummy-link-2') {
    const proposalCreatedAt = new Date(now - 45 * 60 * 1000).toISOString();
    return {
      ...base,
      token: 'node-ui-dummy-link-2',
      subjectLabel: null,
      referenceLabel: null,
      createdAt: new Date(now - 36 * 60 * 60 * 1000).toISOString(),
      delegateSharedAt: proposalCreatedAt,
      proposalStatus: 'pending',
    };
  }
  if (token === 'node-ui-dummy-link') {
    return base;
  }
  return null;
};

router.get('/links', authenticate, async (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const links = Array.isArray(bucket?.links) ? bucket.links : [];
  const config = bucket?.config || { markupPercent: DEFAULT_MARKUP_PERCENT };
  const sortedLinks = [...links].sort((a, b) => Date.parse(b?.createdAt || 0) - Date.parse(a?.createdAt || 0));
  const linksWithMetrics = await mergePatientLinkSqlMetrics(sortedLinks);
  return res.json({
    links: linksWithMetrics,
    config: {
      markupPercent: normalizeMarkupPercent(config.markupPercent, DEFAULT_MARKUP_PERCENT),
    },
  });
});

router.post('/links', authenticate, async (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const now = Date.now();
  const markupPercent = normalizeMarkupPercent(
    req.body?.markupPercent,
    normalizeMarkupPercent(bucket?.config?.markupPercent, DEFAULT_MARKUP_PERCENT),
  );
  const linkType = normalizeLinkType(req.body?.linkType ?? req.body?.link_type);
  const expiresInHours = normalizeRequiredLinkLimit(req.body?.expiresInHours ?? req.body?.expires_in_hours, LINK_EXPIRY_HOURS, 'expiresInHours');
  if (expiresInHours.error) return res.status(400).json({ error: expiresInHours.error });
  const paymentMethod = normalizeOptionalString(req.body?.paymentMethod ?? req.body?.payment_method, 32) || 'none';
  const brochureName = linkType === 'brochure'
    ? normalizeOptionalString(req.body?.brochureName ?? req.body?.brochure_name ?? req.body?.name)
    : null;
  if (linkType === 'brochure' && !brochureName) {
    return res.status(400).json({ error: 'brochureName is required for brochure links.' });
  }
  const link = {
    token: makeToken(),
    linkType,
    link_type: linkType,
    capabilities: capabilitiesForLinkType(linkType),
    createdByUserId: String(req.user?.id || doctorId || '').trim() || null,
    referenceLabel: normalizeOptionalString(req.body?.referenceLabel),
    patientId: normalizeOptionalString(req.body?.patientId),
    subjectLabel: normalizeOptionalString(req.body?.subjectLabel),
    studyLabel: normalizeOptionalString(req.body?.studyLabel),
    patientReference: normalizeOptionalString(req.body?.patientReference),
    brochureName,
    recipientName: linkType === 'brochure'
      ? normalizeOptionalString(req.body?.recipientName ?? req.body?.recipient_name ?? req.body?.delegateName ?? req.body?.delegate_name)
      : null,
    recipientContact: linkType === 'brochure'
      ? normalizeOptionalString(req.body?.recipientContact ?? req.body?.recipient_contact ?? req.body?.delegateContact ?? req.body?.delegate_contact)
      : null,
    delegateName: linkType === 'brochure' ? null : normalizeOptionalString(req.body?.delegateName ?? req.body?.delegate_name),
    delegateContact: linkType === 'brochure' ? null : normalizeOptionalString(req.body?.delegateContact ?? req.body?.delegate_contact),
    delegateRole: linkType === 'brochure' ? null : normalizeOptionalString(req.body?.delegateRole ?? req.body?.delegate_role, 64),
    productScope: normalizeProductScope(req.body?.productScope ?? req.body?.product_scope),
    productScopeItems: normalizeAllowedProducts(req.body?.productScopeItems ?? req.body?.product_scope_items),
    delegatePermission: linkType === 'brochure' ? 'view_products_only' : normalizeDelegatePermission(req.body?.delegatePermission ?? req.body?.delegate_permission),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInHours.value * 60 * 60 * 1000).toISOString(),
    markupPercent: linkType === 'brochure' ? 0 : markupPercent,
    pricingDisclosure: linkType === 'brochure' ? null : (normalizeOptionalString(req.body?.pricingDisclosure ?? req.body?.pricing_disclosure, 1000) || DEFAULT_PRICING_DISCLOSURE),
    zelleRecipientName: linkType === 'brochure' ? null : normalizeOptionalString(req.body?.zelleRecipientName ?? req.body?.zelle_recipient_name),
    paymentConfirmationRequired: linkType === 'brochure' ? false : normalizeBool(
      req.body?.paymentConfirmationRequired ?? req.body?.payment_confirmation_required,
      true,
    ),
    delegateInstructions: linkType === 'brochure' ? null : normalizeOptionalString(req.body?.delegateInstructions ?? req.body?.delegate_instructions, 4000),
    internalPhysicianNote: normalizeOptionalString(req.body?.internalPhysicianNote ?? req.body?.internal_physician_note, 4000),
    termsVersion: normalizeOptionalString(req.body?.termsVersion ?? req.body?.terms_version, 64),
    shippingPolicyVersion: normalizeOptionalString(req.body?.shippingPolicyVersion ?? req.body?.shipping_policy_version, 64),
    privacyPolicyVersion: normalizeOptionalString(req.body?.privacyPolicyVersion ?? req.body?.privacy_policy_version, 64),
    instructions: linkType === 'brochure' ? null : normalizeOptionalString(req.body?.instructions),
    allowedProducts: normalizeAllowedProducts(req.body?.allowedProducts),
    usageLimit: null,
    usageCount: 0,
    openCount: 0,
    paymentMethod: linkType === 'brochure' ? null : paymentMethod,
    paymentInstructions: linkType === 'brochure' ? '' : (normalizeOptionalString(req.body?.paymentInstructions) || ''),
    receivedPayment: false,
    lastUsedAt: null,
    lastOpenedAt: null,
    revokedAt: null,
    delegateSharedAt: null,
    delegateOrderId: null,
    proposalStatus: null,
  };
  bucket.links.push(link);
  bucket.config.markupPercent = markupPercent;
  saveState(state);
  await syncPatientLinkSnapshot(link, doctorId);
  return res.status(201).json({ link });
});

router.patch('/links/:token', authenticate, async (req, res) => {
  const doctorId = String(req.user?.id || '').trim();
  const token = String(req.params?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });
  const state = getState();
  const bucket = ensureDoctorBucket(state, doctorId);
  const link = bucket.links.find((candidate) => String(candidate?.token || '') === token);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (req.body?.delete || req.body?.deleteLink || req.body?.permanentDelete) {
    if (!link.revokedAt) {
      return res.status(409).json({ error: 'Only revoked links can be deleted.' });
    }
    bucket.links = bucket.links.filter((candidate) => String(candidate?.token || '') !== token);
    saveState(state);
    return res.json({ deleted: true, token });
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'referenceLabel')) {
    link.referenceLabel = normalizeOptionalString(req.body.referenceLabel);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientId')) {
    link.patientId = normalizeOptionalString(req.body.patientId);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'subjectLabel')) {
    link.subjectLabel = normalizeOptionalString(req.body.subjectLabel);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'studyLabel')) {
    link.studyLabel = normalizeOptionalString(req.body.studyLabel);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientReference')) {
    link.patientReference = normalizeOptionalString(req.body.patientReference);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'brochureName')
    || Object.prototype.hasOwnProperty.call(req.body || {}, 'brochure_name')) {
    const nextBrochureName = normalizeOptionalString(req.body.brochureName ?? req.body.brochure_name);
    if (normalizeLinkType(link.linkType ?? link.link_type) === 'brochure' && !nextBrochureName) {
      return res.status(400).json({ error: 'brochureName is required for brochure links.' });
    }
    link.brochureName = nextBrochureName;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'delegateName')) {
    link.delegateName = normalizeOptionalString(req.body.delegateName);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'delegateContact')) {
    link.delegateContact = normalizeOptionalString(req.body.delegateContact);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'delegateRole')) {
    link.delegateRole = normalizeOptionalString(req.body.delegateRole, 64);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'productScope')) {
    link.productScope = normalizeProductScope(req.body.productScope);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'productScopeItems')) {
    link.productScopeItems = normalizeAllowedProducts(req.body.productScopeItems);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'delegatePermission')) {
    link.delegatePermission = normalizeDelegatePermission(req.body.delegatePermission);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'markupPercent')) {
    link.markupPercent = normalizeMarkupPercent(req.body.markupPercent, link.markupPercent || DEFAULT_MARKUP_PERCENT);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pricingDisclosure')) {
    link.pricingDisclosure = normalizeOptionalString(req.body.pricingDisclosure, 1000) || DEFAULT_PRICING_DISCLOSURE;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'zelleRecipientName')) {
    link.zelleRecipientName = normalizeOptionalString(req.body.zelleRecipientName);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'paymentConfirmationRequired')) {
    link.paymentConfirmationRequired = normalizeBool(req.body.paymentConfirmationRequired, true);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'delegateInstructions')) {
    link.delegateInstructions = normalizeOptionalString(req.body.delegateInstructions, 4000);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'internalPhysicianNote')) {
    link.internalPhysicianNote = normalizeOptionalString(req.body.internalPhysicianNote, 4000);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'termsVersion')) {
    link.termsVersion = normalizeOptionalString(req.body.termsVersion, 64);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'shippingPolicyVersion')) {
    link.shippingPolicyVersion = normalizeOptionalString(req.body.shippingPolicyVersion, 64);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'privacyPolicyVersion')) {
    link.privacyPolicyVersion = normalizeOptionalString(req.body.privacyPolicyVersion, 64);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'instructions')) {
    link.instructions = normalizeOptionalString(req.body.instructions);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedProducts')) {
    link.allowedProducts = normalizeAllowedProducts(req.body.allowedProducts);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'expiresInHours')) {
    const expiresInHours = normalizeRequiredLinkLimit(req.body.expiresInHours, LINK_EXPIRY_HOURS, 'expiresInHours');
    if (expiresInHours.error) return res.status(400).json({ error: expiresInHours.error });
    link.expiresAt = new Date(Date.now() + expiresInHours.value * 60 * 60 * 1000).toISOString();
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
  await syncPatientLinkSnapshot(link, doctorId);
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
    delegateName: link.delegateName || null,
    delegateContact: link.delegateContact || null,
    delegateRole: link.delegateRole || null,
    productScope: link.productScope || 'all_physician_approved',
    productScopeItems: link.productScopeItems || [],
    delegatePermission: link.delegatePermission || 'submit_for_physician_review',
    pricingDisclosure: link.pricingDisclosure || DEFAULT_PRICING_DISCLOSURE,
    zelleRecipientName: link.zelleRecipientName || null,
    paymentConfirmationRequired: link.paymentConfirmationRequired !== false,
    delegateInstructions: link.delegateInstructions || null,
    internalPhysicianNote: link.internalPhysicianNote || null,
    termsVersion: link.termsVersion || null,
    shippingPolicyVersion: link.shippingPolicyVersion || null,
    privacyPolicyVersion: link.privacyPolicyVersion || null,
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

router.get('/resolve', authenticateOptional, async (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });
  if (token.startsWith('node-ui-dummy-link')) {
    const dummy = buildNodeDummyResolvePayload(
      token,
      req.user?.name || null,
      req.user?.delegateLogoUrl || null,
      req.user?.delegateSecondaryColor || null,
      req.user?.delegateBackgroundImageUrl || null,
      req.user?.delegateBackgroundColor || null,
    );
    if (dummy) {
      return res.json(dummy);
    }
  }
  const state = getState();
  const nowMs = Date.now();
  const countPageLoad = shouldCountResolvePageLoad(req.query || {});
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
    if (countPageLoad) {
      await recordResolveOpen(token, link, doctorId, nowMs, resolvePublicViewContext(req));
      saveState(state);
    }
    const doctor = userRepository.findById(doctorId);
    const linkType = normalizeLinkType(link.linkType ?? link.link_type);
    const capabilities = capabilitiesForLinkType(linkType);
    const exposeScopeItems = linkType !== 'brochure';
    const brochureTitle = linkType === 'brochure'
      ? normalizeOptionalString(link.brochureName ?? link.brochure_name)
      : null;
    return res.json({
      token: link.token,
      linkType,
      link_type: linkType,
      capabilities,
      brochureTitle,
      pageTitle: brochureTitle,
      doctorId: linkType === 'brochure' ? '' : doctorId,
      doctorName: doctor?.name || 'Doctor',
      doctorLogoUrl: doctor?.delegateLogoUrl || null,
      doctorSecondaryColor: doctor?.delegateSecondaryColor || DEFAULT_DELEGATE_SECONDARY_COLOR,
      doctorBackgroundImageUrl: doctor?.delegateBackgroundImageUrl || null,
      doctorBackgroundColor: doctor?.delegateBackgroundColor || null,
      markupPercent: linkType === 'brochure' ? 0 : normalizeMarkupPercent(link.markupPercent, DEFAULT_MARKUP_PERCENT),
      paymentMethod: linkType === 'brochure' ? null : (link.paymentMethod || 'none'),
      paymentInstructions: linkType === 'brochure' ? null : (link.paymentInstructions || ''),
      delegateName: linkType === 'brochure' ? null : (link.delegateName || null),
      delegateRole: linkType === 'brochure' ? null : (link.delegateRole || null),
      productScope: link.productScope || 'all_physician_approved',
      productScopeItems: exposeScopeItems ? (link.productScopeItems || []) : [],
      delegatePermission: linkType === 'brochure' ? 'view_products_only' : (link.delegatePermission || 'submit_for_physician_review'),
      pricingDisclosure: linkType === 'brochure' ? null : (link.pricingDisclosure || DEFAULT_PRICING_DISCLOSURE),
      paymentConfirmationRequired: linkType === 'brochure' ? false : link.paymentConfirmationRequired !== false,
      delegateInstructions: linkType === 'brochure' ? null : (link.delegateInstructions || null),
      termsVersion: link.termsVersion || null,
      shippingPolicyVersion: link.shippingPolicyVersion || null,
      privacyPolicyVersion: link.privacyPolicyVersion || null,
      subjectLabel: linkType === 'brochure' ? null : (link.subjectLabel || null),
      studyLabel: linkType === 'brochure' ? null : (link.studyLabel || null),
      patientReference: linkType === 'brochure' ? null : (link.patientReference || null),
      createdAt: link.createdAt || null,
      expiresAt: link.expiresAt || null,
      usageLimit: null,
      usageCount: normalizeUsageCount(link.usageCount ?? link.usage_count),
      openCount: normalizeUsageCount(link.openCount ?? link.open_count),
      viewCount: normalizeUsageCount(link.viewCount ?? link.view_count ?? link.openCount ?? link.open_count),
      lastUsedAt: link.lastUsedAt || null,
      lastOpenedAt: link.lastOpenedAt || null,
      firstViewedAt: link.firstViewedAt || null,
      lastViewedAt: link.lastViewedAt || link.lastOpenedAt || null,
      delegateSharedAt: linkType === 'brochure' ? null : (link.delegateSharedAt || null),
      delegateOrderId: linkType === 'brochure' ? null : (link.delegateOrderId || null),
      proposalStatus: linkType === 'brochure' ? null : (link.proposalStatus || null),
    });
  }
  return res.status(404).json({ error: 'Invalid or expired delegation link.' });
});

router.__test__ = {
  buildNodeDummyResolvePayload,
  normalizeUsageCount,
  normalizeUsageLimit,
  shouldCountResolvePageLoad,
  recordResolveOpenFallback,
};

module.exports = router;
