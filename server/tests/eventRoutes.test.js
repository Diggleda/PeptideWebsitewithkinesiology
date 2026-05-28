const test = require('node:test');
const assert = require('node:assert/strict');

const eventRoutes = require('../routes/eventRoutes');

const routeEntry = (path, method) => eventRoutes.stack.find((layer) => (
  layer.route?.path === path && layer.route?.methods?.[method]
));

test('event routes expose resource versions and app-data events endpoints', () => {
  assert.ok(routeEntry('/resource-versions', 'get'));
  assert.ok(routeEntry('/events', 'get'));
});
