const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshService = async ({
  env,
  mysqlClient,
  orderSqlRepository,
  upsTrackingService,
}, run) => {
  const originalLoad = Module._load;
  clearModule('../services/upsStatusSyncService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../config/env') {
      return { env };
    }
    if (request === '../config/logger') {
      return {
        logger: {
          warn() {},
          info() {},
          error() {},
        },
      };
    }
    if (request === '../database/mysqlClient') {
      return mysqlClient;
    }
    if (request === '../repositories/orderSqlRepository') {
      return orderSqlRepository;
    }
    if (request === './upsTrackingService') {
      return upsTrackingService;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/upsStatusSyncService');
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/upsStatusSyncService');
  }
};

test('fetchOrdersForSync filters non-UPS, delivered, terminal, and hand-delivered orders', async () => {
  const env = {
    upsSync: {
      enabled: true,
      lookbackDays: 60,
      maxOrders: 10,
      throttleMs: 0,
    },
  };
  const mysqlClient = { isEnabled: () => true };
  const orderSqlRepository = {
    fetchRecentForUpsSync: async () => ([
      {
        id: 'ups-1',
        trackingNumber: '1ZTEST001',
        shippingCarrier: 'ups',
        status: 'processing',
      },
      {
        id: 'ups-2',
        trackingNumber: '1ZTEST002',
        shippingCarrier: 'ups',
        status: 'processing',
        upsTrackingStatus: 'delivered',
      },
      {
        id: 'fedex-1',
        trackingNumber: '999999',
        shippingCarrier: 'fedex',
        status: 'processing',
      },
      {
        id: 'cancelled-1',
        trackingNumber: '1ZTEST003',
        shippingCarrier: 'ups',
        status: 'cancelled',
      },
      {
        id: 'hand-1',
        trackingNumber: '1ZTEST004',
        shippingCarrier: 'ups',
        status: 'processing',
        handDelivery: true,
      },
    ]),
  };
  const upsTrackingService = {
    isConfigured: () => true,
    looksLikeUpsTrackingNumber: (value) => String(value || '').startsWith('1Z'),
    normalizeTrackingStatus: (value) => value,
  };

  await withFreshService(
    { env, mysqlClient, orderSqlRepository, upsTrackingService },
    async (service) => {
      const orders = await service.fetchOrdersForSync({ lookbackDays: 60, maxOrders: 10 });
      assert.deepEqual(orders.map((order) => order.id), ['ups-1']);
    },
  );
});

test('runUpsStatusSyncOnce updates persisted ups_tracking_status for eligible orders', async () => {
  const updated = [];
  const env = {
    upsSync: {
      enabled: true,
      intervalMs: 300000,
      lookbackDays: 60,
      maxOrders: 10,
      throttleMs: 0,
    },
  };
  const mysqlClient = { isEnabled: () => true };
  const orderSqlRepository = {
    fetchRecentForUpsSync: async () => ([
      {
        id: 'ups-1',
        trackingNumber: '1ZTEST001',
        shippingCarrier: 'ups',
        status: 'processing',
      },
    ]),
    updateUpsTrackingStatus: async (orderId, payload) => {
      updated.push({ orderId, payload });
      return { id: orderId, upsTrackingStatus: payload.upsTrackingStatus };
    },
  };
  const upsTrackingService = {
    fetchUpsTrackingStatus: async () => ({ trackingStatus: 'Out for Delivery' }),
    isConfigured: () => true,
    looksLikeUpsTrackingNumber: (value) => String(value || '').startsWith('1Z'),
    normalizeTrackingStatus: (value) => {
      const token = String(value || '').toLowerCase().replace(/[^a-z]+/g, '_');
      return token.includes('out_for_delivery') ? 'out_for_delivery' : null;
    },
  };

  await withFreshService(
    { env, mysqlClient, orderSqlRepository, upsTrackingService },
    async (service) => {
      const result = await service.runUpsStatusSyncOnce();
      assert.equal(result.status, 'success');
      assert.equal(result.processed, 1);
      assert.equal(result.updated, 1);
      assert.deepEqual(updated, [
        {
          orderId: 'ups-1',
          payload: { upsTrackingStatus: 'out_for_delivery' },
        },
      ]);
    },
  );
});
