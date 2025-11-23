const crypto = require('crypto');
const { referralStore } = require('../storage');

const getAll = () => referralStore.read();

const findById = (id) => getAll().find((referral) => referral.id === id) || null;

const findByDoctorId = (doctorId) => getAll().filter((referral) => referral.referrerDoctorId === doctorId);

const findBySalesRepId = (salesRepId) => getAll().filter((referral) => referral.salesRepId === salesRepId);

const insert = (referral) => {
  const records = getAll();
  const record = {
    id: referral.id || crypto.randomUUID(),
    ...referral,
  };
  records.push(record);
  referralStore.write(records);
  return record;
};

const update = (id, updates) => {
  const records = getAll();
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

module.exports = {
  getAll,
  findById,
  findByDoctorId,
  findBySalesRepId,
  insert,
  update,
};
