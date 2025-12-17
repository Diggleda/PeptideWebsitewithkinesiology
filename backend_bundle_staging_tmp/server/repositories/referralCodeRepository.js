const crypto = require('crypto');
const { referralCodeStore } = require('../storage');

const getAll = () => referralCodeStore.read();

const findById = (id) => getAll().find((code) => code.id === id) || null;

const normalizeId = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const findBySalesRepId = (salesRepId) => {
  const target = normalizeId(salesRepId);
  return getAll().filter((code) => normalizeId(code.salesRepId) === target);
};

const findByCode = (codeValue) => getAll().find((code) => code.code === codeValue) || null;

const insert = (code) => {
  const records = getAll();
  const record = {
    id: code.id || crypto.randomUUID(),
    status: code.status || 'available',
    history: Array.isArray(code.history) ? code.history : [],
    ...code,
  };
  records.push(record);
  referralCodeStore.write(records);
  return record;
};

const update = (id, updates) => {
  const records = getAll();
  const index = records.findIndex((code) => code.id === id);
  if (index === -1) {
    return null;
  }
  const updated = {
    ...records[index],
    ...updates,
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  records[index] = updated;
  referralCodeStore.write(records);
  return updated;
};

module.exports = {
  getAll,
  findById,
  findBySalesRepId,
  findByCode,
  insert,
  update,
};
