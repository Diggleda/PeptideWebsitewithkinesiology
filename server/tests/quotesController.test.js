const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshController = async ({ axios, env, mysqlClient }, run) => {
  const originalLoad = Module._load;
  clearModule('../controllers/quotesController');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'axios') {
      return axios;
    }
    if (request === '../config/env') {
      return { env };
    }
    if (request === '../database/mysqlClient') {
      return mysqlClient;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const controller = require('../controllers/quotesController');
    await run(controller);
  } finally {
    Module._load = originalLoad;
    clearModule('../controllers/quotesController');
  }
};

test('getDaily reads quotes from MySQL and stores the full daily cache payload', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppro-quotes-'));

  try {
    let statusCode = 0;
    let jsonPayload = null;

    await withFreshController(
      {
        axios: {
          get: async () => {
            throw new Error('upstream quotes feed should not be called');
          },
        },
        env: {
          dataDir,
          quotes: {
            sourceUrl: 'https://unused.example.test/quotes',
            secret: '',
          },
        },
        mysqlClient: {
          isEnabled: () => true,
          fetchAll: async () => [
            {
              id: 165,
              text: 'Database quote',
              author: 'PepPro',
            },
          ],
        },
      },
      async (controller) => {
        await controller.getDaily(
          {},
          {
            status: (code) => {
              statusCode = code;
              return {
                json: (payload) => {
                  jsonPayload = payload;
                },
              };
            },
          },
          (error) => {
            throw error;
          },
        );
      },
    );

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'daily-quote.json'), 'utf8'));

    assert.equal(statusCode, 200);
    assert.deepEqual(jsonPayload, {
      text: 'Database quote',
      author: 'PepPro',
    });
    assert.equal(stored.id, 165);
    assert.equal(stored.text, 'Database quote');
    assert.equal(stored.author, 'PepPro');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
