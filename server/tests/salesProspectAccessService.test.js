const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshService = async ({ salesProspectRepository, userRepository, logger }, run) => {
  const originalLoad = Module._load;
  clearModule('../services/salesProspectAccessService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../repositories/salesProspectRepository') {
      return salesProspectRepository;
    }
    if (request === '../repositories/userRepository') {
      return userRepository;
    }
    if (request === '../config/logger') {
      return {
        logger: logger || {
          warn() {},
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/salesProspectAccessService');
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/salesProspectAccessService');
  }
};

test('resolveScopedProspectAccess resolves canonical doctor prospects from doctor id aliases', async () => {
  await withFreshService(
    {
      salesProspectRepository: {
        findById: async () => null,
        findBySalesRepAndContactFormId: async () => null,
        findByDoctorId: async (doctorId) => (
          doctorId === 'doctor-42'
            ? { id: 'doctor:doctor-42', salesRepId: 'rep-1', doctorId: 'doctor-42' }
            : null
        ),
        findBySalesRepAndDoctorId: async () => null,
        findBySalesRepAndReferralId: async () => null,
      },
      userRepository: {
        findById: () => null,
      },
    },
    async (service) => {
      const result = await service.resolveScopedProspectAccess({
        identifier: 'doctor-42',
        user: { id: 'rep-1', role: 'sales_rep' },
        query: {},
        context: 'test',
      });

      assert.equal(result.prospect?.id, 'doctor:doctor-42');
      assert.equal(result.prospect?.salesRepId, 'rep-1');
    },
  );
});

test('resolveScopedProspectAccess rejects prospects owned by another rep', async () => {
  await withFreshService(
    {
      salesProspectRepository: {
        findById: async () => ({ id: 'prospect-7', salesRepId: 'rep-2' }),
        findBySalesRepAndContactFormId: async () => null,
        findByDoctorId: async () => null,
        findBySalesRepAndDoctorId: async () => null,
        findBySalesRepAndReferralId: async () => null,
      },
      userRepository: {
        findById: () => null,
      },
    },
    async (service) => {
      await assert.rejects(
        () => service.resolveScopedProspectAccess({
          identifier: 'prospect-7',
          user: { id: 'rep-1', role: 'sales_rep' },
          query: {},
          context: 'test',
        }),
        (error) => error?.status === 404,
      );
    },
  );
});
