const { userStore } = require('../storage');

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
};
