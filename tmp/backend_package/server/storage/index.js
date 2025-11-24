const { JsonStore } = require('./jsonStore');
const { env } = require('../config/env');

const userStore = new JsonStore(env.dataDir, 'users.json', []);
const orderStore = new JsonStore(env.dataDir, 'orders.json', []);
const salesRepStore = new JsonStore(env.dataDir, 'sales-reps.json', []);
const referralStore = new JsonStore(env.dataDir, 'referrals.json', []);
const referralCodeStore = new JsonStore(env.dataDir, 'referral-codes.json', []);
const creditLedgerStore = new JsonStore(env.dataDir, 'credit-ledger.json', []);

const initStorage = () => {
  userStore.init();
  orderStore.init();
  salesRepStore.init();
  referralStore.init();
  referralCodeStore.init();
  creditLedgerStore.init();
};

module.exports = {
  userStore,
  orderStore,
  salesRepStore,
  referralStore,
  referralCodeStore,
  creditLedgerStore,
  initStorage,
};
