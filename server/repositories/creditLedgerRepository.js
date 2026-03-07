const crypto = require('crypto');
const { creditLedgerStore } = require('../storage');

const getAll = () => (typeof creditLedgerStore.readCached === 'function'
  ? creditLedgerStore.readCached()
  : creditLedgerStore.read());
const getAllForWrite = () => creditLedgerStore.read();

const findByDoctorId = (doctorId) => getAll().filter((entry) => entry.doctorId === doctorId);

const insert = (entry) => {
  const records = getAllForWrite();
  const record = {
    id: entry.id || crypto.randomUUID(),
    currency: entry.currency || 'USD',
    direction: entry.direction || 'credit',
    firstOrderBonus: entry.firstOrderBonus === true,
    issuedAt: entry.issuedAt || new Date().toISOString(),
    ...entry,
  };
  records.push(record);
  creditLedgerStore.write(records);
  return record;
};

module.exports = {
  getAll,
  findByDoctorId,
  insert,
};
