const peptides101ClassesService = require('../services/peptides101ClassesService');

const list = (_req, res) => {
  const payload = peptides101ClassesService.list();
  res.json({ ok: true, ...payload });
};

const ingestWebhook = (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const incoming = Array.isArray(body?.classes) ? body.classes : null;
  if (!incoming) {
    res.status(422).json({ error: 'Missing classes array' });
    return;
  }

  const result = peptides101ClassesService.replaceFromWebhook(incoming);
  res.json({ ok: true, ...result });
};

module.exports = {
  list,
  ingestWebhook,
};

