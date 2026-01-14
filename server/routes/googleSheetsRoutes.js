const { Router } = require('express');
const { env } = require('../config/env');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const peptides101ClassesController = require('../controllers/peptides101ClassesController');

const router = Router();

const resolveClassesWebhookSecret = () =>
  env.googleSheets?.classesWebhookSecret
  || env.googleSheets?.webhookSecret
  || '';

router.post(
  '/peptides-101-classes',
  requireWebhookSecret(resolveClassesWebhookSecret),
  peptides101ClassesController.ingestWebhook,
);

module.exports = router;

