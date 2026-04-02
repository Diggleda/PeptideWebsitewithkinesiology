const { salesRepStore } = require('../storage');

const normalizeEmail = (value) => {
  if (!value) {
    return '';
  }
  return String(value).trim().toLowerCase();
};

const normalizeBooleanFlag = (value) => {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1'
      || normalized === 'true'
      || normalized === 'yes'
      || normalized === 'y'
      || normalized === 'on';
  }
  return false;
};

const ensureDefaults = (record) => {
  if (!record || typeof record !== 'object') {
    return record;
  }
  const rawRole = String(record.role || '').trim().toLowerCase();
  const role = rawRole === 'rep' || rawRole === 'sales_partner' ? 'sales_rep' : (record.role || null);
  const isPartner = normalizeBooleanFlag(record.isPartner ?? record.is_partner);
  const allowedRetail = normalizeBooleanFlag(record.allowedRetail ?? record.allowed_retail);
  return {
    ...record,
    id: record.id || record.salesRepId || null,
    name: record.name || null,
    email: record.email || null,
    phone: record.phone || null,
    status: record.status || null,
    role,
    isPartner,
    allowedRetail,
  };
};

const load = () => {
  const reps = typeof salesRepStore.readCached === 'function' ? salesRepStore.readCached() : salesRepStore.read();
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

const normalizeId = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const findById = (id) => {
  const target = normalizeId(id);
  if (!target) return null;
  const reps = load();
  return (
    reps.find(
      (rep) =>
        normalizeId(rep.id) === target || normalizeId(rep.salesRepId) === target,
    ) || null
  );
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
  findById,
  findByEmail,
  update,
};
