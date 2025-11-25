const { userStore } = require('../storage');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const normalizeNpiNumber = (value) => {
  if (!value) {
    return '';
  }
  return String(value).replace(/[^0-9]/g, '').slice(0, 10);
};

const DIRECT_SHIPPING_FIELDS = [
  'officeAddressLine1',
  'officeAddressLine2',
  'officeCity',
  'officeState',
  'officePostalCode',
];

const normalizeOptionalString = (value) => {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    return String(value).trim() || null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const syncDirectShippingToSql = (user) => {
  if (!mysqlClient.isEnabled()) {
    return;
  }
  const params = {
    id: user.id,
    addressLine1: user.officeAddressLine1,
    addressLine2: user.officeAddressLine2,
    city: user.officeCity,
    state: user.officeState,
    postalCode: user.officePostalCode,
  };
  mysqlClient
    .execute(
      `
        UPDATE users
        SET
          office_address_line1 = :addressLine1,
          office_address_line2 = :addressLine2,
          office_city = :city,
          office_state = :state,
          office_postal_code = :postalCode
        WHERE id = :id
      `,
      params,
    )
    .then((result) => {
      if (!result || result.affectedRows === 0) {
        logger.warn(
          { userId: user.id },
          'No rows updated while syncing direct shipping info to MySQL',
        );
      }
    })
    .catch((error) => {
      logger.error(
        { err: error, userId: user.id },
        'Failed to sync direct shipping info to MySQL',
      );
    });
};

const normalizeRole = (role) => {
  const normalized = (role || '').toLowerCase();
  if (normalized === 'sales_rep') return 'sales_rep';
  if (normalized === 'admin') return 'admin';
  if (normalized === 'test_doctor') return 'test_doctor';
  if (normalized === 'doctor') return 'doctor';
  return 'doctor';
};

const ensureUserDefaults = (user) => {
  const normalized = { ...user };
  if (typeof normalized.visits !== 'number' || Number.isNaN(normalized.visits)) {
    normalized.visits = normalized.createdAt ? 1 : 0;
  }
  if (!normalized.lastLoginAt) {
    normalized.lastLoginAt = normalized.createdAt || null;
  }
  if (!normalized.referralCredits) {
    normalized.referralCredits = 0;
  }
  if (!normalized.totalReferrals) {
    normalized.totalReferrals = 0;
  }
  if (typeof normalized.npiNumber === 'string') {
    normalized.npiNumber = normalizeNpiNumber(normalized.npiNumber) || null;
  } else if (normalized.npiNumber == null) {
    normalized.npiNumber = null;
  }
  normalized.role = normalizeRole(normalized.role);
  if (!Object.prototype.hasOwnProperty.call(normalized, 'salesRepId')) {
    normalized.salesRepId = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'npiVerification')) {
    normalized.npiVerification = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'npiLastVerifiedAt')) {
    normalized.npiLastVerifiedAt = null;
  }
  if (!Array.isArray(normalized.passkeys)) {
    normalized.passkeys = [];
  }
  DIRECT_SHIPPING_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = null;
    } else {
      normalized[field] = normalizeOptionalString(normalized[field]);
    }
  });
  return normalized;
};

const loadUsers = () => {
  const users = userStore.read();
  let changed = false;
  const normalized = users.map((user) => {
    const candidate = ensureUserDefaults(user);
    const roleChanged = candidate.role !== user.role;
    const visitsChanged = candidate.visits !== user.visits;
    const lastLoginChanged = candidate.lastLoginAt !== user.lastLoginAt;
    const creditsChanged = candidate.referralCredits !== user.referralCredits;
    const totalRefsChanged = candidate.totalReferrals !== user.totalReferrals;
    if (roleChanged || visitsChanged || lastLoginChanged || creditsChanged || totalRefsChanged) {
      changed = true;
    }
    return candidate;
  });

  if (changed) {
    userStore.write(normalized);
  }

  return normalized;
};

const saveUsers = (users) => {
  userStore.write(users.map(ensureUserDefaults));
};

const getAll = () => loadUsers();

const findByEmail = (email) => loadUsers().find((user) => user.email === email) || null;

const findById = (id) => loadUsers().find((user) => user.id === id) || null;

const findByReferralCode = (code) => loadUsers().find((user) => user.referralCode === code) || null;

const findByNpiNumber = (npiNumber) => {
  const normalized = normalizeNpiNumber(npiNumber);
  if (!normalized) {
    return null;
  }
  return loadUsers().find((user) => normalizeNpiNumber(user.npiNumber) === normalized) || null;
};

const findByPasskeyId = (credentialId) => {
  if (!credentialId) {
    return null;
  }
  const users = loadUsers();
  return users.find((user) => Array.isArray(user.passkeys)
    && user.passkeys.some((pk) => pk.credentialID === credentialId)) || null;
};

const insert = (user) => {
  const users = loadUsers();
  const candidate = ensureUserDefaults(user);
  users.push(candidate);
  saveUsers(users);
  syncDirectShippingToSql(candidate);
  return candidate;
};

const update = (user) => {
  const users = loadUsers();
  const index = users.findIndex((item) => item.id === user.id);
  if (index === -1) {
    return null;
  }
  users[index] = ensureUserDefaults({ ...users[index], ...user });
  saveUsers(users);
  syncDirectShippingToSql(users[index]);
  return users[index];
};

const replace = (predicate, updater) => {
  const users = loadUsers();
  const index = users.findIndex(predicate);
  if (index === -1) {
    return null;
  }
  const updated = ensureUserDefaults(updater(users[index]));
  users[index] = updated;
  saveUsers(users);
  return updated;
};

module.exports = {
  getAll,
  insert,
  update,
  replace,
  findByEmail,
  findById,
  findByReferralCode,
  findByNpiNumber,
  findByPasskeyId,
};
