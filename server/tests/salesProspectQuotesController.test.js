const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshController = async ({ service }, run) => {
  const originalLoad = Module._load;
  clearModule('../controllers/salesProspectQuotesController');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../services/salesProspectQuoteService') {
      return service;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const controller = require('../controllers/salesProspectQuotesController');
    await run(controller);
  } finally {
    Module._load = originalLoad;
    clearModule('../controllers/salesProspectQuotesController');
  }
};

test('exportPdf sets pdf headers and sends the generated buffer', async () => {
  await withFreshController(
    {
      service: {
        exportProspectQuote: async () => ({
          quote: { id: 'quote-1' },
          filename: 'PepPro_Quote_Test_1.pdf',
          pdf: Buffer.from('%PDF-1.4 mock'),
        }),
      },
    },
    async (controller) => {
      const headers = {};
      let statusCode = 0;
      let body = null;
      const res = {
        setHeader: (name, value) => {
          headers[name] = value;
        },
        status: (code) => {
          statusCode = code;
          return {
            send: (payload) => {
              body = payload;
            },
          };
        },
      };

      await controller.exportPdf(
        {
          params: { identifier: 'doctor-1', quoteId: 'quote-1' },
          user: { id: 'rep-1', role: 'sales_rep' },
          query: {},
        },
        res,
        (error) => {
          throw error;
        },
      );

      assert.equal(statusCode, 200);
      assert.equal(headers['Content-Type'], 'application/pdf');
      assert.equal(headers['Content-Disposition'], 'attachment; filename="PepPro_Quote_Test_1.pdf"');
      assert.match(body.toString('utf8'), /^%PDF/);
    },
  );
});
