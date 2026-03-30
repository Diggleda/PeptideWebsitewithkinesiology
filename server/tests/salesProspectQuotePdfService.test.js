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

test('generateProspectQuotePdf embeds a recovered product image as a data URL instead of a broken localhost media URL', async () => {
  const localhostMediaUrl = 'http://localhost:3001/api/woo/media?src=https%3A%2F%2Fshop.peppro.net%2Fwp-content%2Fuploads%2F2025%2F12%2FPhysicians_Nasal-label_oxy-1.jpg';
  const axiosCalls = [];
  let renderedHtml = '';
  let evaluatedImagePass = 0;
  let wooLookupCount = 0;

  await withFreshPdfService(
    {
      axios: {
        get: async (url, config) => {
          axiosCalls.push({ url, config });
          return {
            headers: { 'content-type': 'image/jpeg' },
            data: Buffer.from('mock-jpeg-binary'),
          };
        },
      },
      wooCommerceClient: {
        findProductBySku: async () => {
          wooLookupCount += 1;
          return null;
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
    async ({ generateProspectQuotePdf, normalizeWebsiteQuoteImageUrl }) => {
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
          salesRep: {
            name: 'Rep Example',
            email: 'rep@example.com',
            phone: '317-555-0101',
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

      const expectedImageUrl = normalizeWebsiteQuoteImageUrl(localhostMediaUrl);
      assert.equal(result.filename, 'PepPro_Quote_Client_Example_5.pdf');
      assert.equal(axiosCalls.length, 1);
      assert.equal(
        axiosCalls[0].url,
        'https://shop.peppro.net/wp-content/uploads/2025/12/Physicians_Nasal-label_oxy-1.jpg',
      );
      assert.equal(evaluatedImagePass, 1);
      assert.equal(wooLookupCount, 0);
      assert.ok(String(expectedImageUrl).includes('/api/woo/media?src='));
      assert.match(renderedHtml, /data:image\/jpeg;base64,/);
      assert.doesNotMatch(renderedHtml, /\/api\/woo\/media\?src=/);
      assert.match(renderedHtml, /<img class="brand-logo" src="data:image\/png;base64,/);
      assert.doesNotMatch(renderedHtml, /<div class="brand">PepPro<\/div>/);
      assert.match(renderedHtml, /class="summary-row"/);
      assert.doesNotMatch(renderedHtml, /class="summary"/);
      assert.match(renderedHtml, /<div class="summary-row">\s*<span>Subtotal:<\/span>\s*<span>\$93\.91<\/span>\s*<\/div>/);
      assert.match(renderedHtml, /<div class="meta-label">Physician<\/div>/);
      assert.doesNotMatch(renderedHtml, /<div class="meta-label">Prospect<\/div>/);
      assert.match(renderedHtml, /317-555-0101/);
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
  const axiosCalls = [];
  let renderedHtml = '';

  await withFreshPdfService(
    {
      axios: {
        get: async (url, config) => {
          axiosCalls.push({ url, config });
          return {
            headers: { 'content-type': 'image/jpeg' },
            data: Buffer.from('mock-nested-jpeg'),
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
    async ({ generateProspectQuotePdf, normalizeWebsiteQuoteImageUrl }) => {
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

      const expectedImageUrl = normalizeWebsiteQuoteImageUrl(remoteImageUrl);
      assert.equal(axiosCalls.length, 1);
      assert.equal(axiosCalls[0].url, remoteImageUrl);
      assert.ok(String(expectedImageUrl).includes('/api/woo/media?src='));
      assert.match(renderedHtml, /data:image\/jpeg;base64,/);
      assert.doesNotMatch(renderedHtml, new RegExp(String(expectedImageUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    },
  );
});

test('generateProspectQuotePdf skips live Woo SKU lookups when no cached quote image is available', async () => {
  let renderedHtml = '';
  let wooLookupCount = 0;
  const axiosCalls = [];

  await withFreshPdfService(
    {
      axios: {
        get: async (url) => {
          axiosCalls.push(url);
          throw new Error(`No remote fetch expected: ${url}`);
        },
      },
      wooCommerceClient: {
        findProductBySku: async () => {
          wooLookupCount += 1;
          return {
            image: 'https://shop.peppro.net/wp-content/uploads/2025/12/should-not-be-used.jpg',
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
        title: 'Quote without Item Image',
        quotePayloadJson: {
          title: 'Quote without Item Image',
          currency: 'USD',
          subtotal: 15,
          prospect: {
            contactName: 'Fallback Example',
          },
          items: [
            {
              name: 'Image-less Item',
              sku: 'NO-CACHED-IMAGE',
              quantity: 1,
              unitPrice: 15,
              lineTotal: 15,
            },
          ],
        },
      });

      assert.deepEqual(axiosCalls, []);
      assert.equal(wooLookupCount, 0);
      assert.match(renderedHtml, /Image-less Item/);
    },
  );
});

test('normalizeWebsiteQuoteImageUrl unwraps nested Woo media proxy URLs', async () => {
  const nestedProxyUrl = 'https://api.peppro.net/api/woo/media?src=https%3A%2F%2Fapi.peppro.net%2Fapi%2Fwoo%2Fmedia%3Fsrc%3Dhttps%253A%252F%252Fshop.peppro.net%252Fwp-content%252Fuploads%252F2025%252F12%252FPhysicians_Nasal-label_BPC-TB-1.jpg&_imgRetry=1774882889344_1';

  await withFreshPdfService(
    {
      axios: {
        get: async (url) => {
          throw new Error(`No remote fetch expected: ${url}`);
        },
      },
      playwright: {
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              setContent: async () => {},
              waitForLoadState: async () => {},
              evaluate: async () => {},
              pdf: async () => Buffer.from('%PDF-1.4 mock'),
            }),
            close: async () => {},
          }),
        },
      },
    },
    async ({ normalizeWebsiteQuoteImageUrl }) => {
      assert.equal(
        normalizeWebsiteQuoteImageUrl(nestedProxyUrl),
        'http://127.0.0.1:3001/api/woo/media?src=https%3A%2F%2Fshop.peppro.net%2Fwp-content%2Fuploads%2F2025%2F12%2FPhysicians_Nasal-label_BPC-TB-1.jpg',
      );
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
