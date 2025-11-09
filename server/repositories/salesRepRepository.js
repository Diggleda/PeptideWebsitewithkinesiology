const { salesRepStore } = require('../storage');

const normalizeEmail = (value) => {
  if (!value) {
    return '';
  }
  return String(value).trim().toLowerCase();
};

const ensureDefaults = (record) => {
  if (!record || typeof record !== 'object') {
    return record;
  }
  return {
    id: record.id || record.salesRepId || null,
    name: record.name || null,
    email: record.email || null,
    phone: record.phone || null,
    status: record.status || null,
    role: record.role || null,
    ...record,
  };
};

const load = () => {
  const reps = salesRepStore.read();
  return Array.isArray(reps) ? reps.map(ensureDefaults) : [];
};

const findByEmail = (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  const reps = load();
  return reps.find((rep) => normalizeEmail(rep.email) === normalized) || null;
};

const getAll = () => load();

module.exports = {
  getAll,
  findByEmail,
};
