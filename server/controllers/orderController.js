const orderService = require('../services/orderService');

const createOrder = async (req, res, next) => {
  try {
    const result = await orderService.createOrder({
      userId: req.user.id,
      items: req.body.items,
      total: req.body.total,
      referralCode: req.body.referralCode,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const getOrders = async (req, res, next) => {
  try {
    const orders = await orderService.getOrdersForUser(req.user.id);
    res.json(orders);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createOrder,
  getOrders,
};
