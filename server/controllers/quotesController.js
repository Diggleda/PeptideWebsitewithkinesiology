const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');

const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const QUOTES_CACHE_TTL_MS = Math.max(10_000, Number(process.env.QUOTES_CACHE_TTL_MS || 60_000));
const QUOTES_ERROR_COOLDOWN_MS = Math.max(5_000, Number(process.env.QUOTES_ERROR_COOLDOWN_MS || 20_000));

const quotesUpstreamCache = {
  list: [],
  fetchedAt: 0,
  pending: null,
  lastErrorAt: 0,
};

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

const fetchQuotesFromDatabase = async () => {
  if (!mysqlClient.isEnabled()) {
    return null;
  }

  try {
    const rows = await mysqlClient.fetchAll(
      `SELECT id, text, author
         FROM quotes
        ORDER BY updated_at DESC, id DESC
        LIMIT 500`,
    );
    return rows.map(normalize).filter((q) => q.text);
  } catch (_error) {
    return null;
  }
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

const fetchQuotesFromSource = async () => {
  const url = env.quotes.sourceUrl;
  const secret = env.quotes.secret || '';
  const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
  const { data } = await axios.get(url, { headers, timeout: 8000 });
  const rawList = Array.isArray(data?.quotes) ? data.quotes : [];
  return rawList.map(normalize).filter((q) => q.text);
};

const getQuotesList = async () => {
  const now = Date.now();
  if (quotesUpstreamCache.list.length > 0 && now - quotesUpstreamCache.fetchedAt < QUOTES_CACHE_TTL_MS) {
    return quotesUpstreamCache.list;
  }

  if (quotesUpstreamCache.pending) {
    try {
      await quotesUpstreamCache.pending;
      if (quotesUpstreamCache.list.length > 0) {
        return quotesUpstreamCache.list;
      }
    } catch (_) {
      // If a shared fetch fails, stale fallback logic below decides next step.
    }
  }

  if (
    quotesUpstreamCache.list.length > 0
    && now - quotesUpstreamCache.lastErrorAt < QUOTES_ERROR_COOLDOWN_MS
  ) {
    return quotesUpstreamCache.list;
  }

  const pending = (async () => {
    const dbList = await fetchQuotesFromDatabase();
    if (Array.isArray(dbList)) {
      return dbList;
    }
    return fetchQuotesFromSource();
  })();
  quotesUpstreamCache.pending = pending;
  try {
    const list = await pending;
    quotesUpstreamCache.list = list;
    quotesUpstreamCache.fetchedAt = Date.now();
    quotesUpstreamCache.lastErrorAt = 0;
    return list;
  } catch (error) {
    quotesUpstreamCache.lastErrorAt = Date.now();
    if (quotesUpstreamCache.list.length > 0) {
      return quotesUpstreamCache.list;
    }
    throw error;
  } finally {
    if (quotesUpstreamCache.pending === pending) {
      quotesUpstreamCache.pending = null;
    }
  }
};

exports.getDaily = async (_req, res, next) => {
  try {
    // Read cache
    let cached = null;
    const p = cacheFilePath();
    try {
      const content = fs.readFileSync(p, 'utf8');
      cached = JSON.parse(content);
    } catch (_) {}

    const key = todayKey();
    if (cached && cached.date === key) {
      if (typeof cached.text === 'string' && cached.text.trim()) {
        return res.status(200).json({ text: cached.text.trim(), author: cached.author || '' });
      }
    }

    const list = await getQuotesList();

    if (list.length === 0) {
      return res.status(200).json({ text: 'Excellence is an attitude.', author: 'PepPro' });
    }

    if (cached && cached.date === key) {
      const found = list.find((q) => String(q.id) === String(cached.id));
      if (found) return res.status(200).json({ text: found.text, author: found.author });
    }

    // Pick a random quote, avoid yesterday's id when possible
    const yesterdayId = cached && cached.date !== key ? cached.id : null;
    const pick = pickRandom(list, yesterdayId);
    const toStore = { date: key, id: pick.id, text: pick.text, author: pick.author };
    try { fs.writeFileSync(p, JSON.stringify(toStore), 'utf8'); } catch (_) {}
    return res.status(200).json({ text: pick.text, author: pick.author });
  } catch (err) {
    return next(err);
  }
};

exports.list = async (_req, res, next) => {
  try {
    const list = await getQuotesList();
    return res.status(200).json({ quotes: list });
  } catch (err) {
    return next(err);
  }
};
