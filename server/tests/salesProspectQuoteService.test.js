const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshService = async (deps, run) => {
  const originalLoad = Module._load;
  clearModule('../services/salesProspectQuoteService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../repositories/salesProspectQuoteRepository') {
      return deps.quoteRepository;
    }
    if (request === '../repositories/salesProspectRepository') {
      return deps.salesProspectRepository;
    }
    if (request === '../repositories/salesRepRepository') {
      return deps.salesRepRepository || { findById: () => null, findByEmail: () => null };
    }
    if (request === '../repositories/userRepository') {
      return deps.userRepository || { findById: () => null };
    }
    if (request === './salesProspectAccessService') {
      return deps.accessService;
    }
    if (request === './salesProspectQuotePdfService') {
      return {
        normalizeWebsiteQuoteImageUrl: (value) => value ?? null,
        generateProspectQuotePdf: async () => ({ pdf: Buffer.from('%PDF-1.4'), filename: 'quote.pdf' }),
        ...(deps.pdfService || {}),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/salesProspectQuoteService');
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/salesProspectQuoteService');
  }
};

test('importCartToProspectQuote replaces the existing draft revision in place', async () => {
  const upserts = [];
  await withFreshService(
    {
      quoteRepository: {
        listByProspectId: async () => [
          {
            id: 'quote-draft',
            prospectId: 'prospect-1',
            salesRepId: 'rep-1',
            revisionNumber: 2,
            status: 'draft',
            title: 'Draft',
            currency: 'USD',
            subtotal: 20,
            quotePayloadJson: { notes: null },
          },
        ],
        findById: async () => null,
        upsert: async (quote) => {
          upserts.push(quote);
          return {
            ...quote,
            id: quote.id || 'quote-draft',
            quotePayloadJson: quote.quotePayloadJson,
          };
        },
      },
      salesProspectRepository: {
        upsert: async (prospect) => prospect,
      },
      accessService: {
        resolveScopedProspectAccess: async () => ({
          identifier: 'doctor-1',
          prospect: { id: 'prospect-1', salesRepId: 'rep-1', contactName: 'Dr. One' },
          salesRepId: 'rep-1',
        }),
        buildProspectBaseRecord: () => null,
        normalizeOptionalText: (value) => (value == null ? null : String(value).trim() || null),
      },
    },
    async (service) => {
      const result = await service.importCartToProspectQuote({
        identifier: 'doctor-1',
        user: { id: 'rep-1', role: 'sales_rep', name: 'Rep One', email: 'rep@example.com' },
        payload: {
          title: 'New Draft',
          pricingMode: 'wholesale',
          currency: 'USD',
          subtotal: 55,
          items: [
            { productId: 'prod-1', name: 'Item', quantity: 2, unitPrice: 27.5, lineTotal: 55 },
          ],
        },
      });

      assert.equal(upserts.length, 1);
      assert.equal(upserts[0].id, 'quote-draft');
      assert.equal(upserts[0].revisionNumber, 2);
      assert.equal(result.quote?.title, 'New Draft');
    },
  );
});

test('importCartToProspectQuote creates the next revision after an exported quote', async () => {
  const upserts = [];
  await withFreshService(
    {
      quoteRepository: {
        listByProspectId: async () => [
          {
            id: 'quote-exported',
            prospectId: 'prospect-1',
            salesRepId: 'rep-1',
            revisionNumber: 3,
            status: 'exported',
            title: 'R3',
            currency: 'USD',
            subtotal: 80,
            quotePayloadJson: { notes: null },
          },
        ],
        findById: async () => null,
        upsert: async (quote) => {
          upserts.push(quote);
          return {
            ...quote,
            id: 'quote-r4',
            quotePayloadJson: quote.quotePayloadJson,
          };
        },
      },
      salesProspectRepository: {
        upsert: async (prospect) => prospect,
      },
      accessService: {
        resolveScopedProspectAccess: async () => ({
          identifier: 'doctor-1',
          prospect: { id: 'prospect-1', salesRepId: 'rep-1', contactName: 'Dr. One' },
          salesRepId: 'rep-1',
        }),
        buildProspectBaseRecord: () => null,
        normalizeOptionalText: (value) => (value == null ? null : String(value).trim() || null),
      },
    },
    async (service) => {
      await service.importCartToProspectQuote({
        identifier: 'doctor-1',
        user: { id: 'rep-1', role: 'sales_rep', name: 'Rep One', email: 'rep@example.com' },
        payload: {
          title: 'R4',
          pricingMode: 'wholesale',
          currency: 'USD',
          subtotal: 20,
          items: [
            { productId: 'prod-1', name: 'Item', quantity: 1, unitPrice: 20, lineTotal: 20 },
          ],
        },
      });

      assert.equal(upserts[0].revisionNumber, 4);
      assert.equal(upserts[0].status, 'draft');
    },
  );
});

test('exportProspectQuote freezes draft revisions before rendering pdf output', async () => {
  const upserts = [];
  await withFreshService(
    {
      quoteRepository: {
        listByProspectId: async () => [],
        findById: async () => ({
          id: 'quote-draft',
          prospectId: 'prospect-1',
          salesRepId: 'rep-1',
          revisionNumber: 1,
          status: 'draft',
          title: 'Quote',
          currency: 'USD',
          subtotal: 50,
          quotePayloadJson: { prospect: { contactName: 'Dr. One' }, items: [] },
        }),
        upsert: async (quote) => {
          upserts.push(quote);
          return quote;
        },
      },
      salesProspectRepository: {},
      accessService: {
        resolveScopedProspectAccess: async () => ({
          identifier: 'doctor-1',
          prospect: { id: 'prospect-1', salesRepId: 'rep-1' },
          salesRepId: 'rep-1',
        }),
        buildProspectBaseRecord: () => null,
        normalizeOptionalText: (value) => (value == null ? null : String(value).trim() || null),
      },
      pdfService: {
        generateProspectQuotePdf: async () => ({
          pdf: Buffer.from('%PDF-1.4 mock'),
          filename: 'PepPro_Quote_Dr_One_1.pdf',
          diagnostics: {
            renderer: 'playwright_browser',
            totalMs: 18.7,
            html: {
              imageResolveMs: 7.2,
            },
          },
        }),
      },
    },
    async (service) => {
      const result = await service.exportProspectQuote({
        identifier: 'doctor-1',
        quoteId: 'quote-draft',
        user: { id: 'rep-1', role: 'sales_rep' },
      });

      assert.equal(upserts.length, 1);
      assert.equal(upserts[0].status, 'exported');
      assert.match(result.pdf.toString('utf8'), /^%PDF/);
      assert.equal(result.filename, 'PepPro_Quote_Dr_One_1.pdf');
      assert.equal(typeof result.diagnostics?.totalMs, 'number');
      assert.equal(typeof result.diagnostics?.accessMs, 'number');
      assert.equal(typeof result.diagnostics?.pdfMs, 'number');
      assert.equal(result.diagnostics?.pdf?.renderer, 'playwright_browser');
      assert.equal(result.diagnostics?.pdf?.html?.imageResolveMs, 7.2);
    },
  );
});

test('exportProspectQuote uses the scoped prospect contact name for filename when quote payload lacks it', async () => {
  await withFreshService(
    {
      quoteRepository: {
        listByProspectId: async () => [],
        findById: async () => ({
          id: 'quote-draft',
          prospectId: 'afde2748-5447-4aed-a622-b49bbc065770',
          salesRepId: 'rep-1',
          revisionNumber: 2,
          status: 'exported',
          title: 'Quote',
          currency: 'USD',
          subtotal: 50,
          quotePayloadJson: { prospect: { identifier: 'doctor-1' }, items: [] },
        }),
        upsert: async (quote) => quote,
      },
      salesProspectRepository: {},
      accessService: {
        resolveScopedProspectAccess: async () => ({
          identifier: 'doctor-1',
          prospect: {
            id: 'afde2748-5447-4aed-a622-b49bbc065770',
            salesRepId: 'rep-1',
            contactName: 'Example Lead',
            contactEmail: 'example@lead.com',
          },
          salesRepId: 'rep-1',
        }),
        buildProspectBaseRecord: () => null,
        normalizeOptionalText: (value) => (value == null ? null : String(value).trim() || null),
      },
      pdfService: {
        generateProspectQuotePdf: async (quote) => ({
          pdf: Buffer.from('%PDF-1.4 mock'),
          filename: `PepPro_Quote_${quote?.quotePayloadJson?.prospect?.contactName}_${quote?.revisionNumber}.pdf`,
        }),
      },
    },
    async (service) => {
      const result = await service.exportProspectQuote({
        identifier: 'doctor-1',
        quoteId: 'quote-draft',
        user: { id: 'rep-1', role: 'sales_rep' },
      });

      assert.equal(result.filename, 'PepPro_Quote_Example Lead_2.pdf');
    },
  );
});

test('deleteProspectQuote removes a scoped quote revision', async () => {
  const deletedIds = [];

  await withFreshService(
    {
      quoteRepository: {
        listByProspectId: async () => [],
        findById: async () => ({
          id: 'quote-exported',
          prospectId: 'prospect-1',
          salesRepId: 'rep-1',
          revisionNumber: 2,
          status: 'exported',
          title: 'R2',
          currency: 'USD',
          subtotal: 80,
        }),
        deleteById: async (quoteId) => {
          deletedIds.push(quoteId);
          return true;
        },
      },
      salesProspectRepository: {},
      accessService: {
        resolveScopedProspectAccess: async () => ({
          identifier: 'doctor-1',
          prospect: { id: 'prospect-1', salesRepId: 'rep-1' },
          salesRepId: 'rep-1',
        }),
        buildProspectBaseRecord: () => null,
        normalizeOptionalText: (value) => (value == null ? null : String(value).trim() || null),
      },
    },
    async (service) => {
      const result = await service.deleteProspectQuote({
        identifier: 'doctor-1',
        quoteId: 'quote-exported',
        user: { id: 'rep-1', role: 'sales_rep' },
      });

      assert.deepEqual(deletedIds, ['quote-exported']);
      assert.deepEqual(result, {
        deleted: true,
        quoteId: 'quote-exported',
      });
    },
  );
});
