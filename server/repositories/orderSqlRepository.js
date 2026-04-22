const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { decryptJson, encryptJson } = require('../utils/cryptoEnvelope');

const sanitizeString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toOptionalBoolean = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
};

const roundCurrency = (value) => Math.max(0, Math.round((toNumber(value, 0) + 1e-9) * 100) / 100);
const HAND_DELIVERY_SERVICE_LABEL = 'Hand Delivered';

const normalizeFulfillmentMethod = (value, fallback = null) => {
  const normalized = sanitizeString(value || fallback);
  if (!normalized) {
    return null;
  }
  const key = normalized.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'facility_pickup' || key === 'fascility_pickup') {
    return 'facility_pickup';
  }
  if (
    key === 'hand_delivery'
    || key === 'hand_delivered'
    || key === 'local_hand_delivery'
    || key === 'local_delivery'
  ) {
    return 'hand_delivered';
  }
  return normalized;
};

const toIsoDateTime = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const resolveOrderPlacedAt = (order, createdAtFallback) => {
  if (!order || typeof order !== 'object') {
    return toIsoDateTime(createdAtFallback);
  }
  const candidates = [
    order.orderPlacedAt,
    order.order_placed_at,
    order.placedAt,
    order.placed_at,
    order.createdAt,
    order.created_at,
    createdAtFallback,
  ];
  for (const candidate of candidates) {
    const parsed = toIsoDateTime(candidate);
    if (parsed) return parsed;
  }
  return null;
};

const resolveShippedAt = (order) => {
  if (!order || typeof order !== 'object') return null;

  const explicitCandidates = [
    order.shippedAt,
    order.shipped_at,
    order.shippingEstimate?.shipDate,
    order.shippingEstimate?.shippedAt,
    order.integrationDetails?.shipStation?.shipDate,
    order.integrationDetails?.shipStation?.shippedAt,
    order.integrations?.shipStation?.shipDate,
    order.integrations?.shipStation?.shippedAt,
    order.integrations?.shipstation?.shipDate,
    order.integrations?.shipstation?.shippedAt,
  ];
  for (const candidate of explicitCandidates) {
    const parsed = toIsoDateTime(candidate);
    if (parsed) return parsed;
  }

  return null;
};

const normalizeUpsTrackingStatus = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const token = String(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) {
    return null;
  }
  if (token.includes('delivered')) return 'delivered';
  if (token.includes('out_for_delivery') || token.includes('outfordelivery')) return 'out_for_delivery';
  if (['exception', 'delay', 'delayed', 'hold', 'held'].some((part) => token.includes(part))) return 'exception';
  if (
    [
      'label_created',
      'shipment_ready_for_ups',
      'order_processed',
      'billing_information_received',
      'manifest_picked_up',
      'shipment_information_received',
    ].some((part) => token.includes(part))
  ) {
    return 'label_created';
  }
  if (
    [
      'in_transit',
      'intransit',
      'on_the_way',
      'ontheway',
      'departed',
      'arrived',
      'pickup_scan',
      'origin_scan',
      'destination_scan',
      'processing_at_ups_facility',
      'loaded_on_delivery_vehicle',
      'received_by_post_office_for_delivery',
    ].some((part) => token.includes(part))
  ) {
    return 'in_transit';
  }
  return 'unknown';
};

const applyUpsTrackingStatusToOrder = (order, status) => {
  if (!order || typeof order !== 'object') {
    return order;
  }
  const normalized = normalizeUpsTrackingStatus(status);
  if (!normalized) {
    return order;
  }
  const shippingEstimate = order.shippingEstimate && typeof order.shippingEstimate === 'object'
    ? { ...order.shippingEstimate }
    : {};
  shippingEstimate.status = normalized;
  const integrationDetails = order.integrationDetails && typeof order.integrationDetails === 'object'
    ? { ...order.integrationDetails }
    : {};
  const carrierTracking = integrationDetails.carrierTracking && typeof integrationDetails.carrierTracking === 'object'
    ? { ...integrationDetails.carrierTracking }
    : {};
  carrierTracking.carrier = carrierTracking.carrier || 'ups';
  carrierTracking.trackingNumber = carrierTracking.trackingNumber || order.trackingNumber || null;
  carrierTracking.trackingStatus = normalized;
  carrierTracking.trackingStatusRaw = carrierTracking.trackingStatusRaw || normalized;
  integrationDetails.carrierTracking = carrierTracking;
  order.upsTrackingStatus = normalized;
  order.shippingEstimate = shippingEstimate;
  order.integrationDetails = integrationDetails;
  if (order.integrations && typeof order.integrations === 'object') {
    order.integrations = {
      ...order.integrations,
      carrierTracking,
    };
  }
  return order;
};

const isFacilityPickupOrder = (order) => {
  if (!order || typeof order !== 'object') {
    return false;
  }
  const estimate = order.shippingEstimate;
  const estimateCandidates = estimate && typeof estimate === 'object'
    ? [estimate.serviceType, estimate.serviceCode, estimate.carrierId]
    : [];
  const orderCandidates = [
    order.shippingService,
    order.fulfillmentMethod,
    order.fulfillment_method,
    order.facilityPickup === true ? 'facility_pickup' : '',
    order.facility_pickup === true ? 'facility_pickup' : '',
  ];
  const normalized = estimateCandidates
    .concat(orderCandidates)
    .map((value) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .filter(Boolean);
  return normalized.some((value) => value === 'facility_pickup' || value === 'fascility_pickup');
};

const isHandDeliveryOrder = (order) => {
  if (!order || typeof order !== 'object' || isFacilityPickupOrder(order)) {
    return false;
  }
  const estimate = order.shippingEstimate;
  const estimateCandidates = estimate && typeof estimate === 'object'
    ? [estimate.serviceType, estimate.serviceCode, estimate.carrierId]
    : [];
  const orderCandidates = [
    order.shippingService,
    order.fulfillmentMethod,
    order.fulfillment_method,
    order.handDelivery === true ? 'hand_delivery' : '',
  ];
  const normalized = estimateCandidates
    .concat(orderCandidates)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return normalized.some((value) =>
    value === 'hand delivery'
    || value === 'hand delivered'
    || value === 'hand_delivery'
    || value === 'hand_delivered'
    || value === 'local hand delivery'
    || value === 'local_hand_delivery'
    || value === 'local_delivery'
    || value === 'hand-delivery'
    || value === 'hand-delivered');
};

const computeItemsSubtotal = (order) => {
  if (!order || typeof order !== 'object') {
    return 0;
  }
  const itemsSubtotal = toNumber(
    order.itemsSubtotal ?? order.items_subtotal ?? order.itemsTotal ?? order.items_total,
    NaN,
  );
  if (Number.isFinite(itemsSubtotal)) {
    return roundCurrency(itemsSubtotal);
  }
  const total = toNumber(order.total, NaN);
  const shippingTotal = toNumber(order.shippingTotal ?? order.shipping_total, 0);
  const taxTotal = toNumber(order.taxTotal ?? order.totalTax ?? order.total_tax, 0);
  if (Number.isFinite(total)) {
    return roundCurrency(total - shippingTotal - taxTotal);
  }
  return 0;
};

const computeGrandTotal = (order) => {
  if (!order || typeof order !== 'object') {
    return 0;
  }

  const grandTotal = toNumber(order.grandTotal, NaN);
  if (Number.isFinite(grandTotal)) {
    return roundCurrency(grandTotal);
  }

  const itemsSubtotal = toNumber(
    order.itemsSubtotal ?? order.items_subtotal ?? order.itemsTotal ?? order.items_total,
    NaN,
  );
  const shippingTotal = toNumber(order.shippingTotal ?? order.shipping_total, 0);
  const taxTotal = toNumber(order.taxTotal ?? order.totalTax ?? order.total_tax, 0);
  const discountTotal = toNumber(
    order.appliedReferralCredit ?? order.discountTotal ?? order.discount_total ?? order.totalDiscount,
    0,
  );

  if (Number.isFinite(itemsSubtotal)) {
    return roundCurrency(itemsSubtotal - discountTotal + shippingTotal + taxTotal);
  }

  // If we don't have a reliable subtotal, fall back to whatever the upstream total is.
  return roundCurrency(order.total ?? order.total_ex_tax ?? 0);
};

const buildCommerceIntegrationDetails = (integrationDetails) => {
  if (!integrationDetails || typeof integrationDetails !== 'object') {
    return null;
  }
  const sanitized = {};
  if (integrationDetails.wooCommerce && typeof integrationDetails.wooCommerce === 'object') {
    sanitized.wooCommerce = {
      id: sanitizeString(integrationDetails.wooCommerce.id),
      number: sanitizeString(integrationDetails.wooCommerce.number),
      status: sanitizeString(integrationDetails.wooCommerce.status),
      invoiceUrl: sanitizeString(integrationDetails.wooCommerce.invoiceUrl),
      paymentUrl: sanitizeString(integrationDetails.wooCommerce.paymentUrl),
    };
  }
  if (integrationDetails.shipStation && typeof integrationDetails.shipStation === 'object') {
    sanitized.shipStation = {
      orderId: sanitizeString(integrationDetails.shipStation.orderId),
      orderNumber: sanitizeString(integrationDetails.shipStation.orderNumber),
      status: sanitizeString(integrationDetails.shipStation.status),
      shipmentId: sanitizeString(integrationDetails.shipStation.shipmentId),
      trackingNumber: sanitizeString(integrationDetails.shipStation.trackingNumber),
      shipDate: toIsoDateTime(integrationDetails.shipStation.shipDate),
    };
  }
  if (integrationDetails.stripe && typeof integrationDetails.stripe === 'object') {
    sanitized.stripe = {
      paymentIntentId: sanitizeString(integrationDetails.stripe.paymentIntentId),
      status: sanitizeString(integrationDetails.stripe.status),
      mode: sanitizeString(integrationDetails.stripe.mode),
    };
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
};

const buildCommercePayload = (order, payloadOrder = {}) => {
  const source = payloadOrder && typeof payloadOrder === 'object' ? payloadOrder : order;
  if (!source || typeof source !== 'object') {
    return {};
  }
  const sanitized = {
    ...source,
    shippingAddress: null,
    shipping_address: null,
    billingAddress: null,
    billing_address: null,
    paymentDetails: null,
    paymentMethod: null,
    customer: null,
    customerInfo: null,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    doctorEmail: null,
    doctorName: null,
    salesRepEmail: null,
    doctorSalesRepEmail: null,
    email: null,
    phone: null,
    instructions: null,
    paymentInstructions: null,
    notes: null,
    delegateProposalToken: null,
    delegateToken: null,
    token: null,
  };
  if (sanitized.items && Array.isArray(sanitized.items)) {
    sanitized.items = sanitized.items.map((item) => ({
      productId: item?.productId ?? item?.product_id ?? null,
      variationId: item?.variationId ?? item?.variation_id ?? null,
      sku: item?.sku ?? null,
      quantity: Number(item?.quantity || 0),
      price: Number(item?.price || 0),
      name: typeof item?.name === 'string' ? item.name : 'Item',
    }));
  }
  return sanitized;
};

const buildEncryptedOrderPayload = (order, createdAtRaw, orderPlacedAt, shippedAt) => ({
  order: {
    ...(order && typeof order === 'object' ? order : {}),
    total: computeGrandTotal(order),
    grandTotal: computeGrandTotal(order),
    orderPlacedAt,
    order_placed_at: orderPlacedAt,
    shippedAt,
    shipped_at: shippedAt,
    createdAt: createdAtRaw,
    created_at: createdAtRaw,
  },
  orders: {
    created_at: createdAtRaw,
  },
  integrations: order?.integrationDetails || null,
});

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
};

const readInlineJsonField = (row, tableName, fieldName) => {
  const candidateTables = Array.from(new Set([tableName, 'orders', 'peppro_orders'].filter(Boolean)));
  for (const candidateTable of candidateTables) {
    const decoded = decryptJson(row?.[fieldName], {
      aad: {
        table: candidateTable,
        record_ref: sanitizeString(row?.id) || 'pending',
        field: fieldName,
      },
    });
    if (decoded !== null && decoded !== undefined) {
      return decoded;
    }
  }
  const decoded = decryptJson(row?.[fieldName]);
  if (decoded !== null && decoded !== undefined) {
    return decoded;
  }
  return parseJson(row?.[fieldName], null);
};

const readEncryptedOrderPayload = (row, tableName = 'peppro_orders') => {
  const legacy = decryptJson(row?.payload_encrypted, {
    aad: {
      table: 'peppro_orders',
      record_ref: sanitizeString(row?.phi_payload_ref || row?.id) || 'pending',
      field: 'payload',
    },
  });
  if (legacy && typeof legacy === 'object') {
    return legacy;
  }
  const inline = readInlineJsonField(row, tableName, 'payload');
  if (inline && typeof inline === 'object') {
    return inline;
  }
  return parseJson(row?.payload, {});
};

const normalizeOrderToken = (value) => {
  const text = sanitizeString(value);
  if (!text) return null;
  return text.startsWith('#') ? text.slice(1) : text;
};

const extractWooOrderTokens = (order) => {
  const candidates = [
    order?.wooOrderNumber,
    order?.woo_order_number,
    order?.wooOrderId,
    order?.woo_order_id,
    order?.payload?.integrations?.wooCommerce?.response?.number,
    order?.payload?.integrations?.wooCommerce?.wooOrderNumber,
    order?.payload?.integrations?.woocommerce?.response?.number,
    order?.payload?.integrations?.woocommerce?.wooOrderNumber,
    order?.payload?.wooOrderNumber,
    order?.payload?.woo_order_number,
    order?.payload?.number,
  ];
  return new Set(candidates.map((value) => normalizeOrderToken(value)).filter(Boolean));
};

const extractBillingEmails = (order) => {
  const candidates = [
    order?.billingAddress?.email,
    order?.billingAddress?.emailAddress,
    order?.billing_address?.email,
    order?.billing_address?.email_address,
    order?.billing?.email,
    order?.billing_email,
    order?.billingEmail,
    order?.payload?.order?.billing?.email,
    order?.payload?.order?.billing_email,
    order?.payload?.order?.billingEmail,
    order?.payload?.order?.billingAddress?.email,
    order?.payload?.order?.billingAddress?.emailAddress,
    order?.payload?.order?.billing_address?.email,
    order?.payload?.order?.billing_address?.email_address,
  ];
  return new Set(
    candidates
      .map((value) => sanitizeString(value)?.toLowerCase() || null)
      .filter(Boolean),
  );
};

const safeFetchAllCompat = async (query, params = {}) => {
  try {
    return await mysqlClient.fetchAll(query, params);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
      return [];
    }
    throw error;
  }
};

const persistOrder = async ({ order, wooOrderId, shipStationOrderId }) => {
  if (!mysqlClient.isEnabled()) {
    return {
      status: 'skipped',
      reason: 'mysql_disabled',
    };
  }

  const normalizePricingMode = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'retail') return 'retail';
    return 'wholesale';
  };

  const appendPstSuffix = (value) => {
    const trimmed = sanitizeString(value);
    if (!trimmed) return null;
    return /\bPST$/i.test(trimmed) ? trimmed : `${trimmed} PST`;
  };

  const createdAtRaw = sanitizeString(order.createdAt) || new Date().toISOString();
  const createdAtRawWithPst = appendPstSuffix(createdAtRaw);
  const orderPlacedAt = resolveOrderPlacedAt(order, createdAtRaw);
  const shippedAt = resolveShippedAt(order);
  const upsTrackingStatus = normalizeUpsTrackingStatus(
    order.upsTrackingStatus !== undefined ? order.upsTrackingStatus : order.ups_tracking_status,
  );

  const payload = {
    id: sanitizeString(order.id),
    userId: sanitizeString(order.userId),
    pricingMode: normalizePricingMode(order.pricingMode),
    isTaxExempt: toOptionalBoolean(order.isTaxExempt ?? order.is_tax_exempt) === true ? 1 : 0,
    taxExemptSource: sanitizeString(order.taxExemptSource ?? order.tax_exempt_source),
    taxExemptReason: sanitizeString(order.taxExemptReason ?? order.tax_exempt_reason),
    resellerPermitFilePath: sanitizeString(
      order.resellerPermitFilePath ?? order.reseller_permit_file_path,
    ),
    resellerPermitFileName: sanitizeString(
      order.resellerPermitFileName ?? order.reseller_permit_file_name,
    ),
    resellerPermitUploadedAt: toIsoDateTime(
      order.resellerPermitUploadedAt ?? order.reseller_permit_uploaded_at,
    ),
    wooOrderId: wooOrderId || null,
    shipStationOrderId: shipStationOrderId || null,
    itemsSubtotal: computeItemsSubtotal(order),
    total: computeGrandTotal(order),
    shippingTotal: toNumber(order.shippingTotal ?? order.shipping_total, 0),
    shippingCarrier: order.shippingEstimate?.carrierId || order.shippingEstimate?.serviceCode || null,
    shippingService: isHandDeliveryOrder(order)
      ? HAND_DELIVERY_SERVICE_LABEL
      : (order.shippingEstimate?.serviceType || order.shippingEstimate?.serviceCode || order.shippingService || null),
    handDelivery: isFacilityPickupOrder(order) ? 1 : 0,
    fulfillmentMethod: isFacilityPickupOrder(order)
      ? 'facility_pickup'
      : (isHandDeliveryOrder(order)
        ? 'hand_delivered'
        : normalizeFulfillmentMethod(order.fulfillmentMethod)),
    physicianCertified: order.physicianCertificationAccepted === true ? 1 : 0,
    status: order.status || 'pending',
    orderPlacedAt,
    shippedAt,
    upsTrackingStatus,
    paymentDetails: null,
    payload: encryptJson(
      buildEncryptedOrderPayload(order, createdAtRawWithPst || createdAtRaw, orderPlacedAt, shippedAt),
      {
        aad: {
          table: 'peppro_orders',
          record_ref: sanitizeString(order.id) || 'pending',
          field: 'payload',
        },
      },
    ),
    createdAt: createdAtRaw,
    updatedAt: new Date().toISOString(),
  };

  try {
    await mysqlClient.execute(
      `
        INSERT INTO peppro_orders (
          id,
          user_id,
          pricing_mode,
          is_tax_exempt,
          tax_exempt_source,
          tax_exempt_reason,
          reseller_permit_file_path,
          reseller_permit_file_name,
          reseller_permit_uploaded_at,
          woo_order_id,
          shipstation_order_id,
          items_subtotal,
          total,
          shipping_total,
          shipping_carrier,
          shipping_service,
          facility_pickup,
          fulfillment_method,
          physician_certified,
          status,
          order_placed_at,
          shipped_at,
          ups_tracking_status,
          \`Payment Details\`,
          payload,
          created_at,
          updated_at
        ) VALUES (
          :id,
          :userId,
          :pricingMode,
          :isTaxExempt,
          :taxExemptSource,
          :taxExemptReason,
          :resellerPermitFilePath,
          :resellerPermitFileName,
          :resellerPermitUploadedAt,
          :wooOrderId,
          :shipStationOrderId,
          :itemsSubtotal,
          :total,
          :shippingTotal,
          :shippingCarrier,
          :shippingService,
          :handDelivery,
          :fulfillmentMethod,
          :physicianCertified,
          :status,
          :orderPlacedAt,
          :shippedAt,
          :upsTrackingStatus,
          :paymentDetails,
          :payload,
          :createdAt,
          :updatedAt
        )
        ON DUPLICATE KEY UPDATE
          woo_order_id = VALUES(woo_order_id),
          shipstation_order_id = VALUES(shipstation_order_id),
          is_tax_exempt = VALUES(is_tax_exempt),
          tax_exempt_source = VALUES(tax_exempt_source),
          tax_exempt_reason = VALUES(tax_exempt_reason),
          reseller_permit_file_path = VALUES(reseller_permit_file_path),
          reseller_permit_file_name = VALUES(reseller_permit_file_name),
          reseller_permit_uploaded_at = VALUES(reseller_permit_uploaded_at),
          items_subtotal = VALUES(items_subtotal),
          total = VALUES(total),
          shipping_total = VALUES(shipping_total),
          shipping_carrier = VALUES(shipping_carrier),
          shipping_service = VALUES(shipping_service),
          facility_pickup = VALUES(facility_pickup),
          fulfillment_method = VALUES(fulfillment_method),
          physician_certified = VALUES(physician_certified),
          status = VALUES(status),
          order_placed_at = COALESCE(order_placed_at, VALUES(order_placed_at)),
          shipped_at = COALESCE(shipped_at, VALUES(shipped_at)),
          ups_tracking_status = VALUES(ups_tracking_status),
          \`Payment Details\` = VALUES(\`Payment Details\`),
          payload = VALUES(payload),
          pricing_mode = VALUES(pricing_mode),
          updated_at = VALUES(updated_at)
      `,
      payload,
    );

    return {
      status: 'success',
    };
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, 'Failed to persist order to MySQL');
    return {
      status: 'error',
      message: error.message,
    };
  }
};

const mapRowToOrder = (row, options = {}) => {
  if (!row) return null;
  const tableName = options?.source === 'mysql:orders' ? 'orders' : 'peppro_orders';
  const payload = readEncryptedOrderPayload(row, tableName);
  // Node backend stores payload as `{ order: {...}, integrations: ... }`, while the Python backend
  // stores the order dict directly as the payload. Tolerate both.
  const payloadOrder = (() => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (payload.order && typeof payload.order === 'object' && !Array.isArray(payload.order)) {
        return payload.order;
      }
      return payload;
    }
    return {};
  })();

  const coalesce = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  };

  const toIso = (value) => {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };

  const computedItemsSubtotal = (() => {
    const rowSubtotal = toNumber(row.items_subtotal, NaN);
    if (Number.isFinite(rowSubtotal) && rowSubtotal > 0) {
      return roundCurrency(rowSubtotal);
    }
    const payloadSubtotal = computeItemsSubtotal(payloadOrder);
    return payloadSubtotal > 0 ? payloadSubtotal : null;
  })();

  const normalized = {
    ...payloadOrder,
    id: sanitizeString(coalesce(payloadOrder.id, row.id)),
    userId: sanitizeString(coalesce(payloadOrder.userId, row.user_id)),
    pricingMode: sanitizeString(coalesce(payloadOrder.pricingMode, row.pricing_mode)) || 'wholesale',
    asDelegate: sanitizeString(coalesce(payloadOrder.asDelegate, payloadOrder.as_delegate, row.as_delegate)),
    as_delegate: sanitizeString(coalesce(payloadOrder.as_delegate, payloadOrder.asDelegate, row.as_delegate)),
    wooOrderId: sanitizeString(coalesce(payloadOrder.wooOrderId, row.woo_order_id)),
    wooOrderNumber: sanitizeString(coalesce(
      payloadOrder.wooOrderNumber,
      payload?.integrations?.wooCommerce?.response?.number,
      payloadOrder.wooOrderId,
      row.woo_order_id,
    )),
    shipStationOrderId: sanitizeString(coalesce(payloadOrder.shipStationOrderId, row.shipstation_order_id)),
    upsTrackingStatus: normalizeUpsTrackingStatus(
      coalesce(
        row.ups_tracking_status,
        payloadOrder.upsTrackingStatus,
        payloadOrder.ups_tracking_status,
        payload?.upsTrackingStatus,
        payload?.ups_tracking_status,
      ),
    ),
    isTaxExempt: (() => {
      const explicit = toOptionalBoolean(
        coalesce(payloadOrder.isTaxExempt, payloadOrder.is_tax_exempt, row.is_tax_exempt),
      );
      return explicit === true;
    })(),
    taxExemptSource: sanitizeString(
      coalesce(payloadOrder.taxExemptSource, payloadOrder.tax_exempt_source, row.tax_exempt_source),
    ),
    taxExemptReason: sanitizeString(
      coalesce(payloadOrder.taxExemptReason, payloadOrder.tax_exempt_reason, row.tax_exempt_reason),
    ),
    resellerPermitFilePath: sanitizeString(
      coalesce(
        payloadOrder.resellerPermitFilePath,
        payloadOrder.reseller_permit_file_path,
        row.reseller_permit_file_path,
      ),
    ),
    resellerPermitFileName: sanitizeString(
      coalesce(
        payloadOrder.resellerPermitFileName,
        payloadOrder.reseller_permit_file_name,
        row.reseller_permit_file_name,
      ),
    ),
    resellerPermitUploadedAt: toIso(
      coalesce(
        payloadOrder.resellerPermitUploadedAt,
        payloadOrder.reseller_permit_uploaded_at,
        row.reseller_permit_uploaded_at,
      ),
    ),
    total: (() => {
      const rowTotal = toNumber(row.total, NaN);
      if (Number.isFinite(rowTotal) && rowTotal > 0) {
        return roundCurrency(rowTotal);
      }
      const payloadGrand = computeGrandTotal(payloadOrder);
      return payloadGrand > 0 ? payloadGrand : roundCurrency(payloadOrder.total ?? 0);
    })(),
    itemsSubtotal: computedItemsSubtotal,
    shippingTotal: (() => {
      const rowShipping = toNumber(row.shipping_total, NaN);
      if (Number.isFinite(rowShipping) && rowShipping > 0) {
        return roundCurrency(rowShipping);
      }
      return roundCurrency(payloadOrder.shippingTotal ?? payloadOrder.shipping_total ?? 0);
    })(),
    shippingCarrier: sanitizeString(coalesce(payloadOrder.shippingCarrier, row.shipping_carrier)),
    shippingService: sanitizeString(coalesce(payloadOrder.shippingService, row.shipping_service)),
    trackingNumber: sanitizeString(coalesce(
      payloadOrder.trackingNumber,
      payloadOrder.tracking_number,
      payloadOrder.integrationDetails?.carrierTracking?.trackingNumber,
      payloadOrder.integrationDetails?.carrier_tracking?.trackingNumber,
      payload?.integrations?.shipStation?.trackingNumber,
      payload?.integrations?.carrierTracking?.trackingNumber,
      payload?.integrations?.carrier_tracking?.trackingNumber,
    )),
    physicianCertificationAccepted: typeof payloadOrder.physicianCertificationAccepted === 'boolean'
      ? payloadOrder.physicianCertificationAccepted
      : Boolean(row.physician_certified),
    handDelivery: typeof payloadOrder.handDelivery === 'boolean'
      ? payloadOrder.handDelivery
      : Boolean(row.facility_pickup),
    fulfillmentMethod: normalizeFulfillmentMethod(
      payloadOrder.fulfillmentMethod,
      row.fulfillment_method,
    )
      || (Boolean(
        typeof payloadOrder.handDelivery === 'boolean'
          ? payloadOrder.handDelivery
          : row.facility_pickup,
      ) ? 'hand_delivered' : 'shipping'),
    status: payloadOrder.status || row.status || 'pending',
    orderPlacedAt: toIso(
      payloadOrder.orderPlacedAt
      || payloadOrder.order_placed_at
      || row.order_placed_at
      || payloadOrder.createdAt
      || payloadOrder.created_at
      || row.created_at,
    ),
    shippedAt: toIso(
      payloadOrder.shippedAt
      || payloadOrder.shipped_at
      || payloadOrder.shippingEstimate?.shipDate
      || payloadOrder.shippingEstimate?.shippedAt
      || payload?.integrations?.shipStation?.shipDate
      || payload?.integrations?.shipStation?.shippedAt
      || row.shipped_at,
    ),
    createdAt: toIso(payloadOrder.createdAt || payloadOrder.created_at || row.created_at || row.updated_at || payloadOrder.updatedAt || payloadOrder.updated_at),
    updatedAt: toIso(payloadOrder.updatedAt || payloadOrder.updated_at || row.updated_at || row.created_at || payloadOrder.createdAt || payloadOrder.created_at),
    integrationDetails: payloadOrder.integrationDetails
      || payloadOrder.integrations
      || payload.integrations
      || null,
    integrations: payloadOrder.integrations
      || payload.integrations
      || null,
    items: Array.isArray(payloadOrder.items) ? payloadOrder.items : [],
    shippingEstimate: payloadOrder.shippingEstimate || null,
    shippingAddress: payloadOrder.shippingAddress
      || payloadOrder.shipping_address
      || readInlineJsonField(row, tableName, 'shipping_address')
      || null,
    billingAddress: payloadOrder.billingAddress
      || payloadOrder.billing_address
      || null,
    paymentMethod: payloadOrder.paymentMethod
      || sanitizeString(row['Payment Details'])
      || null,
    paymentDetails: payloadOrder.paymentDetails
      || sanitizeString(row['Payment Details'])
      || payloadOrder.paymentMethod
      || null,
    referrerBonus: payloadOrder.referrerBonus || null,
    referralCode: payloadOrder.referralCode || null,
    taxTotal: payloadOrder.taxTotal ?? payloadOrder.tax_total ?? payloadOrder.totalTax ?? payloadOrder.total_tax ?? null,
    payload,
    source: options?.source || 'mysql',
  };

  normalized.hasResellerPermitUploaded = Boolean(
    normalized.resellerPermitFilePath
    || normalized.resellerPermitFileName
    || normalized.resellerPermitUploadedAt,
  );
  normalized.isTaxExempt = normalized.isTaxExempt === true || Boolean(normalized.taxExemptSource);
  applyUpsTrackingStatusToOrder(normalized, normalized.upsTrackingStatus);

  return normalized;
};

const safeFetchAll = async (query, params = {}) => {
  try {
    return await mysqlClient.fetchAll(query, params);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ER_NO_SUCH_TABLE') {
      return [];
    }
    throw error;
  }
};

const safeFetchOne = async (query, params) => {
  try {
    return await mysqlClient.fetchOne(query, params);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }
};

const dedupeOrders = (orders) => {
  const byId = new Map();
  (orders || []).forEach((order) => {
    const id = sanitizeString(order?.id);
    if (!id) return;
    if (!byId.has(id)) {
      byId.set(id, order);
      return;
    }
    const existing = byId.get(id);
    const existingUpdated = Date.parse(String(existing?.updatedAt || '')) || 0;
    const nextUpdated = Date.parse(String(order?.updatedAt || '')) || 0;
    if (nextUpdated >= existingUpdated) {
      byId.set(id, order);
    }
  });
  return Array.from(byId.values());
};

const fetchAll = async () => {
  if (!mysqlClient.isEnabled()) return [];
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll('SELECT * FROM peppro_orders'),
    safeFetchAll('SELECT * FROM orders'),
  ]);
  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);
  return dedupeOrders(orders);
};

const fetchById = async (orderId) => {
  if (!mysqlClient.isEnabled() || !orderId) {
    return null;
  }
  const [pepproRow, legacyRow] = await Promise.all([
    safeFetchOne('SELECT * FROM peppro_orders WHERE id = :id LIMIT 1', { id: orderId }),
    safeFetchOne('SELECT * FROM orders WHERE id = :id LIMIT 1', { id: orderId }),
  ]);
  const candidates = [];
  if (pepproRow) candidates.push(mapRowToOrder(pepproRow, { source: 'mysql:peppro_orders' }));
  if (legacyRow) candidates.push(mapRowToOrder(legacyRow, { source: 'mysql:orders' }));
  return dedupeOrders(candidates)[0] || null;
};

const fetchByShipStationOrderId = async (shipStationOrderId) => {
  if (!mysqlClient.isEnabled() || !shipStationOrderId) {
    return null;
  }
  const row = await mysqlClient.fetchOne(
    'SELECT * FROM peppro_orders WHERE shipstation_order_id = :shipStationOrderId LIMIT 1',
    { shipStationOrderId: String(shipStationOrderId) },
  );
  return mapRowToOrder(row);
};

const fetchByWooOrderId = async (wooOrderId) => {
  if (!mysqlClient.isEnabled() || !wooOrderId) {
    return null;
  }
  const value = String(wooOrderId).trim();
  if (!value) return null;

  const safeFetchOneCompat = async (query, params) => {
    try {
      return await mysqlClient.fetchOne(query, params);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
        return null;
      }
      throw error;
    }
  };

  const [pepproRow, legacyRow] = await Promise.all([
    safeFetchOneCompat('SELECT * FROM peppro_orders WHERE woo_order_id = :wooOrderId LIMIT 1', { wooOrderId: value }),
    safeFetchOneCompat('SELECT * FROM orders WHERE woo_order_id = :wooOrderId LIMIT 1', { wooOrderId: value }),
  ]);

  const candidates = [];
  if (pepproRow) candidates.push(mapRowToOrder(pepproRow, { source: 'mysql:peppro_orders' }));
  if (legacyRow) candidates.push(mapRowToOrder(legacyRow, { source: 'mysql:orders' }));
  return dedupeOrders(candidates)[0] || null;
};

const fetchByWooOrderNumber = async (wooOrderNumber) => {
  if (!mysqlClient.isEnabled() || !wooOrderNumber) {
    return null;
  }
  const value = String(wooOrderNumber).trim();
  if (!value) return null;

  const safeFetchOneCompat = async (query, params) => {
    try {
      return await mysqlClient.fetchOne(query, params);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
        return null;
      }
      throw error;
    }
  };

  const numericValue = Number.parseInt(value, 10);
  const directMatchPepPro = Number.isFinite(numericValue)
    ? await safeFetchOneCompat('SELECT * FROM peppro_orders WHERE woo_order_id = :wooOrderId LIMIT 1', { wooOrderId: numericValue })
    : null;
  const directMatchLegacy = await safeFetchOneCompat(
    `
      SELECT *
      FROM orders
      WHERE woo_order_number = :value OR woo_order_id = :value
      LIMIT 1
    `,
    { value },
  );

  const candidates = [];
  if (directMatchPepPro) candidates.push(mapRowToOrder(directMatchPepPro, { source: 'mysql:peppro_orders' }));
  if (directMatchLegacy) candidates.push(mapRowToOrder(directMatchLegacy, { source: 'mysql:orders' }));
  const directMatch = dedupeOrders(candidates).find((order) => extractWooOrderTokens(order).has(value));
  if (directMatch) {
    return directMatch;
  }

  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAllCompat('SELECT * FROM peppro_orders ORDER BY COALESCE(updated_at, created_at) DESC'),
    safeFetchAllCompat('SELECT * FROM orders ORDER BY COALESCE(updated_at, created_at) DESC'),
  ]);
  const orders = []
    .concat((pepproRows || []).map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })))
    .concat((legacyRows || []).map((row) => mapRowToOrder(row, { source: 'mysql:orders' })))
    .filter(Boolean);
  return dedupeOrders(orders).find((order) => extractWooOrderTokens(order).has(value)) || null;
};

const fetchByUserIds = async (userIds = []) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const placeholders = userIds.map((_, idx) => `:id${idx}`).join(', ');
  const params = userIds.reduce((acc, id, idx) => ({ ...acc, [`id${idx}`]: id }), {});
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll(`SELECT * FROM peppro_orders WHERE user_id IN (${placeholders})`, params),
    safeFetchAll(`SELECT * FROM orders WHERE user_id IN (${placeholders})`, params),
  ]);
  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);
  return dedupeOrders(orders);
};

const fetchByBillingEmails = async (emails = []) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(emails) || emails.length === 0) return [];
  const normalized = Array.from(
    new Set(
      emails
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (normalized.length === 0) return [];
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAllCompat('SELECT * FROM peppro_orders ORDER BY COALESCE(updated_at, created_at) DESC'),
    safeFetchAllCompat('SELECT * FROM orders ORDER BY COALESCE(updated_at, created_at) DESC'),
  ]);

  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);

  return dedupeOrders(orders).filter((order) => {
    const orderEmails = extractBillingEmails(order);
    return normalized.some((email) => orderEmails.has(email));
  });
};

const fetchByUserId = async (userId) => {
  if (!mysqlClient.isEnabled() || !userId) return [];
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll('SELECT * FROM peppro_orders WHERE user_id = :userId ORDER BY created_at DESC', { userId }),
    safeFetchAll('SELECT * FROM orders WHERE user_id = :userId ORDER BY created_at DESC', { userId }),
  ]);
  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);
  return dedupeOrders(orders).sort((a, b) => (Date.parse(String(b.createdAt || '')) || 0) - (Date.parse(String(a.createdAt || '')) || 0));
};

const fetchByStatuses = async (statuses = [], options = {}) => {
  if (!mysqlClient.isEnabled()) return [];
  if (!Array.isArray(statuses) || statuses.length === 0) return [];

  const normalizedStatuses = Array.from(
    new Set(
      statuses
        .map((value) => (value == null ? '' : String(value).trim().toLowerCase()))
        .filter(Boolean),
    ),
  );
  if (normalizedStatuses.length === 0) return [];

  const placeholders = normalizedStatuses.map((_, idx) => `:status${idx}`).join(', ');
  const params = normalizedStatuses.reduce(
    (acc, status, idx) => ({ ...acc, [`status${idx}`]: status }),
    {},
  );

  const limitRaw = Number(options?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000)
    : 500;

  const statusExpr = "LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-'))";
  const [pepproRows, legacyRows] = await Promise.all([
    safeFetchAll(
      `
        SELECT *
        FROM peppro_orders
        WHERE COALESCE(status_normalized, '') IN (${placeholders})
        ORDER BY COALESCE(created_at, updated_at) DESC
        LIMIT ${limit}
      `,
      params,
    ),
    safeFetchAll(
      `
        SELECT *
        FROM orders
        WHERE ${statusExpr} IN (${placeholders})
        ORDER BY COALESCE(created_at, updated_at) DESC
        LIMIT ${limit}
      `,
      params,
    ),
  ]);

  const orders = []
    .concat(Array.isArray(pepproRows) ? pepproRows.map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' })) : [])
    .concat(Array.isArray(legacyRows) ? legacyRows.map((row) => mapRowToOrder(row, { source: 'mysql:orders' })) : [])
    .filter(Boolean);

  return dedupeOrders(orders).sort(
    (a, b) =>
      (Date.parse(String(b.createdAt || b.updatedAt || '')) || 0)
      - (Date.parse(String(a.createdAt || a.updatedAt || '')) || 0),
  );
};

const updateUpsTrackingStatus = async (orderId, { upsTrackingStatus } = {}) => {
  if (!mysqlClient.isEnabled() || !orderId) {
    return null;
  }

  await mysqlClient.execute(
    `
      UPDATE peppro_orders
      SET ups_tracking_status = :upsTrackingStatus,
          updated_at = :updatedAt
      WHERE id = :id
    `,
    {
      id: String(orderId),
      upsTrackingStatus: normalizeUpsTrackingStatus(upsTrackingStatus),
      updatedAt: new Date().toISOString(),
    },
  );

  return fetchById(orderId);
};

const fetchRecentForUpsSync = async ({ lookbackDays = 60, limit = 250 } = {}) => {
  if (!mysqlClient.isEnabled()) {
    return [];
  }

  const safeLookbackDays = Math.max(1, Math.min(Math.trunc(Number(lookbackDays) || 60), 180));
  const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || 250), 1000));
  const cutoff = new Date(Date.now() - (safeLookbackDays * 24 * 60 * 60 * 1000)).toISOString();
  const rows = await safeFetchAll(
    `
      SELECT *
      FROM peppro_orders
      WHERE COALESCE(updated_at, created_at) >= :cutoff
        AND COALESCE(facility_pickup, 0) = 0
        AND COALESCE(ups_tracking_status, '') <> 'delivered'
        AND COALESCE(status_normalized, '') NOT IN ('cancelled', 'canceled', 'trash', 'refunded', 'failed')
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT ${safeLimit}
    `,
    { cutoff },
  );

  return dedupeOrders(
    (rows || [])
      .map((row) => mapRowToOrder(row, { source: 'mysql:peppro_orders' }))
      .filter(Boolean),
  );
};

module.exports = {
  persistOrder,
  fetchAll,
  fetchByUserId,
  fetchByUserIds,
  fetchByBillingEmails,
  fetchById,
  fetchByWooOrderId,
  fetchByWooOrderNumber,
  fetchByShipStationOrderId,
  fetchByStatuses,
  fetchRecentForUpsSync,
  normalizeUpsTrackingStatus,
  updateUpsTrackingStatus,
};
