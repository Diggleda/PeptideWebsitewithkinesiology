import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMeaningfulShippingStatus,
  shouldDisplayShippingStatusForOrder,
} from '../../src/lib/orderStatusPrecedence.mjs';

test('meaningful in-flight shipping statuses still surface over order states', () => {
  assert.equal(isMeaningfulShippingStatus('Out for Delivery'), true);
  assert.equal(isMeaningfulShippingStatus('Delivered'), true);
  assert.equal(shouldDisplayShippingStatusForOrder('completed', 'Delivered'), true);
});

test('carrier exceptions do not override authoritative order states', () => {
  assert.equal(shouldDisplayShippingStatusForOrder('processing', 'Exception'), false);
  assert.equal(shouldDisplayShippingStatusForOrder('on-hold', 'Exception'), false);
  assert.equal(shouldDisplayShippingStatusForOrder('completed', 'Exception'), false);
});

test('carrier exceptions can still surface when no real order state exists yet', () => {
  assert.equal(shouldDisplayShippingStatusForOrder('', 'Exception'), true);
  assert.equal(shouldDisplayShippingStatusForOrder(null, 'Label Created'), true);
});
