const Stripe = require('stripe');
const { env } = require('../config/env');
const { logger } = require('../config/logger');
const { getStripeModeSync } = require('../services/settingsService');

const stripeClients = new Map();

const resolveSecretKey = (mode) => {
  const normalized = String(mode || '').toLowerCase().trim() === 'live' ? 'live' : 'test';
  const liveKey = env.stripe?.liveSecretKey || env.stripe?.secretKey || '';
  const testKey = env.stripe?.testSecretKey || '';
  if (normalized === 'live') {
    return liveKey;
  }
  return testKey || liveKey;
};

const getEffectiveMode = () => getStripeModeSync();

const getClient = () => {
  const mode = getEffectiveMode();
  const secretKey = resolveSecretKey(mode);
  if (!env.stripe.externalEnabled || !env.stripe.onsiteEnabled || !secretKey) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  const cacheKey = `${mode}:${secretKey}`;
  const existing = stripeClients.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = Stripe(secretKey, {
    apiVersion: '2024-06-20',
  });
  stripeClients.set(cacheKey, created);
  return created;
};

const isConfigured = () =>
  Boolean(env.stripe.externalEnabled && env.stripe.onsiteEnabled && resolveSecretKey(getEffectiveMode()));
const isTaxConfigured = () => Boolean(env.stripe.externalEnabled && env.stripe.taxEnabled && isConfigured());

const retrievePaymentIntent = async (paymentIntentId) => {
  if (!isConfigured()) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  const stripe = getClient();
  return stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: [
      'charges.data.payment_method_details.card',
      'charges.data.payment_method_details.card_present',
      'charges.data.payment_method_details.card_swipe',
      'charges.data.payment_method_details.klarna',
      'latest_charge.payment_method_details.card',
      'latest_charge.payment_method_details.card_present',
    ],
  });
};

const createPaymentIntent = async ({ order, wooOrderId, wooOrderNumber, customer }) => {
  if (!isConfigured()) {
    return { status: 'skipped', reason: 'stripe_disabled' };
  }
  const stripe = getClient();
  const amount = Math.max(Math.round(Number(order.total || 0) * 100), 50);
  const metadata = {
    peppro_order_id: order.id ? String(order.id) : '',
    user_id: order.userId ? String(order.userId) : '',
  };
  if (wooOrderId) {
    metadata.woo_order_id = String(wooOrderId);
  }
  const normalizedWooOrderNumber = wooOrderNumber
    ? String(wooOrderNumber).replace(/^#/, '')
    : (wooOrderId ? String(wooOrderId) : '');
  if (normalizedWooOrderNumber) {
    metadata.woo_order_number = normalizedWooOrderNumber;
  }
  if (customer?.email) {
    metadata.customer_email = customer.email;
  }
  const descriptionParts = [];
  if (normalizedWooOrderNumber) {
    descriptionParts.push(`Woo Order #${normalizedWooOrderNumber}`);
  }
  if (order?.id) {
    descriptionParts.push(`PepPro Order ${order.id}`);
  }
  const description = descriptionParts.length > 0
    ? descriptionParts.join(' · ')
    : 'PepPro Order';

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata,
      description,
      automatic_payment_methods: { enabled: true },
    });
    return {
      status: 'success',
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Stripe PaymentIntent creation failed');
    const wrapped = new Error('Stripe PaymentIntent creation failed');
    wrapped.cause = error;
    wrapped.status = error?.statusCode || 502;
    throw wrapped;
  }
};

const constructEvent = (payload, signature) => {
  if (!env.stripe.webhookSecret) {
    const error = new Error('Stripe webhook secret is not configured');
    error.status = 400;
    throw error;
  }
  const stripe = getClient();
  return stripe.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
};

const refundPaymentIntent = async ({ paymentIntentId, amount, reason, metadata }) => {
  if (!isConfigured()) {
    const error = new Error('Stripe is not configured');
    error.status = 503;
    throw error;
  }
  if (!paymentIntentId) {
    const error = new Error('Payment intent ID is required for refunds');
    error.status = 400;
    throw error;
  }
  const stripe = getClient();
  const params = {
    payment_intent: paymentIntentId,
    reason: reason ? 'requested_by_customer' : undefined,
  };
  if (Number.isFinite(amount) && amount > 0) {
    params.amount = Math.round(amount);
  }
  if (metadata && typeof metadata === 'object') {
    const sanitizedMetadata = Object.entries(metadata).reduce((acc, [key, value]) => {
      if (value === undefined || value === null) {
        return acc;
      }
      acc[key] = String(value);
      return acc;
    }, {});
    if (Object.keys(sanitizedMetadata).length > 0) {
      params.metadata = sanitizedMetadata;
    }
  }
  try {
    return await stripe.refunds.create(params);
  } catch (error) {
    logger.error({ err: error, paymentIntentId }, 'Stripe refund failed');
    const wrapped = new Error('Stripe refund failed');
    wrapped.cause = error;
    wrapped.status = error?.statusCode || 502;
    throw wrapped;
  }
};

const calculateStripeTax = async ({ items, shippingAddress, shippingTotal }) => {
  if (!isTaxConfigured()) {
    return { status: 'skipped', reason: 'stripe_tax_disabled' };
  }

  const stripe = getClient();
  const currency = 'usd';

  const lineItems = (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const unitPrice = Number(item?.price) || 0;
      const quantity = Number(item?.quantity) || 0;
      const amount = Math.round(Math.max(0, unitPrice * quantity * 100));
      if (!amount) {
        return null;
      }
      const line = {
        amount,
        reference: item?.productId ? String(item.productId) : `line_${index + 1}`,
      };
      if (env.stripe.defaultTaxCode) {
        line.tax_code = env.stripe.defaultTaxCode;
      }
      return line;
    })
    .filter(Boolean);

  if (!lineItems.length) {
    const error = new Error('Stripe tax calculation requires at least one line item');
    error.status = 400;
    throw error;
  }

  const shippingAmount = Math.round(Math.max(0, Number(shippingTotal || 0) * 100));
  const shippingCost = shippingAmount
    ? {
        amount: shippingAmount,
        ...(env.stripe.shippingTaxCode || env.stripe.defaultTaxCode
          ? { tax_code: env.stripe.shippingTaxCode || env.stripe.defaultTaxCode }
          : {}),
      }
    : undefined;

  const address = shippingAddress || {};

  if (env.stripe.taxDebug) {
    logger.info(
      {
        taxDebug: true,
        event: 'stripe_tax_request',
        currency,
        rawItems: Array.isArray(items) ? items.length : 0,
        lineItems: lineItems.length,
        lineItemsPreview: lineItems.slice(0, 25).map((item) => ({
          reference: item.reference,
          amount: item.amount,
          tax_code: item.tax_code || null,
        })),
        shippingAmountCents: shippingAmount,
        shippingTaxCode: shippingCost?.tax_code || null,
        defaultTaxCode: env.stripe.defaultTaxCode || null,
        destination: {
          country: address.country || null,
          state: address.state || null,
          postal_code: address.postalCode || address.postcode || null,
          city: address.city || null,
        },
        missingPostalCode: !address.postalCode && !address.postcode,
        missingState: !address.state,
      },
      'Stripe Tax request payload',
    );
  }

  try {
    const calculation = await stripe.tax.calculations.create({
      currency,
      line_items: lineItems,
      ...(shippingCost ? { shipping_cost: shippingCost } : {}),
      customer_details: {
        address: {
          line1: address.addressLine1 || address.address1 || undefined,
          line2: address.addressLine2 || address.address2 || undefined,
          city: address.city || undefined,
          state: address.state || undefined,
          postal_code: address.postalCode || address.postcode || undefined,
          country: address.country || 'US',
        },
        address_source: 'shipping',
      },
    });

    let calculationLineItems = Array.isArray(calculation.line_items)
      ? calculation.line_items
      : (Array.isArray(calculation.line_items?.data) ? calculation.line_items.data : []);
    let lineItemsSource = calculationLineItems.length > 0 ? 'inline' : 'none';

    if (env.stripe.taxDebug && calculationLineItems.length === 0 && typeof stripe.tax?.calculations?.listLineItems === 'function') {
      try {
        const listed = await stripe.tax.calculations.listLineItems(calculation.id, { limit: 100 });
        if (Array.isArray(listed?.data) && listed.data.length > 0) {
          calculationLineItems = listed.data;
          lineItemsSource = 'listLineItems';
        }
      } catch (listError) {
        logger.warn({ err: listError, calculationId: calculation.id }, 'Stripe Tax listLineItems failed');
      }
    }

    const lineTaxCents = calculationLineItems.reduce(
      (sum, item) => sum + (Number(item?.amount_tax) || 0),
      0,
    );
    const shippingTaxCents = calculation.shipping_cost
      ? Number(calculation.shipping_cost.amount_tax) || 0
      : 0;
    const apiTaxExclusive = Number(calculation.tax_amount_exclusive);
    const apiTaxInclusive = Number(calculation.tax_amount_inclusive);
    const apiTaxAmount = Number(calculation.tax_amount);
    const apiTaxFallback = Number.isFinite(apiTaxExclusive)
      ? apiTaxExclusive
      : (Number.isFinite(apiTaxInclusive) ? apiTaxInclusive : (Number.isFinite(apiTaxAmount) ? apiTaxAmount : 0));
    const totalTaxCents = Math.max(lineTaxCents + shippingTaxCents, apiTaxFallback || 0);

    if (env.stripe.taxDebug) {
      const lineItemsSummary = calculationLineItems.map((item) => ({
            reference: item.reference || null,
            amount: item.amount || null,
            amount_tax: item.amount_tax || null,
            tax_code: item.tax_code || null,
            tax_behavior: item.tax_behavior || null,
            taxability_reason: item.taxability_reason || null,
            jurisdiction: item.jurisdiction || null,
          }));
      logger.info(
        {
          taxDebug: true,
          calculationId: calculation.id,
          currency,
          lineItems: calculationLineItems.length,
          lineItemsSource,
          lineItemsSummary,
          lineTaxCents,
          shippingTaxCents,
          totalTaxCents,
          taxAmountExclusive: Number.isFinite(apiTaxExclusive) ? apiTaxExclusive : null,
          taxAmountInclusive: Number.isFinite(apiTaxInclusive) ? apiTaxInclusive : null,
          shippingTaxCode: shippingCost?.tax_code || null,
          defaultTaxCode: env.stripe.defaultTaxCode || null,
          destination: {
            country: address.country || null,
            state: address.state || null,
            postal_code: address.postalCode || address.postcode || null,
            city: address.city || null,
          },
          calculationLineItemsShape: calculation.line_items && !Array.isArray(calculation.line_items)
            ? Object.keys(calculation.line_items).slice(0, 20)
            : null,
        },
        'Stripe Tax calculation result',
      );
    }

    return {
      status: 'success',
      taxAmount: totalTaxCents / 100,
      calculation,
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        taxDebug: Boolean(env.stripe.taxDebug),
        shippingTaxCode: env.stripe.shippingTaxCode || null,
        defaultTaxCode: env.stripe.defaultTaxCode || null,
      },
      'Stripe Tax calculation failed',
    );
    const wrapped = new Error(error?.message || 'Stripe Tax calculation failed');
    wrapped.status = error?.statusCode || 502;
    wrapped.code = error?.code || 'STRIPE_TAX_ERROR';
    wrapped.cause = error;
    throw wrapped;
  }
};

module.exports = {
  isConfigured,
  isTaxConfigured,
  createPaymentIntent,
  constructEvent,
  retrievePaymentIntent,
  refundPaymentIntent,
  calculateStripeTax,
};
