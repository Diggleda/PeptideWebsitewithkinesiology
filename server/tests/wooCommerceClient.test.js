const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrderPayload, mapWooOrderSummary } = require('../integration/wooCommerceClient');

test('buildOrderPayload preserves customer address data while keeping extra meta stripped', async () => {
  const payload = await buildOrderPayload({
    order: {
      id: 'order-1',
      createdAt: '2026-03-24T15:00:00Z',
      paymentMethod: 'zelle',
      paymentDetails: 'john@example.com',
      shippingTotal: 12.5,
      shippingEstimate: {
        serviceType: 'Hand Delivery',
        serviceCode: 'hand_delivery',
        carrierId: 'local_delivery',
      },
      shippingAddress: {
        name: 'John Doe',
        addressLine1: '123 Main St',
        city: 'Indianapolis',
        state: 'IN',
        postalCode: '46000',
        phone: '555-123-4567',
      },
      items: [
        {
          productId: '123',
          variantId: '456',
          sku: 'BPC-157-5MG',
          name: 'BPC-157',
          quantity: 1,
          price: 100,
          note: 'leave at front desk',
        },
      ],
    },
    customer: {
      name: 'John Doe',
      email: 'john@example.com',
    },
  });

  const metaKeys = new Set((payload.meta_data || []).map((entry) => entry.key));

  assert.equal(payload.billing.first_name, 'John');
  assert.equal(payload.billing.last_name, 'Doe');
  assert.equal(payload.billing.address_1, '123 Main St');
  assert.equal(payload.billing.email, 'john@example.com');
  assert.equal(payload.shipping.address_1, '123 Main St');
  assert.equal(payload.shipping.phone, '555-123-4567');
  assert.deepEqual(payload.line_items[0].meta_data, []);
  assert.equal('customer_note' in payload, false);
  assert.equal(metaKeys.has('peppro_hand_delivery_address'), false);
  assert.equal(metaKeys.has('peppro_payment_method'), false);
});

test('buildOrderPayload prefers facility pickup recipient name over fallback actor names', async () => {
  const payload = await buildOrderPayload({
    order: {
      id: 'order-facility-1',
      createdAt: '2026-04-22T15:00:00Z',
      paymentMethod: 'zelle',
      shippingTotal: 0,
      facilityPickupRecipientName: 'Recipient Patient',
      shippingEstimate: {
        serviceType: 'Facility pickup',
        serviceCode: 'facility_pickup',
        carrierId: 'facility_pickup',
      },
      shippingAddress: {
        name: 'Sales Lead User',
        addressLine1: '640 S Grand Ave',
        addressLine2: 'Unit #107',
        city: 'Santa Ana',
        state: 'CA',
        postalCode: '92705',
        country: 'US',
      },
      billingAddress: {
        firstName: 'Sales',
        lastName: 'Lead',
        addressLine1: '640 S Grand Ave',
        addressLine2: 'Unit #107',
        city: 'Santa Ana',
        state: 'CA',
        postalCode: '92705',
        country: 'US',
      },
      facilityPickup: true,
      fulfillmentMethod: 'facility_pickup',
      items: [
        {
          productId: '123',
          sku: 'PEP-123',
          name: 'Test Product',
          quantity: 1,
          price: 100,
        },
      ],
    },
    customer: {
      name: 'Sales Lead User',
      email: 'lead@example.com',
    },
  });

  assert.equal(payload.shipping.first_name, 'Recipient');
  assert.equal(payload.shipping.last_name, 'Patient');
  assert.equal(
    payload.meta_data.some(
      (entry) =>
        entry.key === 'peppro_facility_pickup_recipient_name' &&
        entry.value === 'Recipient Patient',
    ),
    true,
  );
});

test('mapWooOrderSummary restores facility pickup recipient name from metadata', () => {
  const mapped = mapWooOrderSummary({
    id: 9876,
    number: '9876',
    status: 'pending',
    currency: 'USD',
    total: '100.00',
    shipping_total: '0.00',
    date_created: '2026-04-22T15:00:00',
    meta_data: [
      { key: 'peppro_fulfillment_method', value: 'facility_pickup' },
      { key: 'peppro_facility_pickup_recipient_name', value: 'Recipient Patient' },
    ],
    shipping: {
      first_name: 'Sales',
      last_name: 'Lead',
      address_1: '640 S Grand Ave',
      address_2: 'Unit #107',
      city: 'Santa Ana',
      state: 'CA',
      postcode: '92705',
      country: 'US',
    },
    billing: {
      first_name: 'Sales',
      last_name: 'Lead',
      address_1: '640 S Grand Ave',
      address_2: 'Unit #107',
      city: 'Santa Ana',
      state: 'CA',
      postcode: '92705',
      country: 'US',
    },
    line_items: [],
  });

  assert.equal(mapped.shippingAddress.name, 'Recipient Patient');
  assert.equal(mapped.billingAddress.name, 'Recipient Patient');
});
