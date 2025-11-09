const { JsonStore } = require('./jsonStore');
const { env } = require('../config/env');

const userStore = new JsonStore(env.dataDir, 'users.json', []);
const orderStore = new JsonStore(env.dataDir, 'orders.json', []);
const salesRepStore = new JsonStore(env.dataDir, 'sales-reps.json', []);

const initStorage = () => {
  userStore.init();
  orderStore.init();
  salesRepStore.init();
};

module.exports = {
  userStore,
  orderStore,
  salesRepStore,
  initStorage,
};
