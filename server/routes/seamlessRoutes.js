const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const { env } = require('../config/env');
const seamlessController = require('../controllers/seamlessController');

const router = Router();

const resolveSeamlessWebhookSecret = () => env.seamless?.webhookSecret || '';

router.post(
  '/webhook',
  requireWebhookSecret(resolveSeamlessWebhookSecret),
  seamlessController.ingestWebhook,
);
router.post('/sync/backfill', authenticate, seamlessController.runBackfill);
router.get('/health', authenticate, seamlessController.getHealth);
router.get('/raw', authenticate, seamlessController.getRawPayloads);

module.exports = router;
