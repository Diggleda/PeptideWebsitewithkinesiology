const crypto = require('crypto');
const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const {
  getShopEnabled,
  setShopEnabled,
  getBetaServices,
  setBetaServices,
  getPatientLinksEnabled,
  setPatientLinksEnabled,
  getPeptideForumEnabled,
  setPeptideForumEnabled,
  getResearchDashboardEnabled,
  setResearchDashboardEnabled,
  getCrmEnabled,
  setCrmEnabled,
  getTestPaymentsOverrideEnabled,
  setTestPaymentsOverrideEnabled,
  getStripeMode,
  setStripeMode,
  getSalesBySalesRepCsvDownloadedAt,
  setSalesBySalesRepCsvDownloadedAt,
  getSalesLeadSalesBySalesRepCsvDownloadedAt,
  setSalesLeadSalesBySalesRepCsvDownloadedAt,
  getTaxesByStateCsvDownloadedAt,
  setTaxesByStateCsvDownloadedAt,
  getProductsCommissionCsvDownloadedAt,
  setProductsCommissionCsvDownloadedAt,
  getDatabaseVisualizerMockPayload,
} = require('../services/settingsService');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const userRepository = require('../repositories/userRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const crmRepository = require('../repositories/crmRepository');

const router = Router();

const normalizeRole = (role) => (role || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');
const isAdmin = (role) => normalizeRole(role) === 'admin';
const isSalesLead = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'sales_lead' || normalized === 'saleslead';
};
const isSalesRep = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'sales_rep' || normalized === 'sales_partner' || normalized === 'test_rep' || normalized === 'rep' || normalized === 'sales_lead' || normalized === 'saleslead';
};

const requireAdmin = (req, res, next) => {
  const currentUser = req.currentUser || req.user || null;
  const userId = currentUser?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = currentUser?.role ? currentUser : userRepository.findById(userId);
  const role = normalizeRole(user?.role || currentUser?.role);
  if (!isAdmin(role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.currentUser = user;
  return next();
};

const requireAdminOrSalesLead = (req, res, next) => {
  const currentUser = req.currentUser || req.user || null;
  const userId = currentUser?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = currentUser?.role ? currentUser : userRepository.findById(userId);
  const role = normalizeRole(user?.role || currentUser?.role);
  if (!isAdmin(role) && !isSalesLead(role)) {
    return res.status(403).json({ error: 'Admin or Sales Lead access required' });
  }
  req.currentUser = user;
  return next();
};

const requireSalesRepOrAdmin = (req, res, next) => {
  const currentUser = req.currentUser || req.user || null;
  const userId = currentUser?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = currentUser?.role ? currentUser : userRepository.findById(userId);
  const role = normalizeRole(user?.role || currentUser?.role);
  if (!isAdmin(role) && !isSalesRep(role)) {
    return res.status(403).json({ error: 'Sales rep access required' });
  }
  req.currentUser = user;
  return next();
};

const resolveCurrentSalesRepRecord = (user) => {
  if (!user) return null;
  const bySalesRepId = user?.salesRepId ? salesRepRepository.findById(String(user.salesRepId)) : null;
  if (bySalesRepId) return bySalesRepId;
  const byUserId = user?.id ? salesRepRepository.findById(String(user.id)) : null;
  if (byUserId) return byUserId;
  const byEmail = user?.email ? salesRepRepository.findByEmail(String(user.email)) : null;
  return byEmail || null;
};

const isDoctorUser = (user) => {
  const role = normalizeRole(user?.role);
  return role === 'doctor' || role === 'test_doctor';
};

const normalizeOwnershipIds = (values = []) =>
  Array.from(new Set(values
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)));

const normalizeOptionalText = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

const buildDelegateLinksDoctorEntries = () => userRepository
  .getAll()
  .filter((candidate) => normalizeRole(candidate?.role) === 'doctor')
  .map((doctor) => ({
    userId: String(doctor.id || '').trim(),
    name: String(doctor?.name || doctor?.email || `Doctor ${doctor?.id || ''}`).trim(),
    email: doctor?.email ? String(doctor.email).trim().toLowerCase() : null,
    delegateLinksEnabled: Boolean(doctor?.delegateLinksEnabled || doctor?.delegate_links_enabled),
  }))
  .filter((doctor) => doctor.userId)
  .sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return String(a.email || '').localeCompare(String(b.email || ''));
  });

const serializeUserProfile = (user) => {
  if (!user) return null;
  return {
    id: String(user.id || ''),
    name: user.name || null,
    email: user.email || null,
    phone: user.phone || null,
    role: normalizeRole(user.role || ''),
    status: user.status || null,
    profileImageUrl: user.profileImageUrl || null,
    salesRepId: user.salesRepId || null,
    officeAddressLine1: user.officeAddressLine1 || null,
    officeAddressLine2: user.officeAddressLine2 || null,
    officeCity: user.officeCity || null,
    officeState: user.officeState || null,
    officePostalCode: user.officePostalCode || null,
    officeCountry: user.officeCountry || null,
    handDelivered: Boolean(user.handDelivered || user.hand_delivered),
    receiveClientOrderUpdateEmails: Boolean(user.receiveClientOrderUpdateEmails),
    devCommission: Boolean(user.devCommission),
    lastSeenAt: user.lastSeenAt || null,
    lastInteractionAt: user.lastInteractionAt || null,
    lastLoginAt: user.lastLoginAt || null,
    createdAt: user.createdAt || null,
  };
};

const buildDoctorOwnershipSet = async (ownerIds = []) => {
  const ownedDoctorIds = new Set();
  const ownedEmails = new Set();
  try {
    const prospects = await salesProspectRepository.getAll();
    const owned = (prospects || []).filter((record) => ownerIds.includes(String(record?.salesRepId || '')));
    owned
      .map((record) => String(record?.doctorId || '').trim())
      .filter(Boolean)
      .forEach((id) => ownedDoctorIds.add(id));
    owned
      .map((record) => String(record?.contactEmail || '').trim().toLowerCase())
      .filter(Boolean)
      .forEach((email) => ownedEmails.add(email));
  } catch (error) {
    logger.warn({ err: error, ownerIds }, 'Unable to load ownership prospects for hand delivery');
  }
  return { ownedDoctorIds, ownedEmails };
};

const buildSalesRepDoctorEntries = async (ownerIds = []) => {
  const ownershipIds = normalizeOwnershipIds(ownerIds);
  const { ownedDoctorIds, ownedEmails } = await buildDoctorOwnershipSet(ownershipIds);
  return userRepository
    .getAll()
    .filter((candidate) => {
      if (!isDoctorUser(candidate)) return false;
      const directOwnerId = String(candidate?.salesRepId || '').trim();
      if (directOwnerId && ownershipIds.includes(directOwnerId)) return true;
      const doctorId = String(candidate?.id || '').trim();
      if (doctorId && ownedDoctorIds.has(doctorId)) return true;
      const email = String(candidate?.email || '').trim().toLowerCase();
      return Boolean(email && ownedEmails.has(email));
    })
    .map((doctor) => ({
      userId: String(doctor.id),
      salesRepId: doctor?.salesRepId ? String(doctor.salesRepId) : null,
      name: String(doctor?.name || doctor?.email || `Doctor ${doctor?.id || ''}`).trim(),
      email: doctor?.email ? String(doctor.email).trim().toLowerCase() : null,
      role: normalizeRole(doctor?.role || ''),
      handDelivered: Boolean(doctor?.handDelivered || doctor?.hand_delivered),
    }))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return String(a.email || '').localeCompare(String(b.email || ''));
    });
};

const computePresenceSnapshot = ({ user, nowMs, onlineThresholdMs, idleThresholdMs }) => {
  const lastLoginAt = user?.lastLoginAt || null;
  const lastLoginMs = lastLoginAt ? Date.parse(lastLoginAt) : NaN;
  const hasLoginTs = Number.isFinite(lastLoginMs);
  const lastSeenAt = user?.lastSeenAt || lastLoginAt || null;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  const hasSeenTs = Number.isFinite(lastSeenMs);
  const lastInteractionAt = user?.lastInteractionAt || null;
  const lastInteractionMs = lastInteractionAt ? Date.parse(lastInteractionAt) : NaN;
  const hasInteractionTs = Number.isFinite(lastInteractionMs);

  const isOnline =
    (hasSeenTs && (nowMs - lastSeenMs) <= onlineThresholdMs)
    || (!hasSeenTs && hasLoginTs && (nowMs - lastLoginMs) <= onlineThresholdMs);

  const explicitIdle = typeof user?.isIdle === 'boolean' ? user.isIdle : null;
  // "Idle" should not be reset by heartbeats (`lastSeenAt`); only by interactions or (as fallback) session start.
  const idleAnchorMs = hasInteractionTs ? lastInteractionMs : (hasLoginTs ? lastLoginMs : lastSeenMs);
  const hasIdleAnchor = Number.isFinite(idleAnchorMs);
  const computedIdle = isOnline && hasIdleAnchor ? (nowMs - idleAnchorMs) >= idleThresholdMs : null;

  const idleMinutes = hasIdleAnchor ? Math.max(0, Math.floor((nowMs - idleAnchorMs) / 60000)) : null;
  const onlineMinutes = hasLoginTs ? Math.max(0, Math.floor((nowMs - lastLoginMs) / 60000)) : null;

  return {
    isOnline,
    isIdle: explicitIdle ?? computedIdle,
    lastLoginAt,
    lastSeenAt,
    lastInteractionAt,
    idleMinutes,
    onlineMinutes,
  };
};

const resolvePublishableKey = (mode) => {
  const normalized = String(mode || '').toLowerCase().trim() === 'live' ? 'live' : 'test';
  const liveKey = env.stripe?.livePublishableKey || env.stripe?.publishableKey || '';
  const testKey = env.stripe?.testPublishableKey || '';
  if (normalized === 'live') {
    return liveKey;
  }
  return testKey || liveKey;
};

router.get('/shop', async (_req, res) => {
  const enabled = await getShopEnabled();
  res.json({ shopEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/beta-services', authenticate, async (_req, res) => {
  const betaServices = await getBetaServices();
  res.json({ betaServices, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/patient-links', async (_req, res) => {
  const enabled = await getPatientLinksEnabled();
  const patientLinksDoctorUserIds = buildDelegateLinksDoctorEntries()
    .filter((doctor) => doctor.delegateLinksEnabled)
    .map((doctor) => doctor.userId);
  res.json({
    patientLinksEnabled: enabled,
    patientLinksDoctorUserIds,
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

router.get('/patient-links/doctors', authenticate, requireAdmin, async (_req, res) => {
  res.json({
    doctors: buildDelegateLinksDoctorEntries().map((doctor) => ({
      userId: doctor.userId,
      name: doctor.name,
      email: doctor.email,
      delegateLinksEnabled: doctor.delegateLinksEnabled,
    })),
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

router.get('/forum', async (_req, res) => {
  const enabled = await getPeptideForumEnabled();
  res.json({ peptideForumEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/research', async (_req, res) => {
  const enabled = await getResearchDashboardEnabled();
  res.json({ researchDashboardEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/crm', async (_req, res) => {
  const enabled = await getCrmEnabled();
  res.json({ crmEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/test-payments-override', authenticate, requireAdmin, async (_req, res) => {
  const enabled = await getTestPaymentsOverrideEnabled();
  res.json({ testPaymentsOverrideEnabled: enabled, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/shop', authenticate, requireAdmin, async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const confirmed = await setShopEnabled(enabled);
  res.json({ shopEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/beta-services', authenticate, requireAdmin, async (req, res) => {
  const betaServices = await setBetaServices(req.body?.betaServices);
  res.json({ betaServices, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/patient-links', authenticate, requireAdmin, async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const rawDoctorUserIds = Array.isArray(req.body?.doctorUserIds)
    ? req.body.doctorUserIds
    : [];
  const requestedDoctorUserIds = Array.from(new Set(
    rawDoctorUserIds
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ));
  for (const doctorUserId of requestedDoctorUserIds) {
    const doctor = userRepository.findById(doctorUserId);
    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }
    if (normalizeRole(doctor.role) !== 'doctor') {
      return res.status(400).json({ error: 'Doctor access required' });
    }
  }
  const selectedDoctorIdSet = new Set(requestedDoctorUserIds);
  userRepository
    .getAll()
    .filter((candidate) => normalizeRole(candidate?.role) === 'doctor')
    .forEach((doctor) => {
      const doctorId = String(doctor?.id || '').trim();
      if (!doctorId) return;
      const nextValue = selectedDoctorIdSet.has(doctorId);
      if (Boolean(doctor?.delegateLinksEnabled || doctor?.delegate_links_enabled) === nextValue) {
        return;
      }
      userRepository.update({ ...doctor, delegateLinksEnabled: nextValue });
    });
  const confirmed = await setPatientLinksEnabled(enabled);
  res.json({
    patientLinksEnabled: confirmed,
    patientLinksDoctorUserIds: buildDelegateLinksDoctorEntries()
      .filter((doctor) => doctor.delegateLinksEnabled)
      .map((doctor) => doctor.userId),
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

router.put('/forum', authenticate, requireAdmin, async (req, res) => {
  const enabled = req.body?.peptideForumEnabled ?? req.body?.enabled;
  const confirmed = await setPeptideForumEnabled(Boolean(enabled));
  res.json({ peptideForumEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/research', authenticate, requireAdmin, async (req, res) => {
  const enabled = req.body?.researchDashboardEnabled ?? req.body?.enabled;
  const confirmed = await setResearchDashboardEnabled(Boolean(enabled));
  res.json({ researchDashboardEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/crm', authenticate, requireAdmin, async (req, res) => {
  const enabled = req.body?.crmEnabled ?? req.body?.enabled;
  const confirmed = await setCrmEnabled(Boolean(enabled));
  res.json({ crmEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.put('/test-payments-override', authenticate, requireAdmin, async (req, res) => {
  const enabled = req.body?.testPaymentsOverrideEnabled ?? req.body?.enabled;
  const confirmed = await setTestPaymentsOverrideEnabled(Boolean(enabled));
  res.json({ testPaymentsOverrideEnabled: confirmed, mysqlEnabled: mysqlClient.isEnabled() });
});

router.get('/stripe', async (_req, res) => {
  const mode = await getStripeMode();
  logger.debug({ mode, mysqlEnabled: mysqlClient.isEnabled() }, 'Stripe settings requested');
  res.json({
    stripeMode: mode,
    stripeTestMode: mode === 'test',
    onsiteEnabled: Boolean(env.stripe?.onsiteEnabled),
    publishableKey: resolvePublishableKey(mode),
    publishableKeyLive: env.stripe?.livePublishableKey || '',
    publishableKeyTest: env.stripe?.testPublishableKey || '',
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

router.get('/reports', authenticate, requireAdminOrSalesLead, async (req, res) => {
  const role = normalizeRole(req.currentUser?.role);
  if (isSalesLead(role) && !isAdmin(role)) {
    const downloadedAt = await getSalesLeadSalesBySalesRepCsvDownloadedAt();
    return res.json({ salesLeadSalesBySalesRepCsvDownloadedAt: downloadedAt });
  }
  const downloadedAt = await getSalesBySalesRepCsvDownloadedAt();
  const salesLeadDownloadedAt = await getSalesLeadSalesBySalesRepCsvDownloadedAt();
  const taxesDownloadedAt = await getTaxesByStateCsvDownloadedAt();
  const productsDownloadedAt = await getProductsCommissionCsvDownloadedAt();
  return res.json({
    salesBySalesRepCsvDownloadedAt: downloadedAt,
    salesLeadSalesBySalesRepCsvDownloadedAt: salesLeadDownloadedAt,
    taxesByStateCsvDownloadedAt: taxesDownloadedAt,
    productsCommissionCsvDownloadedAt: productsDownloadedAt,
  });
});

router.put('/reports', authenticate, requireAdminOrSalesLead, async (req, res) => {
  const role = normalizeRole(req.currentUser?.role);

  if (isSalesLead(role) && !isAdmin(role)) {
    const downloadedAt = req.body?.salesLeadSalesBySalesRepCsvDownloadedAt ?? req.body?.downloadedAt;
    if (downloadedAt !== undefined) {
      await setSalesLeadSalesBySalesRepCsvDownloadedAt(downloadedAt);
    }
    return res.json({
      salesLeadSalesBySalesRepCsvDownloadedAt: await getSalesLeadSalesBySalesRepCsvDownloadedAt(),
    });
  }

  const salesDownloadedAt = req.body?.salesBySalesRepCsvDownloadedAt;
  const salesLeadDownloadedAt = req.body?.salesLeadSalesBySalesRepCsvDownloadedAt;
  const taxesDownloadedAt = req.body?.taxesByStateCsvDownloadedAt;
  const productsDownloadedAt = req.body?.productsCommissionCsvDownloadedAt;

  if (salesDownloadedAt !== undefined) {
    await setSalesBySalesRepCsvDownloadedAt(salesDownloadedAt);
  }
  if (salesLeadDownloadedAt !== undefined) {
    await setSalesLeadSalesBySalesRepCsvDownloadedAt(salesLeadDownloadedAt);
  }
  if (taxesDownloadedAt !== undefined) {
    await setTaxesByStateCsvDownloadedAt(taxesDownloadedAt);
  }
  if (productsDownloadedAt !== undefined) {
    await setProductsCommissionCsvDownloadedAt(productsDownloadedAt);
  }

  return res.json({
    salesBySalesRepCsvDownloadedAt: await getSalesBySalesRepCsvDownloadedAt(),
    salesLeadSalesBySalesRepCsvDownloadedAt: await getSalesLeadSalesBySalesRepCsvDownloadedAt(),
    taxesByStateCsvDownloadedAt: await getTaxesByStateCsvDownloadedAt(),
    productsCommissionCsvDownloadedAt: await getProductsCommissionCsvDownloadedAt(),
  });
});

router.get('/crm/assignment-rules', authenticate, requireAdminOrSalesLead, async (_req, res) => {
  try {
    const rules = await crmRepository.listAssignmentRules();
    return res.json({ rules });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load CRM assignment rules');
    return res.status(500).json({ error: 'Unable to load CRM assignment rules' });
  }
});

router.put('/crm/assignment-rules', authenticate, requireAdminOrSalesLead, async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body : req.body?.rules;
    if (!Array.isArray(payload)) {
      return res.status(400).json({ error: 'rules array is required' });
    }
    const sanitized = payload.map((rule, index) => ({
      id: typeof rule?.id === 'string' ? rule.id : undefined,
      name: typeof rule?.name === 'string' ? rule.name : `Rule ${index + 1}`,
      enabled: rule?.enabled !== false,
      priority: Number.isFinite(Number(rule?.priority)) ? Number(rule.priority) : index + 1,
      conditions: rule?.conditions && typeof rule.conditions === 'object' ? rule.conditions : {},
      assigneeSalesRepId:
        rule?.assigneeSalesRepId != null
          ? String(rule.assigneeSalesRepId)
          : (rule?.assignee_sales_rep_id != null ? String(rule.assignee_sales_rep_id) : null),
    }));
    const rules = await crmRepository.replaceAssignmentRules(sanitized);
    return res.json({ rules });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update CRM assignment rules');
    return res.status(500).json({ error: 'Unable to update CRM assignment rules' });
  }
});

router.put('/stripe', authenticate, requireAdmin, async (req, res) => {
  const rawMode = req.body?.mode;
  const testMode = req.body?.testMode;
  const mode = typeof rawMode === 'string'
    ? rawMode
    : (testMode === true ? 'test' : 'live');
  logger.info(
    {
      requestedMode: mode,
      mysqlEnabled: mysqlClient.isEnabled(),
      userId: req.user?.id || null,
    },
    'Stripe settings update requested',
  );
  await setStripeMode(mode);
  const updated = await getStripeMode();
  res.json({
    stripeMode: updated,
    stripeTestMode: updated === 'test',
    onsiteEnabled: Boolean(env.stripe?.onsiteEnabled),
    publishableKey: resolvePublishableKey(updated),
    publishableKeyLive: env.stripe?.livePublishableKey || '',
    publishableKeyTest: env.stripe?.testPublishableKey || '',
    mysqlEnabled: mysqlClient.isEnabled(),
  });
});

router.get('/users/:userId', authenticate, requireAdminOrSalesLead, async (req, res) => {
  const userId = String(req.params?.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const user =
    userRepository.findById(userId)
    || userRepository.getAll().find((candidate) => String(candidate?.salesRepId || '').trim() === userId)
    || null;

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({ user: serializeUserProfile(user) });
});

router.get('/users', authenticate, requireAdminOrSalesLead, async (req, res) => {
  const rawIds = String(req.query?.ids || '').trim();
  if (!rawIds) {
    return res.status(400).json({ error: 'ids is required' });
  }

  const requestedIds = Array.from(new Set(
    rawIds
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).slice(0, 100);

  const users = requestedIds
    .map((targetId) => (
      userRepository.findById(targetId)
      || userRepository.getAll().find((candidate) => String(candidate?.salesRepId || '').trim() === targetId)
      || null
    ))
    .filter(Boolean)
    .map((user) => {
      const profile = serializeUserProfile(user);
      return {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        profileImageUrl: profile.profileImageUrl || null,
      };
    });

  return res.json({ users });
});

router.patch('/users/:userId', authenticate, requireAdminOrSalesLead, async (req, res) => {
  const userId = String(req.params?.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const existing = userRepository.findById(userId);
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }

  const body = req.body || {};
  const next = {
    ...existing,
  };

  if (Object.prototype.hasOwnProperty.call(body, 'phone')) {
    next.phone = normalizeOptionalText(body.phone);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'salesRepId')) {
    next.salesRepId = normalizeOptionalText(body.salesRepId);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'officeAddressLine1')) {
    next.officeAddressLine1 = normalizeOptionalText(body.officeAddressLine1);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'officeAddressLine2')) {
    next.officeAddressLine2 = normalizeOptionalText(body.officeAddressLine2);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'officeCity')) {
    next.officeCity = normalizeOptionalText(body.officeCity);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'officeState')) {
    next.officeState = normalizeOptionalText(body.officeState);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'officePostalCode')) {
    next.officePostalCode = normalizeOptionalText(body.officePostalCode);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'officeCountry')) {
    next.officeCountry = normalizeOptionalText(body.officeCountry);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'handDelivered')) {
    next.handDelivered = Boolean(body.handDelivered);
    next.hand_delivered = next.handDelivered ? 1 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'receiveClientOrderUpdateEmails')) {
    next.receiveClientOrderUpdateEmails = Boolean(body.receiveClientOrderUpdateEmails);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'devCommission')) {
    next.devCommission = Boolean(body.devCommission);
  }

  const updated = userRepository.update(next);
  if (!updated) {
    return res.status(500).json({ error: 'Unable to update user' });
  }

  return res.json({ user: serializeUserProfile(updated) });
});

router.get('/sales-reps/:salesRepId', authenticate, requireAdminOrSalesLead, async (req, res) => {
  const salesRepId = String(req.params?.salesRepId || '').trim();
  if (!salesRepId) {
    return res.status(400).json({ error: 'salesRepId is required' });
  }

  const rep =
    salesRepRepository.findById(salesRepId)
    || salesRepRepository.findByEmail(salesRepId)
    || null;

  if (!rep) {
    return res.status(404).json({ error: 'Sales rep not found' });
  }

  const users = userRepository.getAll();
  const resolvedUser =
    users.find((candidate) => String(candidate?.salesRepId || '').trim() === String(rep.id || rep.salesRepId || '').trim())
    || (rep?.email ? userRepository.findByEmail(rep.email) : null)
    || null;
  const isPartner = Boolean(rep?.isPartner || rep?.is_partner);
  const effectiveRole = normalizeRole(resolvedUser?.role || (isPartner ? 'sales_partner' : rep.role || 'sales_rep'));

  return res.json({
    salesRep: {
      id: String(rep.id || rep.salesRepId || salesRepId),
      name: rep.name || null,
      email: rep.email || null,
      phone: rep.phone || null,
      role: effectiveRole,
      isPartner,
      userId: resolvedUser?.id ? String(resolvedUser.id) : null,
      salesRepId: String(rep.id || rep.salesRepId || salesRepId),
    },
  });
});

router.get('/structure/hand-delivery', authenticate, requireAdmin, async (_req, res) => {
  const users = userRepository.getAll();
  const rows = (users || [])
    .filter((candidate) => {
      const role = normalizeRole(candidate?.role);
      return role === 'sales_rep' || role === 'sales_partner' || role === 'rep' || role === 'sales_lead' || role === 'saleslead' || role === 'admin';
    })
    .map((candidate) => {
      const jurisdiction = String(candidate?.jurisdiction || '').trim().toLowerCase() || null;
      return {
        userId: String(candidate.id || ''),
        salesRepId: candidate?.salesRepId ? String(candidate.salesRepId) : null,
        name: String(candidate?.name || candidate?.email || `User ${candidate?.id || ''}`).trim(),
        role: normalizeRole(candidate?.role || ''),
        jurisdiction,
        isLocal: jurisdiction === 'local',
      };
    })
    .filter((entry) => entry.userId.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return res.json({ users: rows });
});

router.patch('/structure/hand-delivery/:userId', authenticate, requireAdmin, async (req, res) => {
  const userId = String(req.params?.userId || '').trim();
  const requestedJurisdiction = req.body?.jurisdiction;
  const jurisdiction =
    typeof requestedJurisdiction === 'string' && requestedJurisdiction.trim().toLowerCase() === 'local'
      ? 'local'
      : null;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  const existing = userRepository.findById(userId);
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }
  const updated = userRepository.update({
    ...existing,
    jurisdiction,
  });

  const repRecord = resolveCurrentSalesRepRecord(updated || existing);
  if (repRecord?.id) {
    salesRepRepository.update({
      ...repRecord,
      jurisdiction,
    });
  }

  return res.json({
    entry: {
      userId: String((updated || existing).id),
      salesRepId: (updated || existing)?.salesRepId ? String((updated || existing).salesRepId) : null,
      name: String((updated || existing)?.name || (updated || existing)?.email || `User ${userId}`).trim(),
      role: normalizeRole((updated || existing)?.role || ''),
      jurisdiction,
      isLocal: jurisdiction === 'local',
    },
  });
});

router.get('/structure/hand-delivery/doctors', authenticate, requireSalesRepOrAdmin, async (req, res) => {
  const current = req.currentUser || userRepository.findById(req.user?.id);
  const currentRole = normalizeRole(current?.role);
  const requestedSalesRepId = typeof req.query?.salesRepId === 'string'
    ? String(req.query.salesRepId).trim()
    : '';

  const repRecord = isAdmin(currentRole) && requestedSalesRepId
    ? salesRepRepository.findById(requestedSalesRepId)
    : resolveCurrentSalesRepRecord(current);
  const repJurisdiction = String(repRecord?.jurisdiction || '').trim().toLowerCase();
  const isLocalJurisdiction = repJurisdiction === 'local';

  const ownerIds = normalizeOwnershipIds([
    repRecord?.id,
    repRecord?.salesRepId,
    current?.salesRepId,
    current?.id,
  ]);

  if (!isLocalJurisdiction && !isAdmin(currentRole)) {
    return res.json({
      salesRepId: repRecord?.id || current?.id || null,
      isLocalJurisdiction: false,
      doctors: [],
    });
  }

  const doctors = await buildSalesRepDoctorEntries(ownerIds);
  return res.json({
    salesRepId: repRecord?.id || current?.id || null,
    isLocalJurisdiction,
    doctors,
  });
});

router.patch('/structure/hand-delivery/doctors/:doctorUserId', authenticate, requireSalesRepOrAdmin, async (req, res) => {
  const doctorUserId = String(req.params?.doctorUserId || '').trim();
  const requested = req.body?.handDelivered;
  if (!doctorUserId) {
    return res.status(400).json({ error: 'doctorUserId is required' });
  }
  if (typeof requested !== 'boolean') {
    return res.status(400).json({ error: 'handDelivered boolean is required' });
  }

  const current = req.currentUser || userRepository.findById(req.user?.id);
  const currentRole = normalizeRole(current?.role);
  const repRecord = resolveCurrentSalesRepRecord(current);
  const repJurisdiction = String(repRecord?.jurisdiction || '').trim().toLowerCase();
  const isLocalJurisdiction = repJurisdiction === 'local';
  if (!isLocalJurisdiction && !isAdmin(currentRole)) {
    return res.status(403).json({ error: 'Local sales rep jurisdiction required' });
  }

  const doctor = userRepository.findById(doctorUserId);
  if (!doctor || !isDoctorUser(doctor)) {
    return res.status(404).json({ error: 'Doctor not found' });
  }

  if (!isAdmin(currentRole)) {
    const ownerIds = normalizeOwnershipIds([
      repRecord?.id,
      repRecord?.salesRepId,
      current?.salesRepId,
      current?.id,
    ]);
    const doctors = await buildSalesRepDoctorEntries(ownerIds);
    const allowed = doctors.some((entry) => entry.userId === doctorUserId);
    if (!allowed) {
      return res.status(403).json({ error: 'Doctor access required' });
    }
  }

  const updated = userRepository.update({
    ...doctor,
    handDelivered: requested,
    hand_delivered: requested ? 1 : 0,
  });
  if (!updated) {
    return res.status(500).json({ error: 'Unable to update doctor hand delivery' });
  }

  return res.json({
    entry: {
      userId: String(updated.id),
      salesRepId: updated?.salesRepId ? String(updated.salesRepId) : null,
      name: String(updated?.name || updated?.email || `Doctor ${updated?.id || ''}`).trim(),
      email: updated?.email ? String(updated.email).trim().toLowerCase() : null,
      role: normalizeRole(updated?.role || ''),
      handDelivered: Boolean(updated?.handDelivered || updated?.hand_delivered),
    },
  });
});

const parseActivityWindow = (raw) => {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'hour' || normalized === '1h' || normalized === 'last_hour') return 'hour';
  if (normalized === 'day' || normalized === '1d' || normalized === 'last_day') return 'day';
  if (normalized === '3days' || normalized === '3d' || normalized === '3_days') return '3days';
  if (normalized === 'week' || normalized === '7d' || normalized === 'last_week') return 'week';
  if (normalized === 'month' || normalized === '30d' || normalized === 'last_month') return 'month';
  if (normalized === '6months' || normalized === '6mo' || normalized === 'half_year') return '6months';
  if (normalized === 'year' || normalized === '12mo' || normalized === '365d' || normalized === 'last_year') return 'year';
  return 'day';
};

const windowMs = (windowKey) => {
  switch (windowKey) {
    case 'hour':
      return 60 * 60 * 1000;
    case 'day':
      return 24 * 60 * 60 * 1000;
    case '3days':
      return 3 * 24 * 60 * 60 * 1000;
    case 'week':
      return 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return 30 * 24 * 60 * 60 * 1000;
    case '6months':
      return 182 * 24 * 60 * 60 * 1000;
    case 'year':
      return 365 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
};

const normalizeUserRole = (role) => String(role || '').trim().toLowerCase() || 'unknown';
const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));
const fallbackLiveUsers = [
  {
    id: 'pseudo-live-1',
    name: 'Courtney Gillenwater',
    email: 'demo.live1@peppro.net',
    role: 'sales_rep',
  },
  {
    id: 'pseudo-live-2',
    name: 'Linden Mosk',
    email: 'demo.live2@peppro.net',
    role: 'admin',
  },
  {
    id: 'pseudo-live-3',
    name: 'Avery Stone',
    email: 'demo.live3@peppro.net',
    role: 'doctor',
  },
  {
    id: 'pseudo-live-4',
    name: 'Jordan Miles',
    email: 'demo.live4@peppro.net',
    role: 'sales_rep',
  },
  {
    id: 'pseudo-live-5',
    name: 'Riley Quinn',
    email: 'demo.live5@peppro.net',
    role: 'doctor',
  },
];

const buildLiveUsersPayload = () => {
  const nowMs = Date.now();
  const onlineThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_ONLINE_THRESHOLD_MINUTES, 45),
    1,
    24 * 60,
  );
  const idleThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_IDLE_THRESHOLD_MINUTES, 5),
    1,
    12 * 60,
  );
  const pseudoLiveEnabled = String(
    process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS || 'false',
  ).toLowerCase() === 'true';
  const pseudoLiveCount = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS_COUNT, 4),
    1,
    12,
  );
  const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
  const idleThresholdMs = idleThresholdMinutes * 60 * 1000;

  const normalized = userRepository.getAll().map((user) => {
    const snapshot = computePresenceSnapshot({
      user,
      nowMs,
      onlineThresholdMs,
      idleThresholdMs,
    });
    return {
      id: user.id,
      name: user.name || null,
      email: user.email || null,
      role: normalizeUserRole(user.role),
      profileImageUrl: user.profileImageUrl || null,
      ...snapshot,
    };
  });

  let liveUsers = normalized.filter((user) => user.isOnline);
  if (pseudoLiveEnabled && liveUsers.length < pseudoLiveCount) {
    const liveIds = new Set(liveUsers.map((user) => user.id));
    const liveEmails = new Set(
      liveUsers.map((user) => user.email).filter((email) => email),
    );
    const needed = Math.max(0, pseudoLiveCount - liveUsers.length);
    const extras = fallbackLiveUsers
      .filter((entry) => !liveIds.has(entry.id) && !liveEmails.has(entry.email))
      .slice(0, needed)
      .map((entry, index) => ({
        id: entry.id,
        name: entry.name || null,
        email: entry.email || null,
        role: normalizeUserRole(entry.role),
        profileImageUrl: null,
        isOnline: true,
        isIdle: (liveUsers.length + index) % 3 === 0,
        isSimulated: true,
        lastLoginAt: new Date(nowMs - (index + 1) * 12 * 60 * 1000).toISOString(),
        lastSeenAt: null,
        lastInteractionAt: null,
        idleMinutes: null,
        onlineMinutes: null,
      }));
    if (extras.length > 0) {
      liveUsers = [...liveUsers, ...extras];
    }
  }

  liveUsers = liveUsers.sort((a, b) =>
    String(a?.name || a?.email || a?.id || '')
      .toLowerCase()
      .localeCompare(String(b?.name || b?.email || b?.id || '').toLowerCase()),
  );

  const sig = liveUsers.map((entry) => ({
    id: entry.id,
    role: entry.role || 'unknown',
    isOnline: Boolean(entry.isOnline),
    isIdle: Boolean(entry.isIdle),
    lastLoginAt: entry.lastLoginAt || null,
    profileImageUrl: entry.profileImageUrl || null,
  }));
  sig.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  const etag = crypto
    .createHash('sha256')
    .update(JSON.stringify({ users: sig }))
    .digest('hex');

  return {
    etag,
    generatedAt: new Date().toISOString(),
    users: liveUsers,
    total: liveUsers.length,
  };
};

router.get('/live-users', authenticate, requireAdminOrSalesLead, async (_req, res) => {
  res.json(buildLiveUsersPayload());
});

router.get('/database-visualizer', authenticate, requireAdmin, async (req, res) => {
  if (mysqlClient.isEnabled()) {
    return res.status(501).json({
      error: 'Node database visualizer only exposes mock data right now. Use the Python backend for live schema browsing.',
    });
  }

  return res.json(
    getDatabaseVisualizerMockPayload({
      tableName: req.query?.table,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
      sortColumn: req.query?.sortColumn,
      sortDirection: req.query?.sortDirection,
      searchTerm: req.query?.search,
    }),
  );
});

router.get('/live-users/longpoll', authenticate, requireAdminOrSalesLead, async (_req, res) => {
  res.json(buildLiveUsersPayload());
});

router.get('/live-clients', authenticate, requireSalesRepOrAdmin, async (req, res) => {
  const nowMs = Date.now();
  const onlineThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_ONLINE_THRESHOLD_MINUTES, 45),
    1,
    24 * 60,
  );
  const idleThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_IDLE_THRESHOLD_MINUTES, 5),
    1,
    12 * 60,
  );
  const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
  const idleThresholdMs = idleThresholdMinutes * 60 * 1000;

  const current = req.currentUser || userRepository.findById(req.user?.id);
  const role = normalizeRole(current?.role);
  const requestedSalesRepId =
    isAdmin(role) && typeof req.query?.salesRepId === 'string'
      ? req.query.salesRepId
      : null;
  const allowedOwnerIds = Array.from(
    new Set(
      [
        requestedSalesRepId,
        current?.salesRepId,
        current?.id,
      ]
        .filter(Boolean)
        .map((value) => String(value)),
    ),
  );

  let prospects = [];
  try {
    const all = await salesProspectRepository.getAll();
    prospects = (all || []).filter(
      (record) => record?.salesRepId && allowedOwnerIds.includes(String(record.salesRepId)),
    );
  } catch (error) {
    logger.warn(
      { err: error, userId: current?.id || null },
      'Failed to load sales prospects for live clients',
    );
  }

  const doctorIdSet = new Set(
    prospects
      .map((record) => (record?.doctorId ? String(record.doctorId) : null))
      .filter(Boolean),
  );
  const emailSet = new Set(
    prospects
      .map((record) => (record?.contactEmail ? String(record.contactEmail).trim().toLowerCase() : null))
      .filter(Boolean),
  );

  const users = userRepository.getAll();
  const doctors = (users || []).filter((candidate) => {
    const candidateRole = normalizeUserRole(candidate?.role);
    if (candidateRole !== 'doctor' && candidateRole !== 'test_doctor') {
      return false;
    }
    const idMatch = candidate?.id && doctorIdSet.has(String(candidate.id));
    const email = candidate?.email ? String(candidate.email).trim().toLowerCase() : '';
    const emailMatch = email && emailSet.has(email);
    return idMatch || emailMatch;
  });

  const clients = doctors
    .map((user) => {
      const snapshot = computePresenceSnapshot({
        user,
        nowMs,
        onlineThresholdMs,
        idleThresholdMs,
      });
      return {
        id: user.id,
        name: user.name || null,
        email: user.email || null,
        role: normalizeUserRole(user.role),
        profileImageUrl: user.profileImageUrl || null,
        ...snapshot,
      };
    })
    .filter((entry) => entry.isOnline)
    .sort((a, b) => {
      const aIdle = Boolean(a.isIdle);
      const bIdle = Boolean(b.isIdle);
      if (aIdle !== bIdle) return aIdle ? 1 : -1;
      const aName = String(a?.name || a?.email || a?.id || '').toLowerCase();
      const bName = String(b?.name || b?.email || b?.id || '').toLowerCase();
      return aName.localeCompare(bName);
    });

  res.json({
    generatedAt: new Date().toISOString(),
    salesRepId: requestedSalesRepId || current?.salesRepId || current?.id || null,
    clients,
  });
});

router.get('/user-activity', authenticate, requireAdmin, async (req, res) => {
  const windowKey = parseActivityWindow(req.query?.window);
  const cutoffMs = Date.now() - windowMs(windowKey);
  const nowMs = Date.now();
  const onlineThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_ONLINE_THRESHOLD_MINUTES, 45),
    1,
    24 * 60,
  );
  const idleThresholdMinutes = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_IDLE_THRESHOLD_MINUTES, 5),
    1,
    12 * 60,
  );
  // Default OFF: pseudo-live users are only for demos/dev; they can look like "stuck online" accounts.
  const pseudoLiveEnabled = String(
    process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS || 'false',
  ).toLowerCase() === 'true';
  const pseudoLiveCount = clampNumber(
    parseNumber(process.env.USER_ACTIVITY_PSEUDO_LIVE_USERS_COUNT, 4),
    1,
    12,
  );
  const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
  const idleThresholdMs = idleThresholdMinutes * 60 * 1000;

  const users = userRepository.getAll();
  const normalized = users.map((user) => {
    const lastLoginAt = user?.lastLoginAt || null;
    const lastLoginMs = lastLoginAt ? Date.parse(lastLoginAt) : NaN;
    const hasLoginTs = Number.isFinite(lastLoginMs);
    const lastSeenAt = user?.lastSeenAt || lastLoginAt || null;
    const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
    const hasSeenTs = Number.isFinite(lastSeenMs);
    const lastInteractionAt = user?.lastInteractionAt || null;
    const lastInteractionMs = lastInteractionAt ? Date.parse(lastInteractionAt) : NaN;
    const hasInteractionTs = Number.isFinite(lastInteractionMs);

    // Online is derived from recent presence. Do not trust a persisted `isOnline` flag,
    // since it can become stale (e.g., a tab closed without cleanup).
    const isOnline =
      (hasSeenTs && (nowMs - lastSeenMs) <= onlineThresholdMs)
      || (!hasSeenTs && hasLoginTs && (nowMs - lastLoginMs) <= onlineThresholdMs);

    const explicitIdle = typeof user?.isIdle === 'boolean' ? user.isIdle : null;
    const idleAnchorMs = hasInteractionTs ? lastInteractionMs : (hasLoginTs ? lastLoginMs : lastSeenMs);
    const hasIdleAnchor = Number.isFinite(idleAnchorMs);
    const computedIdle = isOnline && hasIdleAnchor ? (nowMs - idleAnchorMs) >= idleThresholdMs : null;
    return {
      id: user.id,
      name: user.name || null,
      email: user.email || null,
      role: normalizeUserRole(user.role),
      isOnline,
      isIdle: explicitIdle ?? computedIdle,
      lastLoginAt,
      lastSeenAt,
      lastInteractionAt,
      profileImageUrl: user.profileImageUrl || null,
    };
  });

  let recent = normalized
    .filter((user) => {
      if (!user.lastLoginAt) return false;
      const ts = Date.parse(user.lastLoginAt);
      if (Number.isNaN(ts)) return false;
      return ts >= cutoffMs;
    })
    .sort((a, b) => Date.parse(b.lastLoginAt || '') - Date.parse(a.lastLoginAt || ''));

  let liveUsers = normalized.filter((user) => user.isOnline);
  if (pseudoLiveEnabled && liveUsers.length < pseudoLiveCount) {
    const liveIds = new Set(liveUsers.map((user) => user.id));
    const seed = (recent.length > 0 ? recent : normalized)
      .filter((user) => !liveIds.has(user.id));
    const needed = Math.max(0, pseudoLiveCount - liveUsers.length);
    if (seed.length > 0 && needed > 0) {
      const pseudo = seed.slice(0, needed).map((user, index) => ({
        ...user,
        isOnline: true,
        isIdle: (liveUsers.length + index) % 3 === 0,
        isSimulated: true,
      }));
      const pseudoMap = new Map(pseudo.map((user) => [user.id, user]));
      recent = recent.map((user) => pseudoMap.get(user.id) || user);
      liveUsers = [...liveUsers, ...pseudo];
    }
  }
  if (pseudoLiveEnabled && liveUsers.length < pseudoLiveCount) {
    const liveIds = new Set(liveUsers.map((user) => user.id));
    const liveEmails = new Set(
      liveUsers.map((user) => user.email).filter((email) => email),
    );
    const needed = Math.max(0, pseudoLiveCount - liveUsers.length);
    const extras = fallbackLiveUsers
      .filter((entry) => !liveIds.has(entry.id) && !liveEmails.has(entry.email))
      .slice(0, needed)
      .map((entry, index) => ({
        id: entry.id,
        name: entry.name || null,
        email: entry.email || null,
        role: normalizeUserRole(entry.role),
        isOnline: true,
        isIdle: (liveUsers.length + index) % 3 === 0,
        isSimulated: true,
        lastLoginAt: new Date(nowMs - (index + 1) * 12 * 60 * 1000).toISOString(),
        profileImageUrl: null,
      }));
    if (extras.length > 0) {
      liveUsers = [...liveUsers, ...extras];
    }
  }
  liveUsers = liveUsers.sort((a, b) =>
    String(a?.name || a?.email || a?.id || '')
      .toLowerCase()
      .localeCompare(String(b?.name || b?.email || b?.id || '').toLowerCase()),
  );

  const byRole = recent.reduce((acc, user) => {
    const role = user.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});

  res.json({
    window: windowKey,
    generatedAt: new Date().toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    liveUsers,
    total: recent.length,
    byRole,
    users: recent,
  });
});

router.get('/live-clients', authenticate, requireSalesRepOrAdmin, async (req, res) => {
  try {
    const currentUser = req.currentUser || req.user;
    const role = normalizeRole(currentUser?.role);
    const requestedSalesRepId = typeof req.query?.salesRepId === 'string'
      ? req.query.salesRepId
      : null;

    const targetSalesRepId = isAdmin(role) && requestedSalesRepId
      ? String(requestedSalesRepId)
      : String(currentUser?.id || '');

    if (!targetSalesRepId) {
      return res.status(400).json({ error: 'salesRepId is required' });
    }

    const onlineThresholdMinutes = clampNumber(
      parseNumber(process.env.USER_ACTIVITY_ONLINE_THRESHOLD_MINUTES, 45),
      1,
      24 * 60,
    );
    const idleThresholdMinutes = clampNumber(
      parseNumber(process.env.USER_ACTIVITY_IDLE_THRESHOLD_MINUTES, 5),
      1,
      12 * 60,
    );
    const onlineThresholdMs = onlineThresholdMinutes * 60 * 1000;
    const idleThresholdMs = idleThresholdMinutes * 60 * 1000;
    const nowMs = Date.now();

    const prospects = await salesProspectRepository.getAll();
    const ownedProspects = (prospects || []).filter(
      (p) => String(p?.salesRepId || '') === targetSalesRepId,
    );
    const doctorIds = new Set(
      ownedProspects.map((p) => p?.doctorId).filter(Boolean).map(String),
    );
    const doctorEmails = new Set(
      ownedProspects
        .map((p) => (p?.contactEmail || '').toString().trim().toLowerCase())
        .filter(Boolean),
    );

    const doctorUsers = userRepository
      .getAll()
      .filter((candidate) => {
        const candidateRole = normalizeRole(candidate?.role);
        if (candidateRole !== 'doctor' && candidateRole !== 'test_doctor') {
          return false;
        }
        if (doctorIds.size > 0 && doctorIds.has(String(candidate.id))) {
          return true;
        }
        const email = (candidate.email || '').toString().trim().toLowerCase();
        return Boolean(email && doctorEmails.has(email));
      })
      .map((doctor) => {
        const snapshot = computePresenceSnapshot({
          user: doctor,
          nowMs,
          onlineThresholdMs,
          idleThresholdMs,
        });
        return {
          id: doctor.id,
          name: doctor.name || null,
          email: doctor.email || null,
          role: normalizeRole(doctor.role),
          profileImageUrl: doctor.profileImageUrl || null,
          ...snapshot,
        };
      })
      .filter((entry) => entry.isOnline);

    res.json({
      generatedAt: new Date().toISOString(),
      salesRepId: targetSalesRepId,
      clients: doctorUsers,
      total: doctorUsers.length,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load live clients');
    res.status(500).json({ error: 'Unable to load live clients' });
  }
});

router.post('/presence', authenticate, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'User not found' });
  }
  const nowIso = new Date().toISOString();
  const kind = (req.body?.kind || 'heartbeat').toString();
  const isIdle = typeof req.body?.isIdle === 'boolean' ? req.body.isIdle : null;

  const existing = userRepository.findById(userId);
  if (!existing) {
    return res.status(401).json({ error: 'User not found' });
  }

  const next = {
    ...existing,
    isOnline: true,
    isIdle: isIdle ?? existing.isIdle ?? false,
    lastSeenAt: nowIso,
    lastInteractionAt:
      (kind === 'interaction' || (kind === 'heartbeat' && isIdle === false))
        ? nowIso
        : (existing.lastInteractionAt || null),
  };

  userRepository.update(next);

  return res.json({
    ok: true,
    now: nowIso,
    kind,
    isIdle: next.isIdle,
    lastSeenAt: next.lastSeenAt,
    lastInteractionAt: next.lastInteractionAt,
  });
});

module.exports = router;
