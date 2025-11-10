const { userStore } = require('../storage');

const normalizeNpiNumber = (value) => {
  if (!value) {
    return '';
  }
  return String(value).replace(/[^0-9]/g, '').slice(0, 10);
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
  if (!normalized.role) {
    normalized.role = 'doctor';
  }
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
  return normalized;
};

const loadUsers = () => {
  const users = userStore.read();
  let changed = false;
  const normalized = users.map((user) => {
    const candidate = ensureUserDefaults(user);
    if (
      candidate.visits !== user.visits
      || candidate.lastLoginAt !== user.lastLoginAt
      || candidate.referralCredits !== user.referralCredits
      || candidate.totalReferrals !== user.totalReferrals
    ) {
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
