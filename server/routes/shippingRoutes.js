const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const shippingController = require('../controllers/shippingController');

const router = Router();

router.post('/rates', authenticate, shippingController.getRates);

module.exports = router;
