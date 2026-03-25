const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const restoreEnv = (snapshot) => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, snapshot);
};

const clearModule = (modulePath) => {
  delete require.cache[require.resolve(modulePath)];
};

const withFreshMysqlClient = async ({ envOverrides = {} }, run) => {
  const envSnapshot = { ...process.env };
  const originalLoad = Module._load;
  const createPoolCalls = [];

  Object.assign(process.env, {
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'x'.repeat(64),
    DATA_ENCRYPTION_KEY: 'enc-key',
    FRONTEND_BASE_URL: 'https://prod.example',
    MYSQL_ENABLED: 'true',
    MYSQL_HOST: 'db.example',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'peppr',
    MYSQL_PASSWORD: 'secret',
    MYSQL_DATABASE: 'peppr',
    ...envOverrides,
  });

  clearModule('../config/env');
  clearModule('../config/logger');
  clearModule('../database/mysqlClient');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'mysql2/promise') {
      return {
        createPool(config) {
          createPoolCalls.push(config);
          return {
            query: async () => [[{ Variable_name: 'Ssl_cipher', Value: 'TLS_AES_256_GCM_SHA384' }], []],
            execute: async () => [[], []],
            end: async () => {},
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const mysqlClient = require('../database/mysqlClient');
    await run({ mysqlClient, createPoolCalls });
  } finally {
    Module._load = originalLoad;
    restoreEnv(envSnapshot);
    clearModule('../config/env');
    clearModule('../config/logger');
    clearModule('../database/mysqlClient');
  }
};

test('configure passes an SSL object to the MySQL pool when MYSQL_SSL=true', async () => {
  await withFreshMysqlClient({ envOverrides: { MYSQL_SSL: 'true' } }, async ({ mysqlClient, createPoolCalls }) => {
    await mysqlClient.configure();

    assert.equal(createPoolCalls.length, 1);
    assert.deepEqual(createPoolCalls[0].ssl, {});
    assert.equal(createPoolCalls[0].host, 'db.example');
    assert.equal(createPoolCalls[0].database, 'peppr');
  });
});

test('configure rejects MySQL sessions that did not negotiate TLS', async () => {
  const envSnapshot = { ...process.env };
  const originalLoad = Module._load;

  Object.assign(process.env, {
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'x'.repeat(64),
    DATA_ENCRYPTION_KEY: 'enc-key',
    FRONTEND_BASE_URL: 'https://prod.example',
    MYSQL_ENABLED: 'true',
    MYSQL_SSL: 'true',
    MYSQL_HOST: 'db.example',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'peppr',
    MYSQL_PASSWORD: 'secret',
    MYSQL_DATABASE: 'peppr',
  });

  clearModule('../config/env');
  clearModule('../config/logger');
  clearModule('../database/mysqlClient');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'mysql2/promise') {
      return {
        createPool() {
          return {
            query: async () => [[{ Variable_name: 'Ssl_cipher', Value: '' }], []],
            execute: async () => [[], []],
            end: async () => {},
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const mysqlClient = require('../database/mysqlClient');
    await assert.rejects(
      () => mysqlClient.configure(),
      (error) => error && error.code === 'MYSQL_TLS_REQUIRED',
    );
  } finally {
    Module._load = originalLoad;
    restoreEnv(envSnapshot);
    clearModule('../config/env');
    clearModule('../config/logger');
    clearModule('../database/mysqlClient');
  }
});
