const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();

const getRequestContext = () => requestContext.getStore() || null;

module.exports = {
  requestContext,
  getRequestContext,
};

