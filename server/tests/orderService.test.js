const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const defaultEnv = {
  mysql: { enabled: false },
  orderSync: { enabled: false, intervalMs: 300000 },
  shipStation: { orderStatusLookupsEnabled: false },
  wooCommerce: {},
};

const buildCheckoutPayload = () => ({
  userId: 'rep-1',
  idempotencyKey: 'idem-order-1',
  items: [
    {
      productId: 101,
      variantId: null,
      sku: 'PEP-101',
      name: 'Tesamorelin',
      price: 100,
      quantity: 1,
    },
  ],
  total: 106.26,
  shippingAddress: {
    name: 'Rep One',
    addressLine1: '123 Main St',
    city: 'Indianapolis',
    state: 'IN',
    postalCode: '46204',
    country: 'US',
    email: 'rep@example.com',
  },
  shippingEstimate: {
    addressFingerprint: 'fp-1',
    carrierId: null,
    serviceCode: 'ups_ground',
    serviceType: 'ups_ground',
    rate: 6.26,
    currency: 'USD',
  },
  shippingTotal: 6.26,
  paymentMethod: 'zelle',
  pricingMode: 'retail',
  physicianCertification: true,
});

const withFreshService = async (deps, run) => {
  const originalLoad = Module._load;
  clearModule('../services/orderService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../config/env') {
      return { env: deps.env || defaultEnv };
    }
    if (request === '../repositories/orderRepository') {
      return deps.orderRepository;
    }
    if (request === '../repositories/userRepository') {
      return deps.userRepository;
    }
    if (request === '../repositories/salesRepRepository') {
      return deps.salesRepRepository || { findById: () => null, findByEmail: () => null };
    }
    if (request === '../repositories/salesProspectRepository') {
      return deps.salesProspectRepository || { getAll: async () => [] };
    }
    if (request === './referralService') {
      return deps.referralService || { applyReferralCredit: () => null };
    }
    if (request === './emailService') {
      return deps.emailService || { sendOrderPaymentInstructionsEmail: async () => {} };
    }
    if (request === '../integration/wooCommerceClient') {
      return deps.wooCommerceClient;
    }
    if (request === '../integration/shipEngineClient') {
      return deps.shipEngineClient || {
        forwardShipment: async () => ({ status: 'skipped' }),
      };
    }
    if (request === '../integration/shipStationClient') {
      return deps.shipStationClient || {
        forwardOrder: async () => ({ status: 'skipped' }),
        isConfigured: () => false,
      };
    }
    if (request === './paymentService') {
      return deps.paymentService || {};
    }
    if (request === './taxTrackingService') {
      return deps.taxTrackingService || {
        canonicalizeState: () => ({ stateCode: 'IN' }),
        getStateTaxProfile: async () => ({ nexusTriggered: false }),
      };
    }
    if (request === '../integration/stripeClient') {
      return deps.stripeClient || {};
    }
    if (request === './upsTrackingService') {
      return deps.upsTrackingService || {
        fetchUpsTrackingStatus: async () => null,
        isConfigured: () => false,
        looksLikeUpsTrackingNumber: () => false,
        normalizeTrackingStatus: () => null,
      };
    }
    if (request === './shippingValidation') {
      return deps.shippingValidation || {
        ensureShippingAddress: (value) => value,
        ensureShippingData: ({ shippingAddress, shippingEstimate, shippingTotal }) => ({
          shippingAddress,
          shippingEstimate,
          shippingTotal,
        }),
        createAddressFingerprint: () => 'fp-1',
        normalizeAmount: (value) => Number(value),
      };
    }
    if (request === '../config/logger') {
      return {
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
      };
    }
    if (request === '../repositories/orderSqlRepository') {
      return deps.orderSqlRepository || {
        persistOrder: async () => ({ status: 'success' }),
        fetchByUserId: async () => [],
        fetchById: async () => null,
      };
    }
    if (request === '../database/mysqlClient') {
      return deps.mysqlClient || {
        isEnabled: () => false,
        fetchOne: async () => null,
        fetchAll: async () => [],
        execute: async () => 1,
      };
    }
    if (request === '../constants/deletedUser') {
      return {
        DELETED_USER_ID: 'deleted-user',
        DELETED_USER_NAME: 'Deleted User',
      };
    }
    if (request === '../utils/timeZone') {
      return {
        resolvePacificDayWindowUtc: () => ({ startUtc: null, endUtc: null }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/orderService');
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/orderService');
  }
};

test('createOrder rejects and avoids local persistence when WooCommerce order creation fails', async () => {
  const inserts = [];
  const updates = [];
  const referralCalls = [];
  const shipStationCalls = [];
  const shipEngineCalls = [];
  const sqlCalls = [];
  const emailCalls = [];

  const orderRepository = {
    findById: () => null,
    findByUserIdAndIdempotencyKey: () => null,
    findByUserId: () => [],
    getAll: () => [],
    insert: (order) => {
      inserts.push(order);
      return order;
    },
    update: (order) => {
      updates.push(order);
      return order;
    },
  };

  const userRepository = {
    findById: () => ({
      id: 'rep-1',
      role: 'sales_rep',
      name: 'Rep One',
      email: 'rep@example.com',
      allowedRetail: true,
      isTaxExempt: false,
    }),
  };

  const wooError = new Error('Woo down');
  wooError.status = 503;

  await withFreshService(
    {
      orderRepository,
      userRepository,
      referralService: {
        applyReferralCredit: (payload) => {
          referralCalls.push(payload);
          return null;
        },
      },
      wooCommerceClient: {
        forwardOrder: async () => {
          throw wooError;
        },
      },
      shipStationClient: {
        forwardOrder: async () => {
          shipStationCalls.push(true);
          return { status: 'success' };
        },
        isConfigured: () => true,
      },
      shipEngineClient: {
        forwardShipment: async () => {
          shipEngineCalls.push(true);
          return { status: 'success' };
        },
      },
      orderSqlRepository: {
        persistOrder: async () => {
          sqlCalls.push(true);
          return { status: 'success' };
        },
      },
      emailService: {
        sendOrderPaymentInstructionsEmail: async () => {
          emailCalls.push(true);
        },
      },
    },
    async (service) => {
      await assert.rejects(
        () => service.createOrder(buildCheckoutPayload()),
        (error) => {
          assert.equal(error.status, 503);
          assert.equal(error.code, 'WOO_ORDER_CREATE_FAILED');
          assert.match(error.message, /WooCommerce order creation failed/i);
          return true;
        },
      );
    },
  );

  assert.equal(inserts.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(referralCalls.length, 0);
  assert.equal(shipStationCalls.length, 0);
  assert.equal(shipEngineCalls.length, 0);
  assert.equal(sqlCalls.length, 0);
  assert.equal(emailCalls.length, 0);
});

test('createOrder persists locally only after WooCommerce succeeds', async () => {
  const sequence = [];
  const insertedOrders = [];

  const orderRepository = {
    findById: () => null,
    findByUserIdAndIdempotencyKey: () => null,
    findByUserId: () => [],
    getAll: () => [],
    insert: (order) => {
      sequence.push('insert');
      insertedOrders.push({ ...order });
      return order;
    },
    update: (order) => {
      sequence.push('update');
      return order;
    },
  };

  const userRepository = {
    findById: () => ({
      id: 'rep-1',
      role: 'sales_rep',
      name: 'Rep One',
      email: 'rep@example.com',
      allowedRetail: true,
      isTaxExempt: false,
    }),
  };

  await withFreshService(
    {
      orderRepository,
      userRepository,
      referralService: {
        applyReferralCredit: () => {
          sequence.push('referral');
          return null;
        },
      },
      wooCommerceClient: {
        forwardOrder: async ({ order }) => {
          sequence.push('woo');
          assert.equal(order.pricingMode, 'retail');
          return {
            status: 'success',
            response: {
              id: 4321,
              number: '4321',
              status: 'pending',
            },
          };
        },
      },
      shipStationClient: {
        forwardOrder: async () => {
          sequence.push('shipstation');
          return { status: 'success', response: { orderId: 'ss-1' } };
        },
        isConfigured: () => true,
      },
      orderSqlRepository: {
        persistOrder: async () => {
          sequence.push('sql');
          return { status: 'success' };
        },
      },
      emailService: {
        sendOrderPaymentInstructionsEmail: async () => {
          sequence.push('email');
        },
      },
    },
    async (service) => {
      const result = await service.createOrder(buildCheckoutPayload());
      assert.equal(result.success, true);
      assert.equal(result.order.pricingMode, 'retail');
      assert.equal(result.order.wooOrderId, 4321);
      assert.equal(result.order.wooOrderNumber, '4321');
    },
  );

  assert.equal(insertedOrders.length, 1);
  assert.ok(sequence.indexOf('woo') !== -1);
  assert.ok(sequence.indexOf('referral') > sequence.indexOf('woo'));
  assert.ok(sequence.indexOf('insert') > sequence.indexOf('referral'));
});

test('createOrder preserves facility pickup recipient name for sales actors', async () => {
  const insertedOrders = [];

  const orderRepository = {
    findById: () => null,
    findByUserIdAndIdempotencyKey: () => null,
    findByUserId: () => [],
    getAll: () => [],
    insert: (order) => {
      insertedOrders.push({ ...order });
      return order;
    },
    update: (order) => order,
  };

  const userRepository = {
    findById: () => ({
      id: 'rep-1',
      role: 'sales_lead',
      name: 'Sales Lead User',
      email: 'lead@example.com',
      isTaxExempt: false,
    }),
  };

  await withFreshService(
    {
      orderRepository,
      userRepository,
      wooCommerceClient: {
        forwardOrder: async ({ order }) => {
          assert.equal(order.shippingAddress.name, 'Recipient Patient');
          assert.equal(order.billingAddress.name, 'Recipient Patient');
          assert.equal(order.facilityPickup, true);
          assert.equal(order.handDelivery, false);
          assert.equal(order.fulfillmentMethod, 'facility_pickup');
          return {
            status: 'success',
            response: {
              id: 9876,
              number: '9876',
              status: 'pending',
            },
          };
        },
      },
    },
    async (service) => {
      const result = await service.createOrder({
        ...buildCheckoutPayload(),
        total: 100,
        shippingAddress: {
          name: 'Recipient Patient',
          addressLine1: '640 S Grand Ave',
          addressLine2: 'Unit #107',
          city: 'Santa Ana',
          state: 'CA',
          postalCode: '92705',
          country: 'US',
        },
        shippingEstimate: {
          carrierId: 'facility_pickup',
          serviceCode: 'facility_pickup',
          serviceType: 'Facility pickup',
          rate: 0,
          currency: 'USD',
        },
        shippingTotal: 0,
        handDelivery: false,
        facilityPickup: true,
      });
      assert.equal(result.success, true);
    },
  );

  assert.equal(insertedOrders.length, 1);
  assert.equal(insertedOrders[0].shippingAddress.name, 'Recipient Patient');
  assert.equal(insertedOrders[0].billingAddress.name, 'Recipient Patient');
  assert.equal(insertedOrders[0].facilityPickup, true);
});
