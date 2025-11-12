const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nature.com/',
};

const stripHtml = (value = '') => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const cleanText = (value = '') => stripHtml(value).replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const shorten = (text = '', max = 180) => {
  const v = cleanText(text);
  if (v.length <= max) return v;
  const cut = v.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut) + '…';
};
const parseDateToNum = (raw = '') => {
  const s = (raw || '').trim();
  if (!s) return 0;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // Try YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(dt.getTime())) return dt.getTime();
  }
  return 0;
};

// Build a Google News RSS search URL
const buildGoogleNewsUrl = (query) => {
  const base = 'https://news.google.com/rss/search';
  const params = new URLSearchParams({
    q: query,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  return `${base}?${params.toString()}`;
};

async function fetchGoogleNews(query, limit = 20) {
  const url = buildGoogleNewsUrl(query);
  const { data } = await axios.get(url, { timeout: 10000, responseType: 'text', headers: DEFAULT_HEADERS });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const xml = parser.parse(data);
  const items = xml?.rss?.channel?.item || [];
  const normalized = items.slice(0, limit).map((it) => ({
    title: String(it?.title || '').trim(),
    url: String(it?.link || '').trim(),
    summary: shorten(String(it?.description || '')),
    imageUrl: '',
    date: String(it?.pubDate || '').trim(),
  })).filter((i) => i.title && i.url);
  return normalized;
}

async function fetchRss(url, limit = 20) {
  const { data } = await axios.get(url, { timeout: 10000, responseType: 'text', headers: DEFAULT_HEADERS });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const xml = parser.parse(data);
  const items = xml?.rss?.channel?.item || [];
  const pickFromSrcSet = (srcset = '') => {
    try {
      const parts = String(srcset).split(',').map((p) => p.trim());
      if (parts.length === 0) return '';
      const last = parts[parts.length - 1].split(' ')[0];
      return last || parts[0];
    } catch (_) { return ''; }
  };

  return items.slice(0, limit).map((it) => {
    const media = it['media:content'] || it['media:thumbnail'] || it.enclosure || null;
    let imageUrl = '';
    if (Array.isArray(media)) {
      const first = media[0] || {};
      imageUrl = first.url || first.href || pickFromSrcSet(first.srcset || '');
    } else if (media && typeof media === 'object') {
      imageUrl = media.url || media.href || pickFromSrcSet(media.srcset || '');
    }
    const title = String(it?.title || '').trim();
    const link = String(it?.link || '').trim();
    const summary = shorten(String(it?.description || ''));
    const date = String(it?.pubDate || '').trim();
    return { title, url: link, summary, imageUrl, date };
  }).filter((i) => i.title && i.url);
}

function parseCsv(value = '') {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toAbsoluteUrl(base, href) {
  try {
    const u = new URL(href, base);
    return u.toString();
  } catch (_) {
    return href;
  }
}

const pickFromSrcSet = (srcset = '') => {
  try {
    const parts = String(srcset).split(',').map((p) => p.trim());
    if (parts.length === 0) return '';
    const best = parts[parts.length - 1].split(' ')[0] || parts[0].split(' ')[0];
    return best;
  } catch (_) { return ''; }
};

async function fetchNatureSubject(subjectUrl, limit = 20) {
  try {
    const { data: html } = await axios.get(subjectUrl, { timeout: 10000, responseType: 'text', headers: DEFAULT_HEADERS });
    const $ = cheerio.load(html);

    const items = [];
    // Heuristics: pick links that look like article pages under /articles/
    $("a[href^='/articles/'], a[href*='://www.nature.com/articles/']").each((_, el) => {
      if (items.length >= limit * 3) return false; // collect a generous pool then trim later
      const href = $(el).attr('href') || '';
      const url = toAbsoluteUrl(subjectUrl, href);
      if (!href || /\/search\?/i.test(href)) return;

      // Prefer title from heading text or anchor text
      const anchor = $(el);
      const container = anchor.closest('article, li, .c-card, [data-test="article-card"], div');
      const title = (
        container.find('h3,h4').first().text()
        || anchor.text()
      ).replace(/\s+/g, ' ').trim();
      if (!title) return;

      // Summary candidates seen on Nature
      const summary = (
        container.find('.c-card__summary, .c-card__standfirst, [data-test="standfirst"], [data-test="snippet"], [itemprop="description"], p').first().text()
      ).replace(/\s+/g, ' ').trim();

      // Date
      const timeText = (
        container.find('time[datetime]').first().attr('datetime')
        || container.find('time').first().text()
      ).trim();

      // Image from picture/srcset/img
      let img = '';
      const pic = container.find('picture source').first();
      img = pickFromSrcSet(pic.attr('srcset') || pic.attr('data-srcset') || '')
        || container.find('img').first().attr('src')
        || container.find('img').first().attr('data-src')
        || container.find('img').first().attr('data-original')
        || '';
      const imageUrl = img ? toAbsoluteUrl(subjectUrl, img) : '';

      items.push({ title, url, summary: shorten(summary), imageUrl, date: timeText });
    });

    // Dedup by URL
    const seen = new Set();
    const deduped = items.filter((i) => {
      if (!i.url || seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });
    return deduped.slice(0, limit);
  } catch (_) {
    return [];
  }
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

async function getPeptideNews({ limit = 20 } = {}) {
  // Pull directly from Nature subject page by default
  const natureSubjectUrl = (process.env.NEWS_NATURE_URL || 'https://www.nature.com/subjects/peptides').trim();
  let rssList = parseCsv(process.env.NEWS_RSS_URLS || '');
  if (rssList.length === 0) {
    // Best-effort RSS computed from subject URL
    const rss = natureSubjectUrl.endsWith('.rss') ? natureSubjectUrl : `${natureSubjectUrl}.rss`;
    rssList = [rss];
  }

  // Restrict sources by host when provided; default to nature.com
  const allowedHosts = parseCsv(process.env.NEWS_ALLOWED_HOSTS || 'nature.com');
  const query = (process.env.NEWS_QUERY || 'peptide OR peptides OR "peptide therapy" OR GLP-1').trim();

  let items = [];

  // 1) Scrape the Nature subject page directly
  const pageItems = await fetchNatureSubject(natureSubjectUrl, limit);
  items = pageItems.slice();

  // 2) Only if we have fewer than requested items, supplement with RSS
  if (items.length < limit) {
    const chunks = await Promise.allSettled(rssList.map((url) => fetchRss(url, limit)));
    for (const c of chunks) {
      if (c.status === 'fulfilled' && Array.isArray(c.value)) {
        items.push(...c.value);
      }
    }
  }

  // If nothing from configured feeds, fallback to Google News, then filter by allowed hosts
  if (items.length === 0) {
    try {
      items = await fetchGoogleNews(query, limit * 2);
    } catch (_) {
      // ignore
    }
  }

  // Filter by allowed hosts if specified
  if (allowedHosts.length > 0) {
    const normalizedHosts = allowedHosts.map((h) => h.toLowerCase());
    items = items.filter((it) => {
      const host = hostname(it.url).toLowerCase();
      return normalizedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    });
  }

  // Deduplicate by URL while preserving order (Nature page order first)
  const seen = new Set();
  items = items.filter((it) => {
    if (!it || !it.url) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  // Sort by publish date descending (fallback to original order for ties)
  items = items
    .map((it, idx) => ({ it, idx, ts: parseDateToNum(it.date) }))
    .sort((a, b) => (b.ts - a.ts) || (a.idx - b.idx))
    .map((x) => x.it);

  // Enrich images on the final set to ensure the visible items get thumbnails
  const finalItems = items.slice(0, limit);
  await enrichItemsWithOg(finalItems, finalItems.length);

  return finalItems
    .map((item, idx) => ({ item, idx, ts: parseDateToNum(item.date) }))
    .sort((a, b) => (b.ts - a.ts) || (a.idx - b.idx))
    .map((entry) => entry.item);
}

module.exports = {
  getPeptideNews,
};

async function enrichItemsWithOg(items, maxFetch = 6) {
  const cache = getImageCache();
  let fetched = 0;
  for (const it of items) {
    // Enrich when any of image, summary, or date is missing OR date isn't parseable
    const needDate = !it.date || parseDateToNum(it.date) === 0;
    const needImage = !it.imageUrl;
    const needSummary = !it.summary;
    if (!needDate && !needImage && !needSummary) continue;
    if (fetched >= maxFetch) break;
    try {
      const cached = cache.get(it.url);
      if (cached && cached.expiresAt > Date.now()) {
        if (needImage && cached.image) it.imageUrl = cached.image;
        if (needSummary && cached.summary) it.summary = shorten(cached.summary);
        if (needDate && cached.published) it.date = String(cached.published);
        continue;
      }

      // Resolve Google News redirect pages to the publisher URL for better OG tags
      let targetUrl = it.url;
      if (hostname(targetUrl).includes('news.google.com')) {
        const resolved = await resolveGoogleNewsTarget(targetUrl);
        if (resolved) targetUrl = resolved;
      }

      const { image, description, published } = await fetchOgMeta(targetUrl);
      if (image) {
        const abs = toAbsoluteUrl(targetUrl, image);
        it.imageUrl = it.imageUrl || abs;
      }
      if (description) {
        const desc = stripHtml(description).trim();
        if (!it.summary && desc) it.summary = shorten(desc);
      }
      if (published && (needDate || parseDateToNum(it.date) === 0)) it.date = String(published);
      cache.set(it.url, {
        image: it.imageUrl || image || '',
        summary: it.summary || (description || ''),
        published: it.date || published || '',
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
    } catch (_) {
      // ignore
    }
    fetched += 1;
  }
}

async function fetchOgMeta(url) {
  try {
    const { data: html } = await axios.get(url, { timeout: 9000, responseType: 'text', headers: DEFAULT_HEADERS, maxRedirects: 5 });
    const $ = cheerio.load(html);
    const image = (
      $("meta[property='og:image:secure_url']").attr('content')
      || $("meta[property='og:image:url']").attr('content')
      || $("meta[property='og:image']").attr('content')
      || $("meta[name='og:image']").attr('content')
      || $("meta[property='twitter:image:src']").attr('content')
      || $("meta[property='twitter:image']").attr('content')
      || $("meta[name='twitter:image']").attr('content')
      || $("link[rel='image_src']").attr('href')
      || ''
    );
    const description = (
      $("meta[property='og:description']").attr('content')
      || $("meta[name='og:description']").attr('content')
      || $("meta[name='description']").attr('content')
      || ''
    );
    const published = detectPublishedDate($);
    return { image, description, published };
  } catch (_) {
    return { image: '', description: '', published: '' };
  }
}

function detectPublishedDate($) {
  const metaCandidates = [
    "meta[property='article:published_time']",
    "meta[name='article:published_time']",
    "meta[name='prism.publicationDate']",
    "meta[name='citation_publication_date']",
    "meta[name='dc.date']",
    "meta[name='dc.date.issued']",
    "meta[name='dc.date.published']",
    "meta[itemprop='datePublished']",
    "meta[property='og:updated_time']",
    "meta[name='date']",
  ];
  for (const selector of metaCandidates) {
    const val = $(selector).attr('content');
    if (val && val.trim()) return val.trim();
  }

  let fromJson = '';
  $("script[type='application/ld+json']").each((_, el) => {
    if (fromJson) return;
    const text = $(el).contents().text();
    try {
      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry.datePublished || entry.dateCreated || entry.dateModified;
        if (candidate && String(candidate).trim()) {
          fromJson = String(candidate).trim();
          break;
        }
      }
    } catch (_) {}
  });
  if (fromJson) return fromJson;

  return '';
}

async function resolveGoogleNewsTarget(url) {
  try {
    const { data: html } = await axios.get(url, { timeout: 7000, responseType: 'text', headers: DEFAULT_HEADERS, maxRedirects: 5 });
    const $ = cheerio.load(html);
    // meta refresh pattern: <meta http-equiv="refresh" content="0;url=...">
    const refresh = $("meta[http-equiv='refresh']").attr('content') || '';
    const m = refresh.match(/url=(.*)$/i);
    if (m && m[1]) {
      return toAbsoluteUrl(url, m[1]);
    }
    // try canonical link if it points off news.google.com
    const canonical = $("link[rel='canonical']").attr('href') || '';
    if (canonical && !hostname(canonical).includes('news.google.com')) {
      return canonical;
    }
    // look for primary article link
    const anchor = $("a[href^='https://']").filter((_, el) => !String($(el).attr('href')).includes('news.google.com')).first().attr('href');
    if (anchor) return anchor;
    return '';
  } catch (_) {
    return '';
  }
}

function getImageCache() {
  if (!getImageCache._cache) {
    getImageCache._cache = new Map();
  }
  return getImageCache._cache;
}
