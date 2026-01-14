const { peptideForumStore } = require('../storage');

const normalizeText = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
};

const normalizeOptionalText = (value) => {
  const text = normalizeText(value);
  return text ? text : null;
};

const tryParseDate = (value) => {
  const raw = normalizeText(value);
  if (!raw) return { iso: null, raw: null };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { iso: null, raw };
  }
  return { iso: date.toISOString(), raw };
};

const isLikelyUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const normalizeItem = (item, index) => {
  const title = normalizeText(item?.title);
  const description = normalizeOptionalText(item?.description);
  const link = normalizeText(item?.link);
  const { iso: dateIso, raw: dateRaw } = tryParseDate(item?.date);

  if (!title && !link) {
    return { ok: false, error: `Row ${index}: missing title and link` };
  }
  if (link && !isLikelyUrl(link)) {
    return { ok: false, error: `Row ${index}: invalid link` };
  }

  const idBase = `${title || 'class'}|${dateIso || dateRaw || 'nodate'}|${link || 'nolink'}`;
  const id = Buffer.from(idBase).toString('base64url').slice(0, 48);

  return {
    ok: true,
    value: {
      id,
      title: title || (link ? 'The Peptide Forum' : 'Untitled'),
      date: dateIso || dateRaw || null,
      description,
      link: link || null,
    },
  };
};

const list = () => {
  const payload = peptideForumStore.read();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const updatedAt = typeof payload?.updatedAt === 'string' ? payload.updatedAt : null;
  return { updatedAt, items };
};

const replaceFromWebhook = (incoming) => {
  const rows = Array.isArray(incoming) ? incoming : [];
  const errors = [];
  const items = [];

  rows.forEach((row, idx) => {
    const normalized = normalizeItem(row, idx);
    if (!normalized.ok) {
      errors.push(normalized.error);
      return;
    }
    items.push(normalized.value);
  });

  const next = {
    updatedAt: new Date().toISOString(),
    items,
  };
  peptideForumStore.write(next);

  return {
    updatedAt: next.updatedAt,
    stored: items.length,
    received: rows.length,
    errors,
  };
};

module.exports = {
  list,
  replaceFromWebhook,
};
