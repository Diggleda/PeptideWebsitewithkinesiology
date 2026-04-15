import test from 'node:test';
import assert from 'node:assert/strict';

import { formatOrderStatusLabel } from '../../src/lib/orderStatusLabels.mjs';

test('formats requested canonical order and tracking labels', () => {
  assert.equal(formatOrderStatusLabel('on-hold'), 'On-Hold');
  assert.equal(formatOrderStatusLabel('processing'), 'Processing');
  assert.equal(formatOrderStatusLabel('label_created'), 'Label Created');
  assert.equal(formatOrderStatusLabel('shipment_information_received'), 'Label Created');
  assert.equal(formatOrderStatusLabel('shipped'), 'Shipped');
  assert.equal(formatOrderStatusLabel('completed'), 'Shipped');
  assert.equal(formatOrderStatusLabel('in_transit'), 'In transit');
  assert.equal(formatOrderStatusLabel('out_for_delivery'), 'Out for Delivery');
  assert.equal(formatOrderStatusLabel('delivered'), 'Delivered');
  assert.equal(formatOrderStatusLabel('exception'), 'Exception');
});
