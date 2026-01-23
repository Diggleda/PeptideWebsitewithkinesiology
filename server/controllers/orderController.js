const { logger } = require('../config/logger');
const orderService = require('../services/orderService');
const wooCommerceClient = require('../integration/wooCommerceClient');
const axios = require('axios');
const { env } = require('../config/env');
const { buildInvoicePdf } = require('../services/invoicePdf');
const { syncWooFromShipStation } = require('../services/shipStationSyncService');

const normalizeRole = (role) => (role || '').toString().trim().toLowerCase();
const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : '');
const normalizeOrderToken = (value) => String(value || '').trim().replace(/^#/, '');

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
    const role = (req.user?.role || '').toLowerCase();
    if (role !== 'sales_rep' && role !== 'rep' && role !== 'admin') {
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
    const role = (req.user?.role || '').toLowerCase();
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const periodStart = typeof req.query?.periodStart === 'string' ? req.query.periodStart.trim() : null;
    const periodEnd = typeof req.query?.periodEnd === 'string' ? req.query.periodEnd.trim() : null;
    const summary = await orderService.getSalesByRep({
      excludeSalesRepId: req.user.id,
      excludeDoctorIds: [String(req.user.id)],
      periodStart,
      periodEnd,
      timeZone: 'America/Los_Angeles',
    });
    res.json(summary);
  } catch (error) {
    next(error);
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
  cancelOrder,
  syncShipStationToWoo,
  estimateOrderTotals,
  downloadInvoice,
};
