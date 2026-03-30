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
          diagnostics: {
            totalMs: 37.6,
            accessMs: 0.8,
            findQuoteMs: 1.2,
            markExportedMs: 2.1,
            enrichMs: 0.4,
            pdfMs: 33.1,
            pdf: {
              renderer: 'playwright_browser',
              totalMs: 32.4,
              pageCreateMs: 4.2,
              renderQuoteHtmlMs: 5.3,
              setContentMs: 1.1,
              waitForImagesMs: 18.8,
              pdfMs: 6.3,
              html: {
                imageResolveMs: 17.4,
              },
            },
          },
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
      assert.equal(headers['X-PepPro-Quote-Export-Ms'], '37.6');
      assert.equal(headers['X-PepPro-Quote-Pdf-Ms'], '33.1');
      assert.equal(headers['X-PepPro-Quote-Render-Ms'], '32.4');
      assert.equal(headers['X-PepPro-Quote-Image-Ms'], '17.4');
      assert.equal(headers['X-PepPro-Quote-Renderer'], 'playwright_browser');
      assert.equal(headers['X-PepPro-Quote-Pdf-Bytes'], String(Buffer.from('%PDF-1.4 mock').length));
      assert.match(headers['Server-Timing'], /quote_total;dur=37\.6/);
      assert.match(headers['Server-Timing'], /pdf_images;dur=17\.4/);
      assert.match(body.toString('utf8'), /^%PDF/);
    },
  );
});

test('remove returns the delete payload from the quote service', async () => {
  await withFreshController(
    {
      service: {
        deleteProspectQuote: async () => ({
          deleted: true,
          quoteId: 'quote-1',
        }),
      },
    },
    async (controller) => {
      let jsonPayload = null;

      await controller.remove(
        {
          params: { identifier: 'doctor-1', quoteId: 'quote-1' },
          user: { id: 'rep-1', role: 'sales_rep' },
          query: {},
        },
        {
          json: (payload) => {
            jsonPayload = payload;
          },
        },
        (error) => {
          throw error;
        },
      );

      assert.deepEqual(jsonPayload, {
        deleted: true,
        quoteId: 'quote-1',
      });
    },
  );
});
