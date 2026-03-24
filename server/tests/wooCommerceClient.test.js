const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrderPayload } = require('../integration/wooCommerceClient');

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
  assert.equal(payload.customer_note, 'PepPro Order order-1');
  assert.equal(metaKeys.has('peppro_hand_delivery_address'), false);
  assert.equal(metaKeys.has('peppro_payment_method'), false);
});
