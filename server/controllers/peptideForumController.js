const peptideForumService = require('../services/peptideForumService');

const list = (_req, res) => {
  const payload = peptideForumService.list();
  res.json({ ok: true, ...payload });
};

const ingestWebhook = async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const incoming = Array.isArray(body?.items) ? body.items : (Array.isArray(body?.posts) ? body.posts : null);
  if (!incoming) {
    res.status(422).json({ error: 'Missing items array' });
    return;
  }

  try {
    const result = await peptideForumService.replaceFromWebhook(incoming);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  list,
  ingestWebhook,
};
