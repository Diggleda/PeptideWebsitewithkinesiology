const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshService = async ({
  mysqlClient,
  userRepository,
  decryptJson,
  encryptJson,
}, run) => {
  const originalLoad = Module._load;

  clearModule('../services/accountDeletionService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../config/logger') {
      return {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      };
    }
    if (request === '../database/mysqlClient') {
      return mysqlClient;
    }
    if (request === '../repositories/userRepository') {
      return userRepository;
    }
    if (request === '../utils/cryptoEnvelope') {
      return {
        decryptJson,
        encryptJson,
      };
    }
    if (request === '../storage') {
      const store = {
        read: () => [],
        write() {},
      };
      return {
        orderStore: store,
        referralStore: store,
        referralCodeStore: store,
        salesRepStore: store,
        salesProspectStore: store,
        creditLedgerStore: store,
        peptideForumStore: store,
      };
    }
    if (request === '../constants/deletedUser') {
      return { DELETED_USER_ID: '0000000000000' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/accountDeletionService');
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/accountDeletionService');
  }
};

test('deleteAccountAndRewriteReferences rewrites inline encrypted JSON fields', async () => {
  const executeCalls = [];
  const mysqlClient = {
    isEnabled: () => true,
    execute: async (query, params) => {
      executeCalls.push({ query, params });
      return { affectedRows: 1 };
    },
    fetchAll: async (query) => {
      if (query === 'SELECT * FROM orders') {
        return [
          {
            id: 'order-1',
            payload: 'cipher-order-payload',
            shipping_address: 'cipher-order-shipping',
          },
        ];
      }
      if (query === 'SELECT * FROM peppro_orders') {
        return [
          {
            id: 'order-2',
            payload_encrypted: 'cipher-peppro-payload',
            phi_payload_ref: 'legacy-ref',
          },
        ];
      }
      return [];
    },
  };
  const userRepository = {
    findById: () => ({ id: 'doctor-1' }),
    removeById() {},
  };

  await withFreshService(
    {
      mysqlClient,
      userRepository,
      decryptJson: (value, options = {}) => {
        if (
          value === 'cipher-order-payload'
          && options?.aad?.table === 'orders'
          && options?.aad?.field === 'payload'
        ) {
          return { userId: 'doctor-1' };
        }
        if (
          value === 'cipher-order-shipping'
          && options?.aad?.table === 'orders'
          && options?.aad?.field === 'shipping_address'
        ) {
          return { contactId: 'doctor-1' };
        }
        if (
          value === 'cipher-peppro-payload'
          && options?.aad?.table === 'peppro_orders'
          && options?.aad?.record_ref === 'legacy-ref'
          && options?.aad?.field === 'payload'
        ) {
          return { order: { userId: 'doctor-1' } };
        }
        return null;
      },
      encryptJson: (value, options = {}) => `cipher:${options?.aad?.table}:${options?.aad?.field}:${JSON.stringify(value)}`,
    },
    async (service) => {
      await service.deleteAccountAndRewriteReferences({ userId: 'doctor-1' });
    },
  );

  assert.ok(executeCalls.some(({ query, params }) =>
    query === 'UPDATE orders SET payload = :value WHERE id = :id'
    && params.id === 'order-1'
    && params.value.includes('0000000000000')));
  assert.ok(executeCalls.some(({ query, params }) =>
    query === 'UPDATE orders SET shipping_address = :value WHERE id = :id'
    && params.id === 'order-1'
    && params.value.includes('0000000000000')));
  assert.ok(executeCalls.some(({ query, params }) =>
    query === 'UPDATE peppro_orders SET payload = :value WHERE id = :id'
    && params.id === 'order-2'
    && params.value.includes('0000000000000')));
  assert.ok(!executeCalls.some(({ query }) => /REPLACE\(payload/i.test(query)));
});
