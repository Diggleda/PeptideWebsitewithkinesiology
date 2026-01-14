const stripAuthPrefix = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.replace(/^(?:Bearer|Basic)\s+/i, '').trim();
};

const extractWebhookToken = (req) => {
  const authHeader = req.headers?.authorization;
  const sigHeader = req.headers?.['x-webhook-signature'];
  const provided = stripAuthPrefix(typeof authHeader === 'string' ? authHeader : '')
    || stripAuthPrefix(typeof sigHeader === 'string' ? sigHeader : '');
  return provided;
};

const requireWebhookSecret = (resolveSecret) => (req, res, next) => {
  const provided = extractWebhookToken(req);
  const secret =
    typeof resolveSecret === 'function'
      ? resolveSecret(req)
      : typeof resolveSecret === 'string'
        ? resolveSecret
        : '';

  if (!secret) {
    res.status(500).json({ error: 'Webhook secret is not configured' });
    return;
  }

  if (!provided || provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};

module.exports = {
  requireWebhookSecret,
};

