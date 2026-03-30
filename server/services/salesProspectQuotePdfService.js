const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { findProductBySku } = require('../integration/wooCommerceClient');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

let cachedPepProLogoDataUrl;
let cachedPepProIconDataUrl;
let cachedWooSkuImageMap;
const cachedResolvedProductImageBySku = new Map();
const cachedImageDataUrlPromises = new Map();
const STATIC_ASSET_SEARCH_DIRS = [
  path.resolve(__dirname, '../../public'),
  path.resolve(__dirname, '../../build'),
  path.resolve(__dirname, '../../build_debug'),
  path.resolve(__dirname, '../../build_main_tmp'),
  path.resolve(__dirname, '../../build_staging_tmp'),
];
const IMAGE_SOURCE_KEYS = [
  'src',
  'url',
  'href',
  'source',
  'image',
  'imageUrl',
  'image_url',
  'thumbnail',
  'thumb',
  'full',
  'fullUrl',
  'full_url',
  'original',
  'originalUrl',
  'original_url',
];
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);
const IMAGE_FETCH_ACCEPT_HEADER = 'image/png,image/jpeg,image/webp,image/gif,image/*,*/*;q=0.8';
const IMAGE_FETCH_TIMEOUT_MS = 3500;
const MAX_IMAGE_CANDIDATES_PER_ITEM = 4;

const inferStaticAssetContentType = (assetPath, fallbackType) => {
  const extension = path.extname(String(assetPath || '')).trim().toLowerCase();
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  return fallbackType;
};

const findStaticAssetPath = ({ preferredRelativePaths = [], matchTokens = [] }) => {
  for (const relativePath of preferredRelativePaths) {
    if (typeof relativePath !== 'string' || !relativePath.trim()) continue;
    const candidatePath = path.resolve(__dirname, relativePath);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const loweredTokens = matchTokens.map((token) => String(token || '').trim().toLowerCase()).filter(Boolean);
  if (loweredTokens.length === 0) {
    return null;
  }

  for (const directoryPath of STATIC_ASSET_SEARCH_DIRS) {
    try {
      const candidateName = fs.readdirSync(directoryPath).find((entry) => {
        const loweredEntry = String(entry || '').trim().toLowerCase();
        return /\.(png|svg|webp|jpe?g|gif)$/i.test(loweredEntry)
          && loweredTokens.every((token) => loweredEntry.includes(token));
      });
      if (candidateName) {
        return path.join(directoryPath, candidateName);
      }
    } catch {
      // Ignore missing asset directories and continue searching.
    }
  }

  return null;
};

const loadStaticAssetDataUrl = ({ cacheKey, preferredRelativePaths, matchTokens, fallbackType }) => {
  if (cacheKey === 'logo' && cachedPepProLogoDataUrl !== undefined) {
    return cachedPepProLogoDataUrl;
  }
  if (cacheKey === 'icon' && cachedPepProIconDataUrl !== undefined) {
    return cachedPepProIconDataUrl;
  }

  const assetPath = findStaticAssetPath({ preferredRelativePaths, matchTokens });
  let dataUrl = null;
  if (assetPath) {
    try {
      const buffer = fs.readFileSync(assetPath);
      dataUrl = `data:${inferStaticAssetContentType(assetPath, fallbackType)};base64,${buffer.toString('base64')}`;
    } catch {
      dataUrl = null;
    }
  }

  if (cacheKey === 'logo') {
    cachedPepProLogoDataUrl = dataUrl;
  } else if (cacheKey === 'icon') {
    cachedPepProIconDataUrl = dataUrl;
  }
  return dataUrl;
};

const getPepProLogoDataUrl = () => {
  return loadStaticAssetDataUrl({
    cacheKey: 'logo',
    preferredRelativePaths: [
      '../../public/PepPro_fulllogo.png',
      '../../public/Peppro_fulllogo.png',
    ],
    matchTokens: ['pep', 'fulllogo'],
    fallbackType: 'image/png',
  });
};

const extractImageSource = (value, visited = new Set()) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (!value || typeof value !== 'object' || visited.has(value)) {
    return null;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const source = extractImageSource(entry, visited);
      if (source) {
        return source;
      }
    }
    return null;
  }
  for (const key of IMAGE_SOURCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const source = extractImageSource(value[key], visited);
    if (source) {
      return source;
    }
  }
  return null;
};

const getPepProIconDataUrl = () => {
  return loadStaticAssetDataUrl({
    cacheKey: 'icon',
    preferredRelativePaths: [
      '../../public/PepPro_icon.png',
      '../../public/Peppro_icon.png',
    ],
    matchTokens: ['pep', 'icon'],
    fallbackType: 'image/png',
  });
};

const toMoney = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const formatCurrency = (value, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(currency || 'USD').trim().toUpperCase() || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toMoney(value));

const sanitizeFilename = (value) => String(value || '')
  .replace(/[^a-zA-Z0-9_-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 80);

const getCachedWooSkuImageMap = () => {
  if (cachedWooSkuImageMap !== undefined) {
    return cachedWooSkuImageMap;
  }

  const map = new Map();
  const cacheDir = path.resolve(__dirname, '../../server-data/woo-proxy-cache');

  try {
    const filenames = fs.readdirSync(cacheDir);
    for (const filename of filenames) {
      if (!filename.endsWith('.json')) continue;
      const filePath = path.join(cacheDir, filename);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const records = Array.isArray(raw?.data) ? raw.data : [];
      for (const record of records) {
        const sku = typeof record?.sku === 'string' && record.sku.trim()
          ? record.sku.trim()
          : null;
        if (!sku || map.has(sku)) continue;
        const imageSource = extractImageSource(record?.image)
          || extractImageSource(Array.isArray(record?.images) ? record.images[0] : null);
        if (imageSource) {
          map.set(sku, imageSource);
        }
      }
    }
  } catch {
    cachedWooSkuImageMap = map;
    return cachedWooSkuImageMap;
  }

  cachedWooSkuImageMap = map;
  return cachedWooSkuImageMap;
};

const buildQuoteFilename = (quote) => {
  const payload = quote?.quotePayloadJson || {};
  const prospectName = payload?.prospect?.contactName
    || payload?.prospect?.name
    || payload?.prospect?.identifier
    || quote?.prospectId
    || 'Prospect';
  const safeProspectName = sanitizeFilename(prospectName) || 'Prospect';
  const revision = Math.max(1, Math.floor(Number(quote?.revisionNumber) || 1));
  return `PepPro_Quote_${safeProspectName}_${revision}.pdf`;
};

const findExistingExecutablePath = (candidates = []) => candidates
  .find((candidate) => typeof candidate === 'string' && candidate.trim() && fs.existsSync(candidate.trim()));

const buildChromiumLaunchOptions = () => {
  const executablePath = findExistingExecutablePath([
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]);

  return {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    ...(executablePath ? { executablePath } : {}),
  };
};

const normalizeRemoteImageUrl = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join('/');
    return parsed.toString();
  } catch {
    return null;
  }
};

const appendImageCandidate = (candidates, value) => {
  const normalized = normalizeRemoteImageUrl(extractImageSource(value));
  if (!normalized) {
    return;
  }
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }
  try {
    const parsed = new URL(normalized);
    const proxiedSource = parsed.searchParams.get('src');
    const decoded = normalizeRemoteImageUrl(proxiedSource);
    if (decoded && !candidates.includes(decoded)) {
      candidates.push(decoded);
    }
  } catch {
    // Ignore non-URL values that were already filtered out above.
  }
};

const collectQuoteItemImageCandidates = async (item) => {
  const candidates = [];
  appendImageCandidate(candidates, item?.imageUrl);
  appendImageCandidate(candidates, item?.image);
  appendImageCandidate(candidates, item?.image_url);
  appendImageCandidate(candidates, item?.thumbnail);
  appendImageCandidate(candidates, item?.thumb);
  const sku = typeof item?.sku === 'string' && item.sku.trim()
    ? item.sku.trim()
    : null;
  if (!sku) {
    return candidates;
  }

  appendImageCandidate(candidates, getCachedWooSkuImageMap().get(sku));
  if (candidates.length > 0) {
    return candidates;
  }

  if (!cachedResolvedProductImageBySku.has(sku)) {
    cachedResolvedProductImageBySku.set(sku, (async () => {
      try {
        const product = await findProductBySku(sku);
        return extractImageSource(product?.image)
          || extractImageSource(product?.images)
          || null;
      } catch {
        return null;
      }
    })());
  }

  appendImageCandidate(candidates, await cachedResolvedProductImageBySku.get(sku));

  return candidates;
};

const inferImageContentType = (contentType, sourceUrl) => {
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  if (normalizedContentType.startsWith('image/')) {
    const normalizedImageContentType = normalizedContentType.split(';', 1)[0];
    return SUPPORTED_IMAGE_CONTENT_TYPES.has(normalizedImageContentType)
      ? normalizedImageContentType
      : null;
  }

  const normalizedUrl = normalizeRemoteImageUrl(sourceUrl);
  if (!normalizedUrl || normalizedUrl.startsWith('data:image/')) {
    return null;
  }

  try {
    const pathname = new URL(normalizedUrl).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
  } catch {
    return null;
  }

  return null;
};

const fetchImageAsDataUrl = async (value) => {
  const normalizedUrl = normalizeRemoteImageUrl(value);
  if (!normalizedUrl || normalizedUrl.startsWith('data:image/')) {
    return normalizedUrl;
  }
  if (!cachedImageDataUrlPromises.has(normalizedUrl)) {
    cachedImageDataUrlPromises.set(normalizedUrl, (async () => {
      try {
        const response = await axios.get(normalizedUrl, {
          responseType: 'arraybuffer',
          timeout: IMAGE_FETCH_TIMEOUT_MS,
          maxRedirects: 5,
          headers: {
            Accept: IMAGE_FETCH_ACCEPT_HEADER,
          },
        });
        const contentType = inferImageContentType(response?.headers?.['content-type'], normalizedUrl);
        const buffer = Buffer.isBuffer(response?.data)
          ? response.data
          : Buffer.from(response?.data || '');
        if (!contentType || buffer.length === 0) {
          return null;
        }
        return `data:${contentType};base64,${buffer.toString('base64')}`;
      } catch {
        return null;
      }
    })());
  }
  return cachedImageDataUrlPromises.get(normalizedUrl);
};

const resolveQuoteItemImageDataUrl = async (item) => {
  const candidates = (await collectQuoteItemImageCandidates(item)).slice(0, MAX_IMAGE_CANDIDATES_PER_ITEM);
  for (const candidate of candidates) {
    const dataUrl = await fetchImageAsDataUrl(candidate);
    if (dataUrl) {
      return dataUrl;
    }
  }
  return null;
};

const renderQuoteHtml = async (quote) => {
  const payload = quote?.quotePayloadJson || {};
  const prospect = payload?.prospect || {};
  const salesRep = payload?.salesRep || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const logoDataUrl = getPepProLogoDataUrl();
  const fallbackItemImage = getPepProIconDataUrl();
  const title = quote?.title || payload?.title || 'Quote';
  const currency = quote?.currency || payload?.currency || 'USD';
  const notes = typeof payload?.notes === 'string' ? payload.notes.trim() : '';

  const resolvedImages = await Promise.all(
    items.map((item) => resolveQuoteItemImageDataUrl(item)),
  );

  const rows = items.map((item, index) => {
    const quantity = Math.max(1, Math.floor(Number(item?.quantity) || 1));
    const unitPrice = toMoney(item?.unitPrice);
    const lineTotal = toMoney(item?.lineTotal ?? unitPrice * quantity);
    const imageSrc = resolvedImages[index] || fallbackItemImage;
    const imageFallbackAttribute = fallbackItemImage
      ? ` onerror="this.onerror=null;this.src='${escapeHtml(fallbackItemImage)}';"`
      : '';
    const imageFallbackDataAttribute = fallbackItemImage
      ? ` data-fallback-src="${escapeHtml(fallbackItemImage)}"`
      : '';
    return `
      <tr>
        <td class="col-index">${index + 1}</td>
        <td>
          <div class="item-cell">
            <div class="item-thumb-shell">
              ${imageSrc
                ? `<img class="item-thumb" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(item?.name || 'Item')}"${imageFallbackDataAttribute}${imageFallbackAttribute} />`
                : '<div class="item-thumb item-thumb--empty"></div>'}
            </div>
            <div class="item-copy">
              <div class="item-name">${escapeHtml(item?.name || 'Item')}</div>
              ${item?.note ? `<div class="item-meta">${escapeHtml(item.note)}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="numeric">${quantity}</td>
        <td class="numeric">${escapeHtml(formatCurrency(unitPrice, currency))}</td>
        <td class="numeric">${escapeHtml(formatCurrency(lineTotal, currency))}</td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #0f172a;
        --muted: #475569;
        --line: #dbe2ea;
        --accent: #0f4c81;
        --accent-soft: #eff6ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Arial, sans-serif;
        color: var(--ink);
        background: #fff;
      }
      .page {
        padding: 28px 24px 36px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        padding-bottom: 18px;
        border-bottom: 2px solid var(--accent);
      }
      .hero-brand {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .brand-logo {
        display: block;
        width: 190px;
        max-width: 100%;
        height: auto;
      }
      .brand {
        font-size: 28px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .title {
        margin: 8px 0 0;
        font-size: 24px;
        font-weight: 700;
      }
      .subtle {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .meta-grid {
        margin-top: 20px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .meta-card {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px;
        background: #fff;
      }
      .meta-label {
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .meta-value {
        font-size: 14px;
        line-height: 1.6;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 18px;
        font-size: 13px;
      }
      thead th {
        text-align: left;
        padding: 10px 12px;
        background: var(--accent-soft);
        color: var(--accent);
        border-bottom: 1px solid var(--line);
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      tbody td {
        padding: 12px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      .col-index {
        width: 32px;
        color: var(--muted);
      }
      .numeric {
        text-align: right;
        white-space: nowrap;
      }
      .item-name {
        font-weight: 700;
        font-size: 13px;
      }
      .item-cell {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .item-thumb-shell {
        width: 44px;
        min-width: 44px;
        height: 44px;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: #f8fafc;
      }
      .item-thumb {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
      }
      .item-thumb--empty {
        background: #f8fafc;
      }
      .item-copy {
        min-width: 0;
      }
      .item-meta {
        margin-top: 4px;
        color: var(--muted);
        font-size: 11px;
      }
      .summary-row {
        display: flex;
        justify-content: flex-end;
        align-items: baseline;
        gap: 0.45rem;
        margin-top: 22px;
        margin-left: auto;
        width: 260px;
        text-align: right;
        color: var(--accent);
        font-weight: 800;
        font-size: 16px;
      }
      .notes {
        margin-top: 18px;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px;
      }
      .notes p {
        margin: 0;
        white-space: pre-wrap;
        line-height: 1.6;
      }
      .footer {
        margin-top: 30px;
        padding-top: 12px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="hero">
        <div class="hero-brand">
          ${logoDataUrl
            ? `<img class="brand-logo" src="${logoDataUrl}" alt="PepPro" />`
            : '<div class="brand">PepPro</div>'}
          <div class="title">${escapeHtml(title)}</div>
          <div class="subtle">Revision R${Math.max(1, Math.floor(Number(quote?.revisionNumber) || 1))}</div>
        </div>
      </div>

      <div class="meta-grid">
        <div class="meta-card">
          <div class="meta-label">Prospect</div>
          <div class="meta-value">
            <div>${escapeHtml(prospect?.contactName || prospect?.name || 'Prospect')}</div>
            ${prospect?.contactEmail ? `<div>${escapeHtml(prospect.contactEmail)}</div>` : ''}
            ${prospect?.contactPhone ? `<div>${escapeHtml(prospect.contactPhone)}</div>` : ''}
          </div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Sales Rep</div>
          <div class="meta-value">
            <div>${escapeHtml(salesRep?.name || 'PepPro')}</div>
            ${salesRep?.email ? `<div>${escapeHtml(salesRep.email)}</div>` : ''}
          </div>
        </div>
      </div>

      ${notes ? `
      <div class="notes">
        <div class="meta-label">Notes</div>
        <p>${escapeHtml(notes)}</p>
      </div>` : ''}

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th class="numeric">Qty</th>
            <th class="numeric">Unit</th>
            <th class="numeric">Line Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="5">No items</td></tr>'}
        </tbody>
      </table>

      <div class="summary-row">
        <span>Subtotal</span>
        <span>${escapeHtml(formatCurrency(quote?.subtotal ?? payload?.subtotal ?? 0, currency))}</span>
      </div>

      <div class="footer">
        This quote is a sales summary generated by PepPro. Shipping, tax, and payment terms are excluded from this revision.
      </div>
    </div>
  </body>
</html>`;
};

const generateProspectQuotePdf = async (quote) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(buildChromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(await renderQuoteHtml(quote), { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const waitForImage = (image, timeoutMs = 800) => new Promise((resolve) => {
        if (image.complete) {
          resolve();
          return;
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
      });

      const images = Array.from(document.images);
      await Promise.all(images.map(async (image) => {
        await waitForImage(image);
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          return;
        }
        const fallbackSrc = image.dataset.fallbackSrc;
        if (fallbackSrc && image.currentSrc !== fallbackSrc && image.src !== fallbackSrc) {
          image.src = fallbackSrc;
          await waitForImage(image, 400);
        }
        if (image.naturalWidth === 0 || image.naturalHeight === 0) {
          image.removeAttribute('alt');
          image.style.visibility = 'hidden';
        }
      }));
    });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: {
        top: '18px',
        right: '18px',
        bottom: '18px',
        left: '18px',
      },
    });
    return {
      pdf: Buffer.from(pdf),
      filename: buildQuoteFilename(quote),
    };
  } finally {
    await browser.close();
  }
};

module.exports = {
  buildQuoteFilename,
  generateProspectQuotePdf,
};
