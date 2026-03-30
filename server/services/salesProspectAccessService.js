const userRepository = require('../repositories/userRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const { logger } = require('../config/logger');

const normalizeRole = (role) => (role || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

const normalizeOptionalText = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeOwnerIds = (user) => [
  normalizeOptionalText(user?.id),
  normalizeOptionalText(user?.salesRepId),
]
  .filter(Boolean)
  .map((value) => String(value));

const extractContactFormId = (identifier) => {
  const raw = String(identifier || '');
  if (!raw.startsWith('contact_form:')) return null;
  const [, value] = raw.split(':', 2);
  return normalizeOptionalText(value);
};

const isDoctorUser = (user) => {
  const role = normalizeRole(user?.role);
  return role === 'doctor' || role === 'test_doctor';
};

const isSalesLead = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'sales_lead' || normalized === 'saleslead';
};

const isSalesRep = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'sales_rep'
    || normalized === 'sales_partner'
    || normalized === 'rep'
    || normalized === 'sales_lead'
    || normalized === 'saleslead';
};

const ensureSalesRep = (user, context = 'unknown') => {
  const role = normalizeRole(user?.role);
  if (!user || (!isSalesRep(role) && role !== 'admin')) {
    logger.warn(
      {
        context,
        userId: user?.id || null,
        role: user?.role || null,
      },
      'Sales representative access required but not satisfied',
    );
    const error = new Error('Sales representative access required');
    error.status = 403;
    throw error;
  }
};

const resolveScopedProspectAccess = async ({
  identifier,
  user,
  query = {},
  context = 'unknown',
  allowSalesLeadAll = false,
} = {}) => {
  ensureSalesRep(user, context);
  const normalizedIdentifier = normalizeOptionalText(identifier);
  if (!normalizedIdentifier) {
    const error = new Error('Identifier is required');
    error.status = 400;
    throw error;
  }

  const role = normalizeRole(user?.role);
  const isAdmin = role === 'admin';
  const isLead = isSalesLead(role);
  const ownerIds = normalizeOwnerIds(user);
  const scopeAll = (isAdmin || (allowSalesLeadAll && isLead))
    && String(query?.scope || '').trim().toLowerCase() === 'all';
  const requestedSalesRepId = normalizeOptionalText(query?.salesRepId)
    || normalizeOptionalText(user?.salesRepId)
    || normalizeOptionalText(user?.id);
  const salesRepId = scopeAll ? null : requestedSalesRepId;

  let prospect = await salesProspectRepository.findById(normalizedIdentifier);
  if (!prospect && salesRepId) {
    const contactFormId = extractContactFormId(normalizedIdentifier);
    prospect = contactFormId
      ? await salesProspectRepository.findBySalesRepAndContactFormId(salesRepId, contactFormId)
      : await salesProspectRepository.findByDoctorId(normalizedIdentifier)
        || await salesProspectRepository.findBySalesRepAndDoctorId(salesRepId, normalizedIdentifier)
        || await salesProspectRepository.findBySalesRepAndReferralId(salesRepId, normalizedIdentifier);
  }

  if (prospect && !scopeAll && !isAdmin && !(allowSalesLeadAll && isLead)) {
    const owner = normalizeOptionalText(prospect?.salesRepId);
    if (owner && owner !== 'unassigned' && !ownerIds.includes(owner)) {
      const error = new Error('Prospect not found');
      error.status = 404;
      throw error;
    }
  }

  return {
    identifier: normalizedIdentifier,
    prospect,
    salesRepId,
    requestedSalesRepId,
    ownerIds,
    isAdmin,
    isLead,
    scopeAll,
  };
};

const buildProspectBaseRecord = ({
  identifier,
  existing = null,
  ownerSalesRepId = null,
  prospectSnapshot = null,
  doctorSourceSystem = 'account',
} = {}) => {
  const normalizedIdentifier = normalizeOptionalText(identifier);
  if (!normalizedIdentifier) {
    const error = new Error('Identifier is required');
    error.status = 400;
    throw error;
  }

  const snapshot = prospectSnapshot && typeof prospectSnapshot === 'object' ? prospectSnapshot : {};
  const owner = normalizeOptionalText(existing?.salesRepId)
    || normalizeOptionalText(ownerSalesRepId)
    || normalizeOptionalText(snapshot?.salesRepId)
    || normalizeOptionalText(snapshot?.ownerSalesRepId)
    || null;

  const contactName = normalizeOptionalText(
    snapshot.contactName
      || snapshot.referredContactName
      || snapshot.name,
  );
  const contactEmail = normalizeOptionalText(
    snapshot.contactEmail
      || snapshot.referredContactEmail
      || snapshot.email,
  );
  const contactPhone = normalizeOptionalText(
    snapshot.contactPhone
      || snapshot.referredContactPhone
      || snapshot.phone,
  );
  const status = normalizeOptionalText(snapshot.status)
    || normalizeOptionalText(existing?.status)
    || null;

  const contactFormId = extractContactFormId(normalizedIdentifier)
    || normalizeOptionalText(snapshot?.contactFormId);
  if (contactFormId) {
    return {
      id: normalizedIdentifier,
      salesRepId: owner,
      contactFormId,
      sourceSystem: 'contact_form',
      status: status || 'contact_form',
      isManual: false,
      contactName,
      contactEmail,
      contactPhone,
    };
  }

  if (normalizedIdentifier.startsWith('manual:')) {
    return {
      id: normalizedIdentifier,
      salesRepId: owner,
      sourceSystem: 'manual',
      status: status || 'pending',
      isManual: true,
      contactName,
      contactEmail,
      contactPhone,
    };
  }

  const doctorId = normalizeOptionalText(
    snapshot.doctorId
      || snapshot.referredContactAccountId
      || normalizedIdentifier,
  );
  const doctor = doctorId ? userRepository.findById(doctorId) : null;
  if (doctor && isDoctorUser(doctor)) {
    return {
      id: `doctor:${doctorId}`,
      salesRepId: owner,
      doctorId,
      sourceSystem: doctorSourceSystem,
      status: status || 'converted',
      isManual: true,
      contactName: contactName || normalizeOptionalText(doctor?.name),
      contactEmail: contactEmail || normalizeOptionalText(doctor?.email),
      contactPhone: contactPhone || normalizeOptionalText(doctor?.phone),
    };
  }

  return {
    id: normalizedIdentifier,
    salesRepId: owner,
    sourceSystem: normalizeOptionalText(snapshot.sourceSystem) || 'referral',
    referralId: normalizeOptionalText(snapshot.referralId) || normalizedIdentifier,
    status: status || 'pending',
    isManual: false,
    contactName,
    contactEmail,
    contactPhone,
  };
};

module.exports = {
  normalizeRole,
  normalizeOwnerIds,
  normalizeOptionalText,
  extractContactFormId,
  isDoctorUser,
  isSalesLead,
  isSalesRep,
  ensureSalesRep,
  resolveScopedProspectAccess,
  buildProspectBaseRecord,
};
