const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const { fetchUpsTrackingStatus, sanitizeTrackingNumber } = require('../services/upsTrackingService');

const router = Router();

router.get('/status/:trackingNumber', authenticate, async (req, res) => {
  const normalized = sanitizeTrackingNumber(req.params.trackingNumber);
  if (!normalized) {
    return res.status(400).json({ error: 'trackingNumber is required' });
  }

  const carrier = String(req.query.carrier || '').trim().toLowerCase();
  if (carrier && carrier !== 'ups') {
    return res.status(400).json({ error: 'Unsupported carrier' });
  }

  const effectiveCarrier = carrier === 'ups' || normalized.startsWith('1Z') ? 'ups' : null;
  if (effectiveCarrier !== 'ups') {
    return res.json({
      trackingNumber: normalized,
      carrier: null,
      trackingStatus: null,
      trackingStatusRaw: null,
      checkedAt: null,
    });
  }

  const info = await fetchUpsTrackingStatus(normalized);
  return res.json(info || {
    carrier: 'ups',
    trackingNumber: normalized,
    trackingStatus: null,
    trackingStatusRaw: null,
    checkedAt: new Date().toISOString(),
  });
});

module.exports = router;

