const test = require('node:test');
const assert = require('node:assert/strict');

const mysqlClient = require('../database/mysqlClient');
const resourceVersionService = require('../services/resourceVersionService');

const withMysqlDisabled = async (run) => {
  const previousIsEnabled = mysqlClient.isEnabled;
  mysqlClient.isEnabled = () => false;
  resourceVersionService.__test__.memoryVersions.clear();
  try {
    await run();
  } finally {
    resourceVersionService.__test__.memoryVersions.clear();
    mysqlClient.isEnabled = previousIsEnabled;
  }
};

test('parseResourcesParam normalizes valid resource names and drops invalid entries', () => {
  assert.deepEqual(
    resourceVersionService.parseResourcesParam(' Orders,patient-links,%,orders,Forum '),
    ['orders', 'patient-links', 'forum'],
  );
});

test('memory resource versions bump and filter by requested resources', async () => {
  await withMysqlDisabled(async () => {
    const first = await resourceVersionService.bump('orders');
    const second = await resourceVersionService.bump('orders');
    await resourceVersionService.bump('settings');

    assert.equal(first.version, 1);
    assert.equal(second.version, 2);

    const rows = await resourceVersionService.getVersions(['orders', 'users']);
    assert.deepEqual(Object.keys(rows), ['orders']);
    assert.equal(rows.orders.resource, 'orders');
    assert.equal(rows.orders.version, 2);
    assert.match(rows.orders.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
