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
  const role = (record.role || '').toLowerCase() === 'rep' ? 'sales_rep' : (record.role || null);
  return {
    id: record.id || record.salesRepId || null,
    name: record.name || null,
    email: record.email || null,
    phone: record.phone || null,
    status: record.status || null,
    role,
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

const save = (records) => {
  salesRepStore.write(records.map(ensureDefaults));
};

const update = (rep) => {
  const reps = load();
  const idx = reps.findIndex((item) => item.id === rep.id || item.salesRepId === rep.id);
  if (idx === -1) {
    return null;
  }
  const updated = ensureDefaults({ ...reps[idx], ...rep, id: reps[idx].id || rep.id });
  reps[idx] = updated;
  save(reps);
  return updated;
};

module.exports = {
  getAll,
  findByEmail,
  update,
};
