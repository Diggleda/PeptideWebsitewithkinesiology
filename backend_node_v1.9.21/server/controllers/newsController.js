const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { getPeptideNews } = require('../services/newsService');

const readJsonIfExists = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
};

const normalizeItem = (raw) => {
  const title = (raw && typeof raw.title === 'string' ? raw.title : '').trim();
  const url = (raw && typeof raw.url === 'string' ? raw.url : '').trim();
  const summary = (raw && typeof raw.summary === 'string' ? raw.summary : '').trim();
  const imageUrl = (raw && typeof raw.imageUrl === 'string' ? raw.imageUrl : '').trim();
  const date = (raw && typeof raw.date === 'string' ? raw.date : '').trim();
  return { title, url, summary, imageUrl, date };
};

const getPeptides = async (_req, res, _next) => {
  try {
    const items = await getPeptideNews({ limit: 24 });
    if (Array.isArray(items) && items.length > 0) {
      return res.json({ items: items.map(normalizeItem), count: items.length });
    }
  } catch (_) {
    // fall through to local file
  }
  // Fallback to simple local content file under data dir for easy editing.
  const newsDir = path.join(env.dataDir, 'news');
  const filePath = path.join(newsDir, 'peptides.json');
  const data = readJsonIfExists(filePath);
  const items = Array.isArray(data?.items) ? data.items.map(normalizeItem).filter((i) => i.title && i.url) : [];
  return res.json({ items, count: items.length });
};

module.exports = {
  getPeptides,
};
