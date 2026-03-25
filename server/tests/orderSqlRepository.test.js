const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshRepository = async ({ mysqlClient, encryptJson, decryptJson }, run) => {
  const originalLoad = Module._load;

  clearModule('../repositories/orderSqlRepository');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../database/mysqlClient') {
      return mysqlClient;
    }
    if (request === '../config/logger') {
      return {
        logger: {
          error() {},
          info() {},
          warn() {},
        },
      };
    }
    if (request === '../utils/cryptoEnvelope') {
      return {
        encryptJson,
        decryptJson,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const repository = require('../repositories/orderSqlRepository');
    await run(repository);
  } finally {
    Module._load = originalLoad;
    clearModule('../repositories/orderSqlRepository');
  }
};

test('persistOrder stores ciphertext inline in payload without sidecar columns', async () => {
  const calls = [];
  const mysqlClient = {
    isEnabled: () => true,
    execute: async (query, params) => {
      calls.push({ query, params });
      return 1;
    },
    fetchAll: async () => [],
    fetchOne: async () => null,
  };

  await withFreshRepository(
    {
      mysqlClient,
      encryptJson: (value, options = {}) => `cipher:${options?.aad?.field}:${options?.aad?.record_ref}:${value?.order?.id || 'none'}`,
      decryptJson: () => null,
    },
    async (repository) => {
      await repository.persistOrder({
        order: {
          id: 'order-1',
          userId: 'user-1',
          status: 'pending',
          items: [],
          createdAt: '2026-03-24T12:00:00Z',
        },
        wooOrderId: '1491',
        shipStationOrderId: 'ss-1',
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /INSERT INTO peppro_orders/);
  assert.doesNotMatch(calls[0].query, /payload_encrypted/);
  assert.doesNotMatch(calls[0].query, /phi_payload_ref/);
  assert.equal(calls[0].params.payload, 'cipher:payload:order-1:order-1');
});

test('fetchByBillingEmails reads inline encrypted payload values', async () => {
  const mysqlClient = {
    isEnabled: () => true,
    execute: async () => 1,
    fetchOne: async () => null,
    fetchAll: async (query) => {
      if (query.includes('FROM peppro_orders')) {
        return [
          {
            id: 'order-2',
            user_id: 'user-2',
            pricing_mode: 'wholesale',
            total: 120.5,
            shipping_total: 0,
            payload: 'cipher-payload',
            created_at: '2026-03-24T12:00:00Z',
            updated_at: '2026-03-24T12:00:00Z',
          },
        ];
      }
      return [];
    },
  };

  await withFreshRepository(
    {
      mysqlClient,
      encryptJson: () => null,
      decryptJson: (value) => {
        if (value === 'cipher-payload') {
          return {
            order: {
              id: 'order-2',
              billingAddress: {
                email: 'doctor@example.com',
              },
            },
          };
        }
        return null;
      },
    },
    async (repository) => {
      const orders = await repository.fetchByBillingEmails(['doctor@example.com']);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].id, 'order-2');
      assert.equal(orders[0].billingAddress.email, 'doctor@example.com');
    },
  );
});

test('fetchById decrypts legacy orders payload with orders AAD', async () => {
  const mysqlClient = {
    isEnabled: () => true,
    execute: async () => 1,
    fetchAll: async () => [],
    fetchOne: async (query) => {
      if (query.includes('FROM orders')) {
        return {
          id: 'legacy-order-1',
          user_id: 'user-9',
          pricing_mode: 'wholesale',
          total: 87.25,
          shipping_total: 0,
          payload: 'cipher-legacy-order-payload',
          created_at: '2026-03-24T12:00:00Z',
          updated_at: '2026-03-24T12:00:00Z',
        };
      }
      return null;
    },
  };

  await withFreshRepository(
    {
      mysqlClient,
      encryptJson: () => null,
      decryptJson: (value, options = {}) => {
        if (
          value === 'cipher-legacy-order-payload'
          && options?.aad?.table === 'orders'
          && options?.aad?.field === 'payload'
        ) {
          return {
            id: 'legacy-order-1',
            billingAddress: { email: 'legacy@example.com' },
          };
        }
        return null;
      },
    },
    async (repository) => {
      const order = await repository.fetchById('legacy-order-1');
      assert.equal(order.id, 'legacy-order-1');
      assert.equal(order.billingAddress.email, 'legacy@example.com');
    },
  );
});
