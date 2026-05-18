const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JsonStore } = require('../storage/jsonStore');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-test-'));

test('read preserves corrupt JSON instead of replacing it with the default value', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'users.json');
  fs.writeFileSync(filePath, '[{bad', 'utf8');

  const store = new JsonStore(dir, 'users.json', []);

  assert.throws(() => store.read(), SyntaxError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '[{bad');
});

test('read serves cached data when disk JSON becomes corrupt', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'users.json');
  const cachedUsers = [{ id: 'user-1', email: 'cached@example.com' }];
  const store = new JsonStore(dir, 'users.json', []);

  store.write(cachedUsers);
  fs.writeFileSync(filePath, '[{bad', 'utf8');
  store.cacheMtimeMs = 0;
  store.cacheValidationIntervalMs = 0;
  store.lastCacheValidationAt = 0;

  assert.deepEqual(store.read(), cachedUsers);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '[{bad');
});
