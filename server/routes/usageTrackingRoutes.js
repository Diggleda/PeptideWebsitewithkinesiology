const { Router } = require('express');

const router = Router();
const demoCountsByEvent = {
  delegate_link_tab_clicked: 148,
  delegate_link_text_field_entry: 121,
  delegate_link_create_started: 96,
  brochure_link_button_clicked: 27,
  delegate_link_created: 84,
  delegate_link_copied: 72,
  delegate_link_preview_opened: 55,
  delegate_link_opened: 48,
  delegate_order_estimated: 38,
  delegate_proposal_shared: 34,
  delegate_proposal_review_clicked: 49,
  delegate_proposal_review_loaded: 43,
  delegate_proposal_reviewed: 31,
  delegate_order_placed: 18,
};

router.get('/funnel', (req, res) => {
  const events = String(req.query?.events || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const actorKey = String(req.query?.actorKey || '').trim() || null;

  const counts = Object.fromEntries(
    events.map((event) => [event, demoCountsByEvent[event] ?? 0]),
  );
  res.json({ events, counts, actors: [], filteredActorKey: actorKey, tracked: false });
});

router.post('/', (req, res) => {
  const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
  res.status(201).json({ ok: true, tracked: false, event });
});

module.exports = router;
