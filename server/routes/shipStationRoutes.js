const { Router } = require('express');
const bodyParser = require('body-parser');
const { env } = require('../config/env');
const shipStationController = require('../controllers/shipStationController');

const router = Router();

const stripAuthPrefix = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.replace(/^(?:Bearer|Basic)\s+/i, '').trim();
};

const extractProvidedSecret = (req) => {
  const authHeader = req.headers?.authorization;
  const sigHeader = req.headers?.['x-webhook-signature'];
  const tokenHeader = req.headers?.['x-shipstation-webhook-secret'];
  const queryToken = req.query?.token || req.query?.secret || req.query?.signature;

  const fromHeaders = stripAuthPrefix(typeof authHeader === 'string' ? authHeader : '')
    || stripAuthPrefix(typeof sigHeader === 'string' ? sigHeader : '')
    || stripAuthPrefix(typeof tokenHeader === 'string' ? tokenHeader : '');

  if (fromHeaders) return fromHeaders;
  if (typeof queryToken === 'string') return queryToken.trim();
  if (Array.isArray(queryToken) && typeof queryToken[0] === 'string') return queryToken[0].trim();
  return '';
};

const requireShipStationWebhookSecret = (req, res, next) => {
  const secret = typeof env.shipStation?.webhookSecret === 'string' ? env.shipStation.webhookSecret.trim() : '';
  if (!secret) {
    return res.status(500).json({ error: 'ShipStation webhook secret is not configured' });
  }

  const provided = extractProvidedSecret(req);
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
};

// ShipStation can POST XML (legacy "ShipNotify") or JSON (webhooks). JSON is parsed by the app-level
// bodyParser.json middleware; this ensures XML/text bodies are captured for parsing.
router.use(bodyParser.text({
  type: ['text/*', 'application/xml', 'text/xml', 'application/*+xml'],
  limit: env.bodyParser?.limit || '50mb',
}));

router.post('/webhook', requireShipStationWebhookSecret, shipStationController.webhook);
// Alias for legacy ShipStation "ShipNotify" callbacks.
router.post('/shipnotify', requireShipStationWebhookSecret, shipStationController.webhook);

module.exports = router;
