const { JsonStore } = require('./jsonStore');
const { env } = require('../config/env');

const userStore = new JsonStore(env.dataDir, 'users.json', []);
const orderStore = new JsonStore(env.dataDir, 'orders.json', []);
const salesRepStore = new JsonStore(env.dataDir, 'sales-reps.json', []);
const referralStore = new JsonStore(env.dataDir, 'referrals.json', []);
const referralCodeStore = new JsonStore(env.dataDir, 'referral-codes.json', []);
const salesProspectStore = new JsonStore(env.dataDir, 'sales-prospects.json', []);
const creditLedgerStore = new JsonStore(env.dataDir, 'credit-ledger.json', []);
const crmLeadActivityStore = new JsonStore(env.dataDir, 'crm-lead-activity.json', []);
const crmAssignmentRulesStore = new JsonStore(env.dataDir, 'crm-assignment-rules.json', []);
const crmSyncCheckpointStore = new JsonStore(env.dataDir, 'crm-sync-checkpoint.json', []);
const seamlessStore = new JsonStore(env.dataDir, 'seamless.json', []);
const peptideForumStore = new JsonStore(env.dataDir, 'the-peptide-forum.json', {
  updatedAt: null,
  items: [],
});
const settingsStore = new JsonStore(env.dataDir, 'settings.json', {
  shopEnabled: true,
  peptideForumEnabled: true,
  stripeMode: null,
  salesBySalesRepCsvDownloadedAt: null,
  salesLeadSalesBySalesRepCsvDownloadedAt: null,
});

const initStorage = () => {
  userStore.init();
  orderStore.init();
  salesRepStore.init();
  referralStore.init();
  referralCodeStore.init();
  salesProspectStore.init();
  creditLedgerStore.init();
  crmLeadActivityStore.init();
  crmAssignmentRulesStore.init();
  crmSyncCheckpointStore.init();
  seamlessStore.init();
  peptideForumStore.init();
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
  crmLeadActivityStore,
  crmAssignmentRulesStore,
  crmSyncCheckpointStore,
  seamlessStore,
  peptideForumStore,
  settingsStore,
  initStorage,
};
