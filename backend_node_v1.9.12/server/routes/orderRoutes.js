const { Router } = require('express');
const orderController = require('../controllers/orderController');
const { authenticate } = require('../middleware/authenticate');

const router = Router();

router.post('/estimate', authenticate, orderController.estimateOrderTotals);
router.post('/', authenticate, orderController.createOrder);
router.get('/', authenticate, orderController.getOrders);
router.get('/sales-rep', authenticate, orderController.getOrdersForSalesRep);
router.get('/sales-rep/:orderId', authenticate, orderController.getSalesRepOrderDetail);
router.get('/sales-rep-summary', authenticate, orderController.getSalesByRepForAdmin);
router.get('/admin/sales-rep-summary', authenticate, orderController.getSalesByRepForAdmin);
router.post('/:orderId/cancel', authenticate, orderController.cancelOrder);

module.exports = router;
