const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshRepository = async ({ mysqlClient, encryptJson, decryptJson, store }, run) => {
  const originalLoad = Module._load;
  clearModule('../repositories/salesProspectQuoteRepository');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../database/mysqlClient') {
      return mysqlClient;
    }
    if (request === '../storage') {
      return {
        salesProspectQuoteStore: store || {
          read: () => [],
          readCached: () => [],
          write() {},
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
    const repository = require('../repositories/salesProspectQuoteRepository');
    await run(repository);
  } finally {
    Module._load = originalLoad;
    clearModule('../repositories/salesProspectQuoteRepository');
  }
};

test('upsert stores quote payload ciphertext inline in quote_payload_json', async () => {
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
      encryptJson: (value, options = {}) => `cipher:${options?.aad?.field}:${options?.aad?.record_ref}:${value?.title || 'none'}`,
      decryptJson: () => null,
    },
    async (repository) => {
      await repository.upsert({
        id: 'quote-1',
        prospectId: 'prospect-1',
        salesRepId: 'rep-1',
        revisionNumber: 1,
        status: 'draft',
        title: 'Revision 1',
        currency: 'USD',
        subtotal: 150,
        quotePayloadJson: { title: 'Revision 1' },
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /INSERT INTO sales_prospect_quotes/);
  assert.equal(
    calls[0].params.quotePayloadJson,
    'cipher:quote_payload_json:quote-1:Revision 1',
  );
});

test('listByProspectId decrypts inline quote payloads and sorts latest revision first', async () => {
  const mysqlClient = {
    isEnabled: () => true,
    execute: async () => 1,
    fetchOne: async () => null,
    fetchAll: async () => [
      {
        id: 'quote-1',
        prospect_id: 'prospect-1',
        sales_rep_id: 'rep-1',
        revision_number: 1,
        status: 'exported',
        title: 'R1',
        currency: 'USD',
        subtotal: 100,
        quote_payload_json: 'cipher-r1',
        created_at: '2026-03-28T10:00:00Z',
        updated_at: '2026-03-28T10:00:00Z',
      },
      {
        id: 'quote-2',
        prospect_id: 'prospect-1',
        sales_rep_id: 'rep-1',
        revision_number: 2,
        status: 'draft',
        title: 'R2',
        currency: 'USD',
        subtotal: 125,
        quote_payload_json: 'cipher-r2',
        created_at: '2026-03-28T11:00:00Z',
        updated_at: '2026-03-28T11:00:00Z',
      },
    ],
  };

  await withFreshRepository(
    {
      mysqlClient,
      encryptJson: () => null,
      decryptJson: (value) => {
        if (value === 'cipher-r1') {
          return { title: 'R1', items: [] };
        }
        if (value === 'cipher-r2') {
          return { title: 'R2', items: [] };
        }
        return null;
      },
    },
    async (repository) => {
      const records = await repository.listByProspectId('prospect-1');
      assert.equal(records.length, 2);
      assert.equal(records[0].id, 'quote-2');
      assert.equal(records[0].quotePayloadJson?.title, 'R2');
      assert.equal(records[1].id, 'quote-1');
    },
  );
});
