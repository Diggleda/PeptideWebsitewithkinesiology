const { JsonStore } = require('./jsonStore');
const { env } = require('../config/env');

const userStore = new JsonStore(env.dataDir, 'users.json', []);
const orderStore = new JsonStore(env.dataDir, 'orders.json', []);
const salesRepStore = new JsonStore(env.dataDir, 'sales-reps.json', []);
const referralStore = new JsonStore(env.dataDir, 'referrals.json', []);
const referralCodeStore = new JsonStore(env.dataDir, 'referral-codes.json', []);
const salesProspectStore = new JsonStore(env.dataDir, 'sales-prospects.json', []);
const creditLedgerStore = new JsonStore(env.dataDir, 'credit-ledger.json', []);
const peptides101ClassesStore = new JsonStore(env.dataDir, 'peptides-101-classes.json', {
  updatedAt: null,
  items: [],
});
const settingsStore = new JsonStore(env.dataDir, 'settings.json', {
  shopEnabled: true,
  peptides101ClassesEnabled: true,
  stripeMode: null,
  salesBySalesRepCsvDownloadedAt: null,
});

const initStorage = () => {
  userStore.init();
  orderStore.init();
  salesRepStore.init();
  referralStore.init();
  referralCodeStore.init();
  salesProspectStore.init();
  creditLedgerStore.init();
  peptides101ClassesStore.init();
  settingsStore.init();
};

module.exports = {
  userStore,
  orderStore,
  salesRepStore,
  referralStore,
  referralCodeStore,
  salesProspectStore,
  creditLedgerStore,
  peptides101ClassesStore,
  settingsStore,
  initStorage,
};
