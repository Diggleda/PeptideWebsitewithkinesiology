const { JsonStore } = require('./jsonStore');
const { env } = require('../config/env');

const userStore = new JsonStore(env.dataDir, 'users.json', []);
const orderStore = new JsonStore(env.dataDir, 'orders.json', []);

const initStorage = () => {
  userStore.init();
  orderStore.init();
};

module.exports = {
  userStore,
  orderStore,
  initStorage,
};
