const { logger } = require('../config/logger');
const orderService = require('../services/orderService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const axios = require('axios');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');
const userRepository = require('../repositories/userRepository');
const { buildInvoicePdf } = require('../services/invoicePdf');
const {
  syncWooFromShipStation,
  runShipStationStatusSyncOnce,
  getShipStationStatusSyncState,
} = require('../services/shipStationSyncService');

const normalizeRole = (role) => (role || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');
const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : '');
const normalizeOrderToken = (value) => String(value || '').trim().replace(/^#/, '');
const normalizeBooleanFlag = (value) => {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1'
      || normalized === 'true'
      || normalized === 'yes'
      || normalized === 'on';
  }
  return false;
};

const shouldServeFakeAdminReports = () => {
  if (env?.nodeEnv === 'production') return false;
  const flag = (process.env.PEPPRO_FAKE_ADMIN_REPORTS || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  return true;
};

const WEB_DEV_COMMISSION_RATE = 0.03;

const getDevCommissionUsers = async () => {
  if (mysqlClient.isEnabled()) {
    try {
      const column = await mysqlClient.fetchOne(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'users'
            AND COLUMN_NAME = 'dev_commission'
          LIMIT 1
        `,
      );
      if (!column) {
        return [];
      }
      const rows = await mysqlClient.fetchAll(
        `
          SELECT id, name, email, role, dev_commission
          FROM users
          WHERE COALESCE(dev_commission, 0) = 1
        `,
      );
      return (rows || [])
        .map((row) => ({
          id: String(row?.id || '').trim(),
          name: row?.name || null,
          email: row?.email || null,
          role: row?.role || null,
          devCommission: normalizeBooleanFlag(row?.dev_commission),
        }))
        .filter((row) => row.id && row.devCommission);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load dev commission users from MySQL');
    }
  }
  const users = Array.isArray(userRepository.getAll()) ? userRepository.getAll() : [];
  return users
    .filter((user) => normalizeBooleanFlag(user?.devCommission))
    .map((user) => ({
      id: String(user?.id || '').trim(),
      name: user?.name || null,
      email: user?.email || null,
      role: user?.role || null,
      devCommission: true,
    }))
    .filter((row) => row.id);
};

const buildFakeProductsCommissionReport = async ({ periodStart, periodEnd }) => {
  const safeDate = (value) => {
    if (!value) return null;
    const parsed = new Date(value);
    // Accept YYYY-MM-DD and ISO-ish; reject invalid.
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  };

  const from = safeDate(periodStart);
  const to = safeDate(periodEnd);

  const productsCatalog = [
    { name: 'BPC-157 / TB-500 N — 10mg', sku: 'BPC157-TB500-10', productId: 211, basePrice: 126.82 },
    { name: 'Semaglutide — 5mg', sku: 'SEMA-5', productId: 310, basePrice: 149.0 },
    { name: 'Tirzepatide — 10mg', sku: 'TIRZ-10', productId: 318, basePrice: 229.0 },
    { name: 'NAD+ — 500mg', sku: 'NAD-500', productId: 402, basePrice: 189.0 },
    { name: 'CJC-1295 DAC — 2mg', sku: 'CJC-DAC-2', productId: 512, basePrice: 89.0 },
    { name: 'Ipamorelin — 5mg', sku: 'IPA-5', productId: 517, basePrice: 79.0 },
    { name: 'Testosterone Cypionate — 200mg/mL', sku: 'TEST-C-200', productId: 601, basePrice: 59.0 },
    { name: 'HCG — 5000 IU', sku: 'HCG-5000', productId: 707, basePrice: 79.0 },
    { name: 'Glutathione — 200mg', sku: 'GLUT-200', productId: 808, basePrice: 69.0 },
    { name: 'L-Carnitine — 500mg/mL', sku: 'LCAR-500', productId: 901, basePrice: 49.0 },
  ];

  const seedSource = `${from || 'all'}|${to || 'all'}`;
  let seed = 0;
  for (let i = 0; i < seedSource.length; i += 1) {
    seed = (seed * 31 + seedSource.charCodeAt(i)) >>> 0;
  }
  const rand = () => {
    // LCG: deterministic but "random enough" for UI testing.
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const products = productsCatalog.map((product, idx) => {
    const quantity = 2 + Math.floor(rand() * 22) + (idx % 3);
    return {
      key: product.sku,
      sku: product.sku,
      productId: product.productId,
      variationId: null,
      name: product.name,
      quantity,
    };
  });

  const makePerson = (id, name, role) => ({
    id: String(id),
    name,
    role,
  });

  const recipients = [
    makePerson('1001', 'Lead: Alexis Harper', 'sales_lead'),
    makePerson('1002', 'Rep: Jordan Kim', 'sales_rep'),
    makePerson('1003', 'Rep: Taylor Reed', 'sales_rep'),
    makePerson('admin', 'Admin', 'admin'),
  ];
  const devUsers = await getDevCommissionUsers();
  const recipientsById = new Map();
  recipients.forEach((recipient) => {
    recipientsById.set(String(recipient.id), {
      ...recipient,
      devCommission: false,
    });
  });
  devUsers.forEach((user) => {
    const id = String(user.id || '').trim();
    if (!id) return;
    const existing = recipientsById.get(id);
    if (existing) {
      recipientsById.set(id, {
        ...existing,
        name: existing.name || user.name || user.email || existing.id,
        role: existing.role || normalizeRole(user.role) || 'admin',
        devCommission: true,
      });
      return;
    }
    recipientsById.set(id, {
      id,
      name: user.name || user.email || `User ${id}`,
      role: normalizeRole(user.role) || 'admin',
      devCommission: true,
    });
  });
  const mergedRecipients = Array.from(recipientsById.values());

  const wholesaleBase = products.reduce((sum, p, idx) => {
    const price = Number(productsCatalog[idx]?.basePrice || 0);
    return sum + price * p.quantity * 0.55;
  }, 0);
  const retailBase = products.reduce((sum, p, idx) => {
    const price = Number(productsCatalog[idx]?.basePrice || 0);
    return sum + price * p.quantity * 0.85;
  }, 0);

  const commissionableBase = wholesaleBase + retailBase;
  const commissionRows = mergedRecipients.map((recipient, idx) => {
    const retailShare = 0.12 + idx * 0.03;
    const wholesaleShare = 0.09 + idx * 0.02;
    const retailBasePart = retailBase * retailShare;
    const wholesaleBasePart = wholesaleBase * wholesaleShare;
    const retailOrders = Math.max(0, Math.round(6 + rand() * 10 - idx));
    const wholesaleOrders = Math.max(0, Math.round(4 + rand() * 8 - idx));
    const baseAmount = retailBasePart * 0.2 + wholesaleBasePart * 0.1;
    const webDevBonus = recipient.devCommission
      ? Math.round(commissionableBase * WEB_DEV_COMMISSION_RATE * 100) / 100
      : 0;
    const amount = baseAmount + webDevBonus;
    return {
      id: recipient.id,
      name: recipient.name,
      role: recipient.role,
      amount: Math.round(amount * 100) / 100,
      retailOrders,
      wholesaleOrders,
      retailBase: Math.round(retailBasePart * 100) / 100,
      wholesaleBase: Math.round(wholesaleBasePart * 100) / 100,
      houseRetailOrders: 0,
      houseWholesaleOrders: 0,
      houseRetailBase: 0,
      houseWholesaleBase: 0,
      houseRetailCommission: 0,
      houseWholesaleCommission: 0,
      specialAdminBonus: webDevBonus,
      specialAdminBonusRate: recipient.devCommission ? WEB_DEV_COMMISSION_RATE : 0,
      specialAdminBonusMonthlyCap: 0,
      specialAdminBonusByMonth: recipient.devCommission
        ? { all_time: webDevBonus }
        : undefined,
      specialAdminBonusBaseByMonth: recipient.devCommission
        ? { all_time: Math.round(commissionableBase * 100) / 100 }
        : undefined,
    };
  });

  const commissionTotal = commissionRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return {
    periodStart: from,
    periodEnd: to,
    products,
    commissions: commissionRows,
    totals: {
      commissionableBase: Math.round(commissionableBase * 100) / 100,
      commissionTotal: Math.round(commissionTotal * 100) / 100,
    },
    fake: true,
  };
};

const extractWpoAccessKey = (wooOrder) => {
  const metaData = Array.isArray(wooOrder?.meta_data) ? wooOrder.meta_data : [];
  if (metaData.length === 0) {
    return null;
  }

  const unwrap = (value) => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      return text.length > 0 ? text : null;
    }
    if (typeof value === 'object') {
      const invoiceValue = value?.invoice ?? value?.Invoice ?? null;
      if (typeof invoiceValue === 'string' || typeof invoiceValue === 'number') {
        const text = String(invoiceValue).trim();
        return text.length > 0 ? text : null;
      }
      const accessValue = value?.access_key ?? value?.accessKey ?? null;
      if (typeof accessValue === 'string' || typeof accessValue === 'number') {
        const text = String(accessValue).trim();
        return text.length > 0 ? text : null;
      }
    }
    return null;
  };

  const findByKey = (key) => {
    const match = metaData.find((entry) => String(entry?.key || '') === key);
    return unwrap(match?.value);
  };

  const directKeys = [
    '_wcpdf_invoice_access_key',
    'wcpdf_invoice_access_key',
    '_wpo_wcpdf_invoice_access_key',
    'wpo_wcpdf_invoice_access_key',
    '_wpo_wcpdf_access_key',
    'wpo_wcpdf_access_key',
    '_wcpdf_access_key',
    'wcpdf_access_key',
    'wpo_wcpdf_document_access_key',
    '_wpo_wcpdf_document_access_key',
  ];

  for (const key of directKeys) {
    const value = findByKey(key);
    if (value) return value;
  }

  for (const entry of metaData) {
    const key = String(entry?.key || '');
    if (!key) continue;
    const normalized = key.toLowerCase();
    if (!(normalized.includes('wcpdf') || normalized.includes('wpo'))) continue;
    if (!normalized.includes('access')) continue;
    const value = unwrap(entry?.value);
    if (value) return value;
  }

  return null;
};

const buildWpoInvoiceUrl = ({ storeUrl, orderId, accessKey, documentType = 'invoice' }) => {
  const base = storeUrl ? String(storeUrl).replace(/\/+$/, '') : '';
  if (!base || !orderId) return null;
  const params = new URLSearchParams();
  params.set('action', 'generate_wpo_wcpdf');
  params.set('document_type', String(documentType || 'invoice'));
  params.set('order_ids', String(orderId).trim());
  if (accessKey) {
    params.set('access_key', String(accessKey).trim());
  }
  params.set('shortcode', 'true');
  return `${base}/wp-admin/admin-ajax.php?${params.toString()}`;
};

const createOrder = async (req, res, next) => {
  try {
    const idempotencyKey = typeof req.get === 'function'
      ? (req.get('idempotency-key') || '').trim()
      : '';
    const result = await orderService.createOrder({
      userId: req.user.id,
      idempotencyKey: idempotencyKey || null,
      items: req.body.items,
      total: req.body.total,
      shippingAddress: req.body.shippingAddress,
      shippingEstimate: req.body.shippingEstimate,
      shippingTotal: req.body.shippingTotal,
      referralCode: req.body.referralCode,
      physicianCertification: req.body.physicianCertification === true,
      taxTotal: req.body.taxTotal,
      paymentMethod: req.body.paymentMethod,
      pricingMode: req.body.pricingMode,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const getOrders = async (req, res, next) => {
  try {
    const orders = await orderService.getOrdersForUser(req.user.id);
    const sample = Array.isArray(orders?.woo) && orders.woo.length > 0 ? orders.woo[0] : null;
    logger.info(
      {
        userId: req.user.id,
        wooCount: Array.isArray(orders?.woo) ? orders.woo.length : 0,
        sampleOrderId: sample?.id || sample?.number || null,
        sampleTracking:
          sample?.trackingNumber
          || sample?.integrationDetails?.shipStation?.trackingNumber
          || null,
        sampleShipStationStatus: sample?.integrationDetails?.shipStation?.status || null,
      },
      'API /orders response snapshot',
    );
    res.json(orders);
  } catch (error) {
    next(error);
  }
};

const getOrdersForSalesRep = async (req, res, next) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    if (role !== 'sales_rep' && role !== 'rep' && role !== 'admin') {
      return res.status(403).json({ error: 'Sales rep access required' });
    }
    const scope = role === 'admin' && (req.query.scope || '').toLowerCase() === 'all' ? 'all' : 'mine';
    const querySalesRepId = typeof req.query?.salesRepId === 'string' ? req.query.salesRepId.trim() : '';
    const hasExplicitSalesRepId = Boolean(querySalesRepId);
    const requestedSalesRepId =
      role === 'admin' && scope === 'all' && !hasExplicitSalesRepId
        ? null
        : (querySalesRepId || req.user?.salesRepId || req.user.id);
    const response = await orderService.getOrdersForSalesRep(requestedSalesRepId, {
      includeDoctors: true,
      includeSelfOrders: role === 'admin',
      includeAllDoctors: scope === 'all',
      alternateSalesRepIds:
        requestedSalesRepId && req.user?.id && requestedSalesRepId !== req.user.id ? [req.user.id] : [],
    });
    const sample = Array.isArray(response?.orders) && response.orders.length > 0 ? response.orders[0] : null;
    logger.info(
      {
        salesRepId: requestedSalesRepId,
        scope,
        orderCount: Array.isArray(response?.orders) ? response.orders.length : 0,
        sampleOrderId: sample?.id || sample?.number || null,
        sampleTracking:
          sample?.trackingNumber
          || sample?.integrationDetails?.shipStation?.trackingNumber
          || null,
        sampleShipStationStatus: sample?.integrationDetails?.shipStation?.status || null,
      },
      'API /orders/sales-rep response snapshot',
    );
    res.json(response);
  } catch (error) {
    next(error);
  }
};

const getSalesRepOrderDetail = async (req, res, next) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (role !== 'sales_rep' && role !== 'rep' && role !== 'sales_lead' && role !== 'saleslead' && role !== 'admin') {
      return res.status(403).json({ error: 'Sales rep access required' });
    }
    const { orderId } = req.params;
    const doctorEmail = typeof req.query?.doctorEmail === 'string' ? req.query.doctorEmail : null;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }
    const detail = await orderService.getWooOrderDetail({ orderId, doctorEmail });
    if (!detail) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(detail);
  } catch (error) {
    next(error);
  }
};

const cancelOrder = async (req, res, next) => {
  try {
    const result = await orderService.cancelOrder({
      userId: req.user.id,
      orderId: req.params.orderId,
      reason: typeof req.body?.reason === 'string' ? req.body.reason.trim() : '',
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const syncShipStationToWoo = async (req, res, next) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const orderNumber = normalizeOrderToken(req.body?.orderNumber || req.body?.wooOrderNumber || '');
    const wooOrderId = normalizeOrderToken(req.body?.wooOrderId || req.body?.woo_order_id || '');
    const shipStationOrderId = normalizeOrderToken(req.body?.shipStationOrderId || req.body?.shipstation_order_id || '');

    const resolvedOrderNumber = orderNumber || wooOrderId || null;
    if (!resolvedOrderNumber && !shipStationOrderId) {
      return res.status(400).json({ error: 'orderNumber, wooOrderId, or shipStationOrderId is required' });
    }

    const result = await syncWooFromShipStation({
      orderNumber: resolvedOrderNumber,
      shipStationOrderId: shipStationOrderId || null,
    });

    return res.json({ success: true, result });
  } catch (error) {
    return next(error);
  }
};

const runShipStationStatusSyncNow = async (req, res, next) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await runShipStationStatusSyncOnce();
    return res.json({ success: true, result, state: getShipStationStatusSyncState() });
  } catch (error) {
    return next(error);
  }
};

const getShipStationStatusSyncInfo = async (req, res, next) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return res.json({ success: true, state: getShipStationStatusSyncState() });
  } catch (error) {
    return next(error);
  }
};

const estimateOrderTotals = async (req, res, next) => {
  try {
    const result = await orderService.estimateOrderTotals({
      userId: req.user.id,
      items: req.body.items,
      shippingAddress: req.body.shippingAddress,
      shippingEstimate: req.body.shippingEstimate,
      shippingTotal: req.body.shippingTotal,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const getSalesByRepForAdmin = async (req, res, next) => {
  try {
    const role = normalizeRole(req.user?.role);
    const isSalesLeadRole = role === 'sales_lead' || role === 'saleslead' || role === 'sales-lead';
    if (role !== 'admin' && !isSalesLeadRole) {
      return res.status(403).json({ error: 'Admin or Sales Lead access required' });
    }
    const periodStart = typeof req.query?.periodStart === 'string' ? req.query.periodStart.trim() : null;
    const periodEnd = typeof req.query?.periodEnd === 'string' ? req.query.periodEnd.trim() : null;
    const debugRaw = typeof req.query?.debug === 'string' ? req.query.debug.trim().toLowerCase() : '';
    const debug = debugRaw === '1' || debugRaw === 'true' || debugRaw === 'yes' || debugRaw === 'on';
    const summary = await orderService.getSalesByRep({
      excludeSalesRepId: role === 'admin' ? req.user.id : null,
      excludeDoctorIds: role === 'admin' ? [String(req.user.id)] : [],
      periodStart,
      periodEnd,
      timeZone: 'America/Los_Angeles',
      debug,
    });
    res.json(summary);
  } catch (error) {
    next(error);
  }
};

const getProductSalesCommissionForAdmin = async (req, res, next) => {
  try {
    if (!shouldServeFakeAdminReports()) {
      return res.status(501).json({ error: 'Report not available on this backend' });
    }
    const periodStart = typeof req.query?.periodStart === 'string' ? req.query.periodStart.trim() : null;
    const periodEnd = typeof req.query?.periodEnd === 'string' ? req.query.periodEnd.trim() : null;
    const payload = await buildFakeProductsCommissionReport({ periodStart, periodEnd });
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
};

const downloadInvoice = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const token = normalizeOrderToken(orderId);
    if (!token) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const role = normalizeRole(req.user?.role);
    const userEmail = normalizeEmail(req.user?.email);
    const isAdminLike = role === 'admin' || role === 'sales_rep' || role === 'rep';

    if (!wooCommerceClient?.fetchOrderById || !wooCommerceClient?.fetchOrdersByEmail) {
      return res.status(503).json({ error: 'Invoice service unavailable' });
    }

    const fetchWooOrder = async (id) => {
      try {
        return await wooCommerceClient.fetchOrderById(id, { context: 'edit' });
      } catch (error) {
        return await wooCommerceClient.fetchOrderById(id);
      }
    };

    let wooOrder = null;
    try {
      wooOrder = await fetchWooOrder(token);
    } catch (error) {
      wooOrder = null;
    }

    if (!wooOrder && userEmail) {
      try {
        const candidates = await wooCommerceClient.fetchOrdersByEmail(userEmail, { perPage: 50 });
        const list = Array.isArray(candidates) ? candidates : [];
        const match = list.find((entry) => {
          const idMatch = normalizeOrderToken(entry?.wooOrderId || entry?.id) === token;
          const numberMatch = normalizeOrderToken(entry?.wooOrderNumber || entry?.number) === token;
          return idMatch || numberMatch;
        });
        const resolvedWooId = match?.wooOrderId || match?.id || null;
        if (resolvedWooId) {
          wooOrder = await fetchWooOrder(String(resolvedWooId));
        }
      } catch (error) {
        logger.warn({ err: error, orderId: token }, 'Invoice order lookup fallback failed');
      }
    }

    if (!wooOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const billingEmail = normalizeEmail(wooOrder?.billing?.email);
    if (!isAdminLike) {
      if (!userEmail || !billingEmail || userEmail !== billingEmail) {
        return res.status(404).json({ error: 'Order not found' });
      }
    }

    const accessKey = extractWpoAccessKey(wooOrder);
    const wpoUrl = buildWpoInvoiceUrl({
      storeUrl: env.wooCommerce?.storeUrl,
      orderId: wooOrder?.id,
      accessKey,
    });

    if (!wpoUrl || !accessKey) {
      const { pdf, filename } = buildInvoicePdf(wooOrder, { orderToken: token });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-PepPro-Invoice-Source', 'fallback');
      return res.status(200).send(pdf);
    }

    const response = await axios.get(wpoUrl, {
      responseType: 'arraybuffer',
      timeout: 25000,
      maxRedirects: 5,
      headers: {
        Accept: 'application/pdf',
        'User-Agent': 'PepPro Invoice Proxy',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const buffer = Buffer.from(response.data || []);
    if (buffer.length < 5 || buffer.slice(0, 4).toString('ascii') !== '%PDF') {
      const preview = buffer.slice(0, 180).toString('utf8');
      const previewLower = preview.toLowerCase();
      const permissionLike = previewLower.includes('sufficient permissions') || previewLower.includes('permission');
      logger.warn(
        {
          orderId: token,
          status: response.status,
          contentType: response.headers?.['content-type'],
          hasAccessKey: Boolean(accessKey),
          preview: preview.length > 0 ? preview.slice(0, 160) : null,
        },
        'WP Overnight invoice response did not look like a PDF',
      );
      const { pdf, filename } = buildInvoicePdf(wooOrder, { orderToken: token });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-PepPro-Invoice-Source', permissionLike ? 'fallback-permission' : 'fallback');
      return res.status(200).send(pdf);
    }

    const filename = `PepPro_Invoice_${normalizeOrderToken(wooOrder?.number || wooOrder?.id || token)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-PepPro-Invoice-Source', 'wpo');
    return res.status(200).send(buffer);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrdersForSalesRep,
  getSalesRepOrderDetail,
  getSalesByRepForAdmin,
  getProductSalesCommissionForAdmin,
  cancelOrder,
  syncShipStationToWoo,
  runShipStationStatusSyncNow,
  getShipStationStatusSyncInfo,
  estimateOrderTotals,
  downloadInvoice,
};
