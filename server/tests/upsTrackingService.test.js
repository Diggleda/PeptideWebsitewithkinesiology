const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshService = async ({ axios, env }, run) => {
  const originalLoad = Module._load;
  clearModule('../services/upsTrackingService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'axios') {
      return axios;
    }
    if (request === '../config/env') {
      return { env };
    }
    if (request === '../config/logger') {
      return {
        logger: {
          warn() {},
          info() {},
          error() {},
          debug() {},
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/upsTrackingService');
    service.clearCachesForTest();
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/upsTrackingService');
  }
};

test('fetchUpsTrackingStatus uses UPS OAuth once and normalizes live statuses', async () => {
  const calls = {
    post: [],
    get: [],
  };
  const axios = {
    post: async (url, body, options) => {
      calls.post.push({ url, body, options });
      return {
        status: 200,
        data: {
          access_token: 'token-1',
          expires_in: 3600,
        },
      };
    },
    get: async (url, options) => {
      calls.get.push({ url, options });
      if (url.endsWith('/1Z999AA10123456784')) {
        return {
          status: 200,
          data: {
            trackResponse: {
              shipment: [{
                package: [{
                  currentStatus: { description: 'Delivered' },
                  deliveryDate: [{ type: 'DEL', date: '20260402' }],
                  deliveryTime: { type: 'DEL', endTime: '161500' },
                }],
              }],
            },
          },
        };
      }
      return {
        status: 200,
        data: {
          trackResponse: {
            shipment: [{
              package: [{
                currentStatus: { description: 'Out for Delivery' },
              }],
            }],
          },
        },
      };
    },
  };
  const env = {
    ups: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      merchantId: '',
      useCie: false,
      locale: 'en_US',
      transactionSrc: 'peppro',
      requestTimeoutMs: 15000,
    },
  };

  await withFreshService({ axios, env }, async (service) => {
    const delivered = await service.fetchUpsTrackingStatus('1Z999AA10123456784');
    const outForDelivery = await service.fetchUpsTrackingStatus('1Z999AA10123456785');

    assert.equal(delivered.trackingStatus, 'delivered');
    assert.equal(delivered.trackingStatusRaw, 'Delivered');
    assert.match(String(delivered.deliveredAt || ''), /2026-04-02T16:15:00\.000Z/);

    assert.equal(outForDelivery.trackingStatus, 'out_for_delivery');
    assert.equal(outForDelivery.trackingStatusRaw, 'Out for Delivery');

    assert.equal(calls.post.length, 1);
    assert.equal(calls.get.length, 2);
    assert.match(calls.post[0].url, /onlinetools\.ups\.com\/security\/v1\/oauth\/token$/);
    assert.match(calls.get[0].url, /onlinetools\.ups\.com\/api\/track\/v1\/details\/1Z999AA10123456784$/);
    assert.equal(calls.get[0].options.headers.Authorization, 'Bearer token-1');
    assert.equal(calls.get[0].options.params.locale, 'en_US');
  });
});
