const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshRepository = async ({ mysqlClient, encryptJson, decryptJson }, run) => {
  const originalLoad = Module._load;

  clearModule('../repositories/salesProspectRepository');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../database/mysqlClient') {
      return mysqlClient;
    }
    if (request === '../storage') {
      return {
        salesProspectStore: {
          read: () => [],
          readCached: () => [],
          write() {},
        },
      };
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
    const repository = require('../repositories/salesProspectRepository');
    await run(repository);
  } finally {
    Module._load = originalLoad;
    clearModule('../repositories/salesProspectRepository');
  }
};

test('upsert stores source payload ciphertext inline in source_payload_json', async () => {
  const calls = [];
  const mysqlClient = {
    isEnabled: () => true,
    execute: async (query, params) => {
      calls.push({ query, params });
      return 1;
    },
    fetchOne: async () => null,
    fetchAll: async () => [],
  };

  await withFreshRepository(
    {
      mysqlClient,
      encryptJson: (value, options = {}) => `cipher:${options?.aad?.field}:${options?.aad?.record_ref}:${value?.assignedRepEmail || 'none'}`,
      decryptJson: () => null,
    },
    async (repository) => {
      await repository.upsert({
        id: 'prospect-1',
        salesRepId: 'rep-1',
        status: 'pending',
        sourcePayloadJson: { assignedRepEmail: 'rep@example.com' },
        contactEmails: ['lead@example.com', 'alt@example.com'],
        contactPhones: ['(555) 111-2222', '(555) 333-4444'],
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /INSERT INTO sales_prospects/);
  assert.doesNotMatch(calls[0].query, /source_payload_encrypted/);
  assert.equal(
    calls[0].params.sourcePayloadJson,
    'cipher:source_payload_json:prospect-1:rep@example.com',
  );
  assert.equal(
    calls[0].params.contactEmailsJson,
    JSON.stringify(['lead@example.com', 'alt@example.com']),
  );
  assert.equal(
    calls[0].params.contactPhonesJson,
    JSON.stringify(['(555) 111-2222', '(555) 333-4444']),
  );
});

test('findById decrypts inline source payload from source_payload_json', async () => {
  const mysqlClient = {
    isEnabled: () => true,
    execute: async () => 1,
    fetchAll: async () => [],
    fetchOne: async () => ({
      id: 'prospect-2',
      sales_rep_id: 'rep-2',
      status: 'pending',
      source_payload_json: 'cipher-source-payload',
      contact_emails_json: JSON.stringify(['lead@example.com', 'alt@example.com']),
      contact_phones_json: JSON.stringify(['(555) 111-2222', '(555) 333-4444']),
      created_at: '2026-03-24T12:00:00Z',
      updated_at: '2026-03-24T12:00:00Z',
    }),
  };

  await withFreshRepository(
    {
      mysqlClient,
      encryptJson: () => null,
      decryptJson: (value) => {
        if (value === 'cipher-source-payload') {
          return { assignedRepEmail: 'rep@example.com' };
        }
        return null;
      },
    },
    async (repository) => {
      const record = await repository.findById('prospect-2');
      assert.equal(record.id, 'prospect-2');
      assert.deepEqual(record.sourcePayloadJson, { assignedRepEmail: 'rep@example.com' });
      assert.deepEqual(record.contactEmails, ['lead@example.com', 'alt@example.com']);
      assert.deepEqual(record.contactPhones, ['(555) 111-2222', '(555) 333-4444']);
      assert.equal(record.contactEmail, 'lead@example.com');
      assert.equal(record.contactPhone, '(555) 111-2222');
    },
  );
});
