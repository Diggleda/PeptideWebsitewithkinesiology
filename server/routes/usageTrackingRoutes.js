const { Router } = require('express');

const router = Router();
const demoCountsByEvent = {
  delegate_link_tab_clicked: 148,
  delegate_link_text_field_entry: 121,
  delegate_link_created: 84,
  delegate_proposal_review_clicked: 49,
  delegate_proposal_reviewed: 31,
  delegate_order_placed: 18,
};

router.get('/funnel', (req, res) => {
  const events = String(req.query?.events || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const counts = Object.fromEntries(
    events.map((event) => [event, demoCountsByEvent[event] ?? 0]),
  );
  res.json({ events, counts, tracked: false });
});

router.post('/', (req, res) => {
  const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
  res.status(201).json({ ok: true, tracked: false, event });
});

module.exports = router;
