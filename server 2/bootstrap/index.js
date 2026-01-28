const { initStorage } = require('../storage');
const { logger } = require('../config/logger');
const { env } = require('../config/env');

const bootstrap = async () => {
  initStorage();
  logger.info({ dataDir: env.dataDir }, 'Storage initialized');
};

module.exports = { bootstrap };
