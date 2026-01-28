const { Router } = require('express');
const shippingController = require('../controllers/shippingController');

const router = Router();

router.post('/rates', shippingController.getRates);

module.exports = router;
