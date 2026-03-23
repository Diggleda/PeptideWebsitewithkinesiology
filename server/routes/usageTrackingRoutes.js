const { Router } = require('express');

const router = Router();

router.get('/funnel', (req, res) => {
  const events = String(req.query?.events || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const counts = Object.fromEntries(events.map((event) => [event, 0]));
  res.json({ events, counts, tracked: false });
});

router.post('/', (req, res) => {
  const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
  res.status(201).json({ ok: true, tracked: false, event });
});

module.exports = router;
