const crypto = require('crypto');
const { referralStore } = require('../storage');

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  return String(value);
};

const getAll = () => (typeof referralStore.readCached === 'function' ? referralStore.readCached() : referralStore.read());
const getAllForWrite = () => referralStore.read();

const findById = (id) => getAll().find((referral) => referral.id === id) || null;

const findByDoctorId = (doctorId) => {
  const target = normalizeId(doctorId);
  return getAll().filter((referral) => normalizeId(referral.referrerDoctorId) === target);
};

const findBySalesRepId = (salesRepId) => {
  const target = normalizeId(salesRepId);
  return getAll().filter((referral) => normalizeId(referral.salesRepId) === target);
};

const insert = (referral) => {
  const records = getAllForWrite();
  const record = {
    id: referral.id || crypto.randomUUID(),
    ...referral,
  };
  records.push(record);
  referralStore.write(records);
  return record;
};

const update = (id, updates) => {
  const records = getAllForWrite();
  const index = records.findIndex((referral) => referral.id === id);
  if (index === -1) {
    return null;
  }
  const updated = {
    ...records[index],
    ...updates,
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  records[index] = updated;
  referralStore.write(records);
  return updated;
};

const remove = (id) => {
  const records = getAllForWrite();
  const next = records.filter((referral) => referral.id !== id);
  if (next.length === records.length) {
    return false;
  }
  referralStore.write(next);
  return true;
};

module.exports = {
  getAll,
  findById,
  findByDoctorId,
  findBySalesRepId,
  insert,
  update,
  remove,
};
