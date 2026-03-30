const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshPdfService = async (deps, run) => {
  const originalLoad = Module._load;
  clearModule('../services/salesProspectQuotePdfService');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'axios') {
      return deps.axios;
    }
    if (request === '../integration/wooCommerceClient') {
      return deps.wooCommerceClient || { findProductBySku: async () => null };
    }
    if (request === 'playwright') {
      return deps.playwright;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require('../services/salesProspectQuotePdfService');
    await run(service);
  } finally {
    Module._load = originalLoad;
    clearModule('../services/salesProspectQuotePdfService');
  }
};

test('generateProspectQuotePdf embeds a recovered product image instead of a broken localhost media URL', async () => {
  const localhostMediaUrl = 'http://localhost:3001/api/woo/media?src=https%3A%2F%2Fshop.peppro.net%2Fwp-content%2Fuploads%2F2025%2F12%2FPhysicians_Nasal-label_oxy-1.jpg';
  const remoteImageUrl = 'https://shop.peppro.net/wp-content/uploads/2025/12/Physicians_Nasal-label_oxy-1.jpg';
  const embeddedImageData = Buffer.from('quote-line-item-image');
  const embeddedImageDataUrl = `data:image/png;base64,${embeddedImageData.toString('base64')}`;
  const axiosCalls = [];
  let renderedHtml = '';
  let evaluatedImagePass = 0;

  await withFreshPdfService(
    {
      axios: {
        get: async (url) => {
          axiosCalls.push(url);
          if (url === localhostMediaUrl) {
            throw new Error('connect ECONNREFUSED 127.0.0.1:3001');
          }
          if (url === remoteImageUrl) {
            return {
              data: embeddedImageData,
              headers: {
                'content-type': 'image/png',
              },
            };
          }
          throw new Error(`Unexpected image request: ${url}`);
        },
      },
      playwright: {
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              setContent: async (html) => {
                renderedHtml = html;
              },
              waitForLoadState: async () => {},
              evaluate: async () => {
                evaluatedImagePass += 1;
              },
              pdf: async () => Buffer.from('%PDF-1.4 mock'),
            }),
            close: async () => {},
          }),
        },
      },
    },
    async ({ generateProspectQuotePdf }) => {
      const result = await generateProspectQuotePdf({
        revisionNumber: 5,
        title: 'Quote for Client Example',
        quotePayloadJson: {
          title: 'Quote for Client Example',
          notes: 'Move notes before the item table.',
          pricingMode: 'wholesale',
          currency: 'USD',
          subtotal: 93.91,
          prospect: {
            contactName: 'Client Example',
          },
          items: [
            {
              name: 'Oxytocin N — 10mg',
              sku: 'TEST-SKU',
              imageUrl: localhostMediaUrl,
              quantity: 1,
              unitPrice: 93.91,
              lineTotal: 93.91,
            },
          ],
        },
      });

      assert.equal(result.filename, 'PepPro_Quote_Client_Example_5.pdf');
      assert.deepEqual(axiosCalls, [localhostMediaUrl, remoteImageUrl]);
      assert.equal(evaluatedImagePass, 1);
      assert.match(renderedHtml, new RegExp(embeddedImageDataUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(renderedHtml, /http:\/\/localhost:3001\/api\/woo\/media/);
      assert.match(renderedHtml, /class="summary-row"/);
      assert.doesNotMatch(renderedHtml, /class="summary"/);
      assert.match(renderedHtml, /<div class="summary-row">\s*<span>Subtotal<\/span>\s*<span>\$93\.91<\/span>\s*<\/div>/);
      assert.doesNotMatch(renderedHtml, /<strong>Created:<\/strong>/);
      assert.doesNotMatch(renderedHtml, /<strong>Exported:<\/strong>/);
      assert.doesNotMatch(renderedHtml, /<strong>Pricing:<\/strong>/);
      assert.match(renderedHtml, /object-fit: cover/);
      assert.match(renderedHtml, /width: 44px;/);
      const notesIndex = renderedHtml.indexOf('<div class="notes">');
      const tableIndex = renderedHtml.indexOf('<table>');
      assert.ok(notesIndex >= 0);
      assert.ok(tableIndex >= 0);
      assert.ok(notesIndex < tableIndex);
    },
  );
});

test('generateProspectQuotePdf resolves nested thumbnail objects for quote item images', async () => {
  const remoteImageUrl = 'https://shop.peppro.net/wp-content/uploads/2025/12/Physicians_Vial-label_MOTS.jpg';
  const embeddedImageData = Buffer.from('nested-item-image');
  const embeddedImageDataUrl = `data:image/jpeg;base64,${embeddedImageData.toString('base64')}`;
  let renderedHtml = '';

  await withFreshPdfService(
    {
      axios: {
        get: async (url, config) => {
          assert.equal(url, remoteImageUrl);
          assert.equal(config?.headers?.Accept, 'image/png,image/jpeg,image/webp,image/gif,image/*,*/*;q=0.8');
          return {
            data: embeddedImageData,
            headers: {
              'content-type': 'image/jpeg',
            },
          };
        },
      },
      playwright: {
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              setContent: async (html) => {
                renderedHtml = html;
              },
              waitForLoadState: async () => {},
              evaluate: async () => {},
              pdf: async () => Buffer.from('%PDF-1.4 mock'),
            }),
            close: async () => {},
          }),
        },
      },
    },
    async ({ generateProspectQuotePdf }) => {
      await generateProspectQuotePdf({
        revisionNumber: 1,
        title: 'Quote with Nested Image',
        quotePayloadJson: {
          title: 'Quote with Nested Image',
          currency: 'USD',
          subtotal: 94.36,
          prospect: {
            contactName: 'Nested Example',
          },
          items: [
            {
              name: 'MOTS-C V — 20mg',
              sku: 'TEST-SKU-NESTED',
              image: {
                thumbnail: remoteImageUrl,
              },
              quantity: 1,
              unitPrice: 94.36,
              lineTotal: 94.36,
            },
          ],
        },
      });

      assert.match(renderedHtml, new RegExp(embeddedImageDataUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    },
  );
});

test('generateProspectQuotePdf launches Chromium with server-safe flags and optional executable override', async () => {
  let launchOptions;
  const originalExistsSync = fs.existsSync;
  const originalExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '/usr/bin/chromium';
  fs.existsSync = (value) => value === '/usr/bin/chromium' || originalExistsSync(value);

  try {
    await withFreshPdfService(
      {
        axios: {
          get: async () => {
            throw new Error('No image fetch expected');
          },
        },
        playwright: {
          chromium: {
            launch: async (options) => {
              launchOptions = options;
              return {
                newPage: async () => ({
                  setContent: async () => {},
                  waitForLoadState: async () => {},
                  evaluate: async () => {},
                  pdf: async () => Buffer.from('%PDF-1.4 mock'),
                }),
                close: async () => {},
              };
            },
          },
        },
      },
      async ({ generateProspectQuotePdf }) => {
        await generateProspectQuotePdf({
          revisionNumber: 1,
          title: 'Quote for Launch Options',
          quotePayloadJson: {
            prospect: {
              contactName: 'Launch Example',
            },
            items: [],
          },
        });
      },
    );
  } finally {
    fs.existsSync = originalExistsSync;
    if (originalExecutablePath === undefined) {
      delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    } else {
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = originalExecutablePath;
    }
  }

  assert.deepEqual(launchOptions, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    executablePath: '/usr/bin/chromium',
  });
});

test('generateProspectQuotePdf falls back to a common system Chromium path when no env override is set', async () => {
  let launchOptions;
  const originalExistsSync = fs.existsSync;
  const originalExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

  fs.existsSync = (value) => value === '/usr/bin/google-chrome-stable' || originalExistsSync(value);

  try {
    await withFreshPdfService(
      {
        axios: {
          get: async () => {
            throw new Error('No image fetch expected');
          },
        },
        playwright: {
          chromium: {
            launch: async (options) => {
              launchOptions = options;
              return {
                newPage: async () => ({
                  setContent: async () => {},
                  waitForLoadState: async () => {},
                  evaluate: async () => {},
                  pdf: async () => Buffer.from('%PDF-1.4 mock'),
                }),
                close: async () => {},
              };
            },
          },
        },
      },
      async ({ generateProspectQuotePdf }) => {
        await generateProspectQuotePdf({
          revisionNumber: 1,
          title: 'Quote for System Chromium',
          quotePayloadJson: {
            prospect: {
              contactName: 'System Chromium Example',
            },
            items: [],
          },
        });
      },
    );
  } finally {
    fs.existsSync = originalExistsSync;
    if (originalExecutablePath === undefined) {
      delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    } else {
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = originalExecutablePath;
    }
  }

  assert.equal(launchOptions.executablePath, '/usr/bin/google-chrome-stable');
});
