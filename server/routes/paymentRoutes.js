const express = require('express');
const paymentController = require('../controllers/paymentController');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();

router.post('/intent', authenticate, paymentController.createIntent);
router.post('/stripe/confirm', authenticate, paymentController.confirmIntent);

module.exports = {
  router,
  handleStripeWebhook: paymentController.handleStripeWebhook,
};
