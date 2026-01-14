const { Router } = require('express');
const { env } = require('../config/env');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const peptideForumController = require('../controllers/peptideForumController');

const router = Router();

const resolvePeptideForumWebhookSecret = () =>
  env.googleSheets?.peptideForumWebhookSecret
  || env.googleSheets?.webhookSecret
  || '';

router.post(
  '/the-peptide-forum',
  requireWebhookSecret(resolvePeptideForumWebhookSecret),
  peptideForumController.ingestWebhook,
);

module.exports = router;
