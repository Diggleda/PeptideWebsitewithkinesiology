const { Router } = require('express');
const orderController = require('../controllers/orderController');
const { authenticate } = require('../middleware/authenticate');

const router = Router();

router.post('/', authenticate, orderController.createOrder);
router.get('/', authenticate, orderController.getOrders);

module.exports = router;
