const { logger } = require('../config/logger');
const orderService = require('../services/orderService');

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
    const requestedSalesRepId = req.query.salesRepId || req.user?.salesRepId || req.user.id;
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
    const summary = await orderService.getSalesByRep({
      excludeSalesRepId: req.user.id,
      excludeDoctorIds: [String(req.user.id)],
    });
    res.json(summary);
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
  estimateOrderTotals,
};
