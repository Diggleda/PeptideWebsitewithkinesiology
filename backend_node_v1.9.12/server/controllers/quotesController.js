const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const ensureDataDir = () => {
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
  } catch (_) {}
  return env.dataDir;
};

const cacheFilePath = () => path.join(ensureDataDir(), 'daily-quote.json');

const normalize = (q) => {
  const text = q && typeof q.text === 'string' ? q.text.trim() : '';
  const author = q && typeof q.author === 'string' ? q.author.trim() : '';
  const id = q && Number.isInteger(q.id) ? q.id : `${text}::${author}`;
  return { id, text, author };
};

const pickRandom = (items, avoidId = null) => {
  const pool = Array.isArray(items) ? items.slice() : [];
  if (pool.length === 0) return null;
  if (avoidId != null && pool.length > 1) {
    const filtered = pool.filter((q) => (q?.id ?? null) !== avoidId);
    if (filtered.length > 0) return filtered[Math.floor(Math.random() * filtered.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
};

exports.getDaily = async (_req, res, next) => {
  try {
    const url = env.quotes.sourceUrl;
    const secret = env.quotes.secret || '';
    const headers = secret ? { Authorization: `Bearer ${secret}` } : {};

    const { data } = await axios.get(url, { headers, timeout: 8000 });
    const rawList = Array.isArray(data?.quotes) ? data.quotes : [];
    const list = rawList.map(normalize).filter((q) => q.text);

    if (list.length === 0) {
      return res.status(200).json({ text: 'Excellence is an attitude.', author: 'PepPro' });
    }

    // Read cache
    let cached = null;
    const p = cacheFilePath();
    try {
      const content = fs.readFileSync(p, 'utf8');
      cached = JSON.parse(content);
    } catch (_) {}

    const key = todayKey();
    if (cached && cached.date === key) {
      const found = list.find((q) => String(q.id) === String(cached.id));
      if (found) return res.status(200).json({ text: found.text, author: found.author });
    }

    // Pick a random quote, avoid yesterday's id when possible
    const yesterdayId = cached && cached.date !== key ? cached.id : null;
    const pick = pickRandom(list, yesterdayId);
    const toStore = { date: key, id: pick.id };
    try { fs.writeFileSync(p, JSON.stringify(toStore), 'utf8'); } catch (_) {}
    return res.status(200).json({ text: pick.text, author: pick.author });
  } catch (err) {
    return next(err);
  }
};

exports.list = async (_req, res, next) => {
  try {
    const url = env.quotes.sourceUrl;
    const secret = env.quotes.secret || '';
    const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    const list = Array.isArray(data?.quotes)
      ? data.quotes.map(normalize).filter((q) => q.text)
      : [];
    return res.status(200).json({ quotes: list });
  } catch (err) {
    return next(err);
  }
};
