const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTransport, resolvePrettyTarget } = require('../config/logger');

test('buildTransport returns undefined when pretty logging is disabled', () => {
  assert.equal(buildTransport({ pretty: false }), undefined);
});

test('buildTransport falls back cleanly when pino-pretty is unavailable', () => {
  const warnings = [];
  const transport = buildTransport({
    pretty: true,
    resolver: () => {
      throw new Error('MODULE_NOT_FOUND');
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(transport, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pino-pretty is not installed/i);
});

test('resolvePrettyTarget returns a resolved module path when available', () => {
  const resolved = resolvePrettyTarget((name) => {
    assert.equal(name, 'pino-pretty');
    return '/tmp/pino-pretty/index.js';
  });

  assert.equal(resolved, '/tmp/pino-pretty/index.js');
});
