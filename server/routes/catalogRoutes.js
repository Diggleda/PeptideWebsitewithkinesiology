const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const wooController = require('../controllers/wooController');
const wooCommerceClient = require('../integration/wooCommerceClient');
const { authenticate } = require('../middleware/authenticate');
const mysqlClient = require('../database/mysqlClient');
const orderRepository = require('../repositories/orderRepository');
const patientLinksRepository = require('../repositories/patientLinksRepository');
const userRepository = require('../repositories/userRepository');
const { env } = require('../config/env');
const { logger } = require('../config/logger');
const { JsonStore } = require('../storage/jsonStore');

const router = Router();
const MODEL_VERSION = 'heuristic-v1-node-fallback';
const SIMULATION_MODEL_VERSION = 'heuristic-v1-node-simulation';
const DEFAULT_SIMULATION_EMAILS = ['diggledadiggz@gmail.com'];
const DEFAULT_RECOMMENDATION_LIMIT = 12;
const MAX_RECOMMENDATION_LIMIT = 24;
const DEFAULT_SIMULATION_LIMIT = 6;
const MAX_SIMULATION_LIMIT = 12;
let delegationStore = null;

const getDelegationStore = () => {
  if (!delegationStore) {
    delegationStore = new JsonStore(env.dataDir, 'delegation-links.json', {
      byDoctorId: {},
    });
    delegationStore.init();
  }
  return delegationStore;
};

const recommendationsEnabled = () => {
  const raw = String(process.env.RECOMMENDATIONS_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
};

const normalizeRole = (role) => String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const isDoctorRole = (role) => ['doctor', 'test_doctor'].includes(normalizeRole(role));
const isRecommendationRole = (role) => [
  'doctor',
  'test_doctor',
  'admin',
  'lead',
  'partner',
  'sales_rep',
  'salesrep',
  'sales_partner',
  'sales_lead',
  'saleslead',
  'rep',
  'test_rep',
].includes(normalizeRole(role));
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const simulationEmails = () => new Set(
  String(process.env.RECOMMENDATION_SIMULATION_EMAILS || DEFAULT_SIMULATION_EMAILS.join(','))
    .split(',')
    .map((entry) => normalizeEmail(entry))
    .filter(Boolean),
);
const isSimulationUser = (user) => simulationEmails().has(normalizeEmail(user?.email));
const canReadRecommendations = (user) => isRecommendationRole(user?.role) || isSimulationUser(user);

const parsePositiveInt = (value) => {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed > 0 ? parsed : null;
  }
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const parsed = Number.parseInt(text, 10);
    return parsed > 0 ? parsed : null;
  }
  const match = text.match(/^woo-(?:product-)?(\d+)$/i) || text.match(/^product-(\d+)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return parsed > 0 ? parsed : null;
};

const parseEnvPositiveInt = (name, fallback) => {
  const parsed = parsePositiveInt(process.env[name]);
  return parsed || fallback;
};

const resolveRecommendationLimit = (requestedLimit) => {
  const requested = parsePositiveInt(requestedLimit) || DEFAULT_RECOMMENDATION_LIMIT;
  const configuredMax = parseEnvPositiveInt('RECOMMENDATION_MAX_RESULTS', MAX_RECOMMENDATION_LIMIT);
  const safeMax = Math.max(1, Math.min(configuredMax, 100));
  return Math.max(1, Math.min(requested, safeMax));
};

const resolveSimulationLimit = (responseLimit) => {
  const configured = parseEnvPositiveInt('RECOMMENDATION_SIMULATION_LIMIT', DEFAULT_SIMULATION_LIMIT);
  const safeConfigured = Math.max(1, Math.min(configured, MAX_SIMULATION_LIMIT));
  return Math.max(1, Math.min(responseLimit, safeConfigured));
};

const orderItems = (order) => {
  if (Array.isArray(order?.items)) return order.items.filter((item) => item && typeof item === 'object');
  if (Array.isArray(order?.lineItems)) return order.lineItems.filter((item) => item && typeof item === 'object');
  return [];
};

const itemProductId = (item) => (
  parsePositiveInt(item?.wooProductId)
  || parsePositiveInt(item?.productWooId)
  || parsePositiveInt(item?.productId)
  || parsePositiveInt(item?.product_id)
  || parsePositiveInt(item?.id)
);

const itemQuantity = (item) => Math.max(1, Math.floor(Number(item?.quantity || item?.qty || 1) || 1));

const normalizeFilterKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const normalizeLinkType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'brochure' ? 'brochure' : 'delegate';
};
const toIsoDateTime = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
};
const isInactiveLink = (link) => {
  if (!link || typeof link !== 'object') return true;
  const status = String(link.status || '').trim().toLowerCase();
  if (status === 'revoked' || status === 'expired') return true;
  if (link.revokedAt || link.revoked_at) return true;
  const expiresAtMs = Date.parse(link.expiresAt || link.expires_at || '');
  return Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs;
};
const normalizeLocalLink = (link, doctorId) => {
  const linkType = normalizeLinkType(link?.linkType ?? link?.link_type);
  const productScopeItemsSource = link?.productScopeItems
    ?? link?.product_scope_items
    ?? link?.allowedProducts
    ?? link?.allowed_products;
  const productScopeItems = Array.isArray(productScopeItemsSource)
    ? productScopeItemsSource
    : typeof productScopeItemsSource === 'string'
      ? productScopeItemsSource.replace(/\n/g, ',').split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];
  return {
    ...link,
    doctorId: String(doctorId || link?.doctorId || link?.doctor_id || '').trim(),
    linkType,
    link_type: linkType,
    capabilities: patientLinksRepository.capabilitiesForLinkType(linkType),
    productScope: String(link?.productScope || link?.product_scope || 'all_physician_approved').trim() || 'all_physician_approved',
    productScopeItems,
    expiresAt: toIsoDateTime(link?.expiresAt || link?.expires_at),
    revokedAt: toIsoDateTime(link?.revokedAt || link?.revoked_at),
  };
};
const findLocalLinkByTokenFromState = (state, token) => {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || !state?.byDoctorId || typeof state.byDoctorId !== 'object') return null;
  for (const [doctorId, bucket] of Object.entries(state.byDoctorId)) {
    const links = Array.isArray(bucket?.links) ? bucket.links : [];
    const link = links.find((candidate) => String(candidate?.token || '').trim() === normalizedToken);
    if (!link || isInactiveLink(link)) continue;
    return normalizeLocalLink(link, doctorId);
  }
  return null;
};
const findLocalLinkByToken = (token) => {
  const state = getDelegationStore().read() || {};
  return findLocalLinkByTokenFromState(state, token);
};
const resolveBrochureCatalogLink = async (token) => {
  let link = null;
  if (patientLinksRepository.isEnabled()) {
    try {
      link = await patientLinksRepository.findByToken(token);
    } catch (error) {
      logger.warn({ err: error }, 'Brochure catalog: SQL token lookup failed; trying local link store');
    }
  }
  if (!link) {
    link = findLocalLinkByToken(token);
  }
  if (!link || normalizeLinkType(link.linkType ?? link.link_type) !== 'brochure' || link.capabilities?.canViewProducts !== true) {
    return null;
  }
  return link;
};

const containsSubscription = (value) => String(value || '').trim().toLowerCase().includes('subscription');

const isExcludedCatalogProduct = (product) => {
  const status = String(product?.status || '').trim().toLowerCase();
  if (status && status !== 'publish') return true;
  if (containsSubscription(product?.type) || containsSubscription(product?.name)) return true;

  for (const category of Array.isArray(product?.categories) ? product.categories : []) {
    const name = category?.name;
    const slug = category?.slug;
    if (containsSubscription(name) || containsSubscription(slug)) return true;
    if (normalizeFilterKey(name) === 'add-on' || normalizeFilterKey(slug) === 'add-on') return true;
  }

  return normalizeFilterKey(product?.sku) === 'add-on' || normalizeFilterKey(product?.slug) === 'add-on';
};

const normalizeSkuKey = (value) => String(value || '').trim().toLowerCase();
const normalizeSkuLoose = (value) => normalizeSkuKey(value).replace(/[^a-z0-9]+/g, '');

const firstProductImage = (product) => {
  if (product?.image && typeof product.image === 'object' && String(product.image.src || '').trim()) {
    return String(product.image.src).trim();
  }
  if (typeof product?.image === 'string' && product.image.trim()) {
    return product.image.trim();
  }
  for (const image of Array.isArray(product?.images) ? product.images : []) {
    if (image && typeof image === 'object' && String(image.src || '').trim()) return String(image.src).trim();
    if (typeof image === 'string' && image.trim()) return image.trim();
  }
  return null;
};

const productCategories = (product) => (Array.isArray(product?.categories) ? product.categories : [])
  .filter((category) => category && typeof category === 'object' && String(category.name || '').trim())
  .map((category) => ({
    id: parsePositiveInt(category.id),
    name: String(category.name || '').trim(),
    slug: String(category.slug || '').trim() || null,
  }));

const primaryCategoryName = (product) => {
  const names = productCategories(product).map((category) => category.name).filter(Boolean);
  const preferred = names.filter((name) => name.toLowerCase() !== 'uncategorized');
  return (preferred[0] || names[0] || null);
};

const brochureScopeTokens = (link) => {
  const values = [];
  for (const key of ['productScopeItems', 'product_scope_items', 'allowedProducts', 'allowed_products']) {
    const raw = link?.[key];
    if (Array.isArray(raw)) values.push(...raw);
    else if (typeof raw === 'string') values.push(...raw.replace(/\n/g, ',').split(','));
  }
  return new Set(values.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
};

const brochureScopeTokenVariants = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return [];
  const variants = new Set([
    text,
    normalizeSkuKey(text),
    normalizeSkuLoose(text),
    normalizeFilterKey(text),
  ].filter(Boolean));
  const id = parsePositiveInt(text);
  if (id) {
    variants.add(String(id));
    variants.add(`woo-${id}`);
    variants.add(`woo-product-${id}`);
    variants.add(`product-${id}`);
  }
  const variationMatch = text.match(/^woo-variation-(\d+)$/i) || text.match(/^variation-(\d+)$/i);
  if (variationMatch) {
    const variationId = Number.parseInt(variationMatch[1], 10);
    if (variationId > 0) {
      variants.add(String(variationId));
      variants.add(`woo-${variationId}`);
      variants.add(`variation-${variationId}`);
      variants.add(`woo-variation-${variationId}`);
    }
  }
  return [...variants];
};

const brochureScopeMatches = (product, link) => {
  const tokens = brochureScopeTokens(link);
  const scope = String(link?.productScope || link?.product_scope || 'all_physician_approved').trim().toLowerCase();
  if (tokens.size === 0 && ['specific_products', 'specific_cart_only'].includes(scope)) return false;
  if (tokens.size === 0 || scope === 'all_physician_approved') return true;
  const productId = String(product?.id || '').trim().toLowerCase();
  const sku = normalizeSkuKey(product?.sku);
  const candidates = new Set([
    productId,
    productId ? `woo-${productId}` : '',
    sku,
    normalizeSkuLoose(sku),
    String(product?.name || '').trim().toLowerCase(),
    ...productCategories(product).flatMap((category) => [
      String(category.name || '').trim().toLowerCase(),
      String(category.slug || '').trim().toLowerCase(),
    ]),
  ].filter(Boolean));
  for (const variation of Array.isArray(product?.variations) ? product.variations : []) {
    const variationId = typeof variation === 'object'
      ? String(variation?.id || '').trim().toLowerCase()
      : String(variation || '').trim().toLowerCase();
    const variationSku = typeof variation === 'object' ? normalizeSkuKey(variation?.sku) : '';
    if (variationId) {
      candidates.add(variationId);
      candidates.add(`woo-${variationId}`);
      candidates.add(`variation-${variationId}`);
      candidates.add(`woo-variation-${variationId}`);
    }
    if (variationSku) {
      candidates.add(variationSku);
      candidates.add(normalizeSkuLoose(variationSku));
    }
  }
  return [...tokens].some((token) => brochureScopeTokenVariants(token).some((variant) => candidates.has(variant)));
};

const BROCHURE_CSV_DEFAULT_PATH = path.resolve(__dirname, '../config/product-brochure-info.csv');

const normalizeCsvHeader = (value) => String(value || '')
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const parseCsvText = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (inQuotes && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      if (row.some((entry) => String(entry || '').trim())) {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.some((entry) => String(entry || '').trim())) {
    rows.push(row);
  }
  return rows;
};

const brochureCsvFieldAliases = {
  productname: 'product_name',
  name: 'product_name',
  productsku: 'product_sku',
  sku: 'product_sku',
  productdescription: 'product_description',
  description: 'product_description',
  productinformation: 'product_information',
  information: 'product_information',
  productinfo: 'product_information',
  productid: 'product_id',
  wooproductid: 'product_id',
  parentproductid: 'parent_product_id',
  variationid: 'variation_id',
  woovariationid: 'variation_id',
  parentsku: 'parent_sku',
  syncstatus: 'sync_status',
};

const normalizeBrochureCsvRows = (csvText) => {
  const records = parseCsvText(csvText);
  if (records.length < 2) return [];
  const headers = records[0].map((header) => brochureCsvFieldAliases[normalizeCsvHeader(header)] || null);
  const rows = [];
  for (const record of records.slice(1)) {
    const raw = {};
    headers.forEach((key, index) => {
      if (!key) return;
      raw[key] = String(record[index] || '').trim();
    });
    const productSku = String(raw.product_sku || '').trim();
    const productDescription = String(raw.product_description || '').trim();
    const productInformation = String(raw.product_information || '').trim();
    if (!productSku || (!productDescription && !productInformation)) continue;
    rows.push({
      product_name: String(raw.product_name || '').trim() || productSku,
      product_id: parsePositiveInt(raw.product_id),
      parent_product_id: parsePositiveInt(raw.parent_product_id),
      variation_id: parsePositiveInt(raw.variation_id),
      product_sku: productSku,
      parent_sku: String(raw.parent_sku || '').trim() || productSku,
      product_description: productDescription || null,
      product_information: productInformation || null,
      sync_status: String(raw.sync_status || '').trim() || null,
      source: 'csv',
    });
  }
  return rows;
};

const brochureCsvCandidatePaths = () => {
  const configured = String(process.env.BROCHURE_CATALOG_CSV_PATH || '').trim();
  return [
    configured ? path.resolve(configured) : null,
    BROCHURE_CSV_DEFAULT_PATH,
    path.resolve(env.dataDir, 'product-brochure-info.csv'),
  ].filter(Boolean);
};

const loadBrochureRowsFromCsv = () => {
  for (const csvPath of brochureCsvCandidatePaths()) {
    try {
      if (!fs.existsSync(csvPath)) continue;
      const rows = normalizeBrochureCsvRows(fs.readFileSync(csvPath, 'utf8'));
      if (rows.length > 0) {
        logger.info({ path: csvPath, count: rows.length }, 'Brochure catalog: loaded CSV brochure data');
      }
      return rows;
    } catch (error) {
      logger.warn({ err: error, path: csvPath }, 'Brochure catalog: failed to load CSV brochure data');
    }
  }
  return [];
};

const brochureCsvDirectCatalogEnabled = () => {
  const raw = String(process.env.BROCHURE_CATALOG_CSV_DIRECT || '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
};

const brochureRowScopeMatches = (row, link) => {
  const tokens = brochureScopeTokens(link);
  const scope = String(link?.productScope || link?.product_scope || 'all_physician_approved').trim().toLowerCase();
  if (tokens.size === 0 && ['specific_products', 'specific_cart_only'].includes(scope)) return false;
  if (tokens.size === 0 || scope === 'all_physician_approved') return true;
  const sku = String(row?.product_sku || '').trim();
  const parentSku = String(row?.parent_sku || '').trim();
  const name = String(row?.product_name || '').trim();
  const productId = parsePositiveInt(row?.product_id) || parsePositiveInt(row?.parent_product_id);
  const variationId = parsePositiveInt(row?.variation_id);
  const candidates = new Set([
    productId ? String(productId) : '',
    productId ? `woo-${productId}` : '',
    productId ? `woo-product-${productId}` : '',
    productId ? `product-${productId}` : '',
    variationId ? String(variationId) : '',
    variationId ? `woo-${variationId}` : '',
    variationId ? `variation-${variationId}` : '',
    variationId ? `woo-variation-${variationId}` : '',
    normalizeSkuKey(sku),
    normalizeSkuLoose(sku),
    normalizeSkuKey(parentSku),
    normalizeSkuLoose(parentSku),
    name.toLowerCase(),
    normalizeFilterKey(name),
    normalizeSkuLoose(name),
  ].filter(Boolean));
  return [...tokens].some((token) => brochureScopeTokenVariants(token).some((variant) => candidates.has(variant)));
};

const loadBrochureRows = async () => {
  if (!mysqlClient.isEnabled()) return loadBrochureRowsFromCsv();
  return mysqlClient.fetchAll(
    `
      SELECT *
      FROM product_brochure_info
      WHERE COALESCE(TRIM(product_description), '') <> ''
         OR COALESCE(TRIM(product_information), '') <> ''
    `,
  );
};

const buildBrochureMatcher = (rows) => {
  const byExactSku = new Map();
  const byLooseSku = new Map();
  const byExactName = new Map();
  const byLooseName = new Map();
  const byFilterName = new Map();
  const byProductId = new Map();
  const byVariationId = new Map();
  for (const row of rows || []) {
    const sku = String(row?.product_sku || '').trim();
    if (sku) {
      if (!byExactSku.has(normalizeSkuKey(sku))) byExactSku.set(normalizeSkuKey(sku), row);
      if (!byLooseSku.has(normalizeSkuLoose(sku))) byLooseSku.set(normalizeSkuLoose(sku), row);
    }
    const name = String(row?.product_name || '').trim();
    if (name) {
      const exactName = name.toLowerCase();
      const looseName = normalizeSkuLoose(name);
      const filterName = normalizeFilterKey(name);
      if (exactName && !byExactName.has(exactName)) byExactName.set(exactName, row);
      if (looseName && !byLooseName.has(looseName)) byLooseName.set(looseName, row);
      if (filterName && !byFilterName.has(filterName)) byFilterName.set(filterName, row);
    }
    const productId = parsePositiveInt(row?.product_id) || parsePositiveInt(row?.parent_product_id);
    const variationId = parsePositiveInt(row?.variation_id);
    if (productId && !byProductId.has(productId)) byProductId.set(productId, row);
    if (variationId && !byVariationId.has(variationId)) byVariationId.set(variationId, row);
  }
  return {
    byExactSku,
    byLooseSku,
    byExactName,
    byLooseName,
    byFilterName,
    byProductId,
    byVariationId,
    rowCount: Array.isArray(rows) ? rows.length : 0,
  };
};

const matchBrochureRowsForCatalogItem = (item, matcher, { variation = false } = {}) => {
  if (!matcher?.rowCount) return [];
  const matches = [];
  const add = (row) => {
    if (row && !matches.includes(row)) matches.push(row);
  };
  const itemId = parsePositiveInt(item?.id);
  if (itemId && variation && matcher.byVariationId.has(itemId)) add(matcher.byVariationId.get(itemId));
  if (itemId && !variation && matcher.byProductId.has(itemId)) add(matcher.byProductId.get(itemId));
  const sku = String(item?.sku || '').trim();
  if (sku) {
    const bySku = matcher.byExactSku.get(normalizeSkuKey(sku)) || matcher.byLooseSku.get(normalizeSkuLoose(sku));
    add(bySku);
  }
  const name = String(item?.name || '').trim();
  if (name) {
    const byName = matcher.byExactName.get(name.toLowerCase())
      || matcher.byLooseName.get(normalizeSkuLoose(name))
      || matcher.byFilterName.get(normalizeFilterKey(name));
    add(byName);
  }
  return matches;
};

const matchBrochureRowsForProduct = async (product, matcher) => {
  const entries = await matchBrochureRowEntriesForProduct(product, matcher);
  const rows = [];
  for (const entry of entries) {
    if (entry?.row && !rows.includes(entry.row)) rows.push(entry.row);
  }
  return rows;
};

const matchBrochureRowEntriesForProduct = async (product, matcher) => {
  if (!matcher?.rowCount) return [];
  const matches = [];
  const add = (row, item) => {
    if (row && !matches.some((entry) => entry.row === row)) {
      matches.push({ row, item: item || product, product });
    }
  };
  for (const row of matchBrochureRowsForCatalogItem(product, matcher)) add(row, product);
  const productId = parsePositiveInt(product?.id);
  if (productId && String(product?.type || '').toLowerCase() === 'variable') {
    const variations = await wooCommerceClient.fetchCatalog(`products/${productId}/variations`, { per_page: 100, status: 'publish' }).catch(() => []);
    for (const variation of Array.isArray(variations) ? variations : []) {
      for (const row of matchBrochureRowsForCatalogItem(variation, matcher, { variation: true })) add(row, variation);
    }
  }
  return matches;
};

const brochureRowWithCatalogMedia = (row, item = null, product = null) => {
  if (!row) return row;
  const imageUrl = firstProductImage(item) || firstProductImage(product);
  const productId = parsePositiveInt(product?.id)
    || (item && item === product ? parsePositiveInt(item?.id) : null)
    || parsePositiveInt(row?.product_id)
    || parsePositiveInt(row?.parent_product_id);
  const itemId = parsePositiveInt(item?.id);
  const variationId = item && item !== product
    ? itemId || parsePositiveInt(row?.variation_id)
    : parsePositiveInt(row?.variation_id);
  const next = { ...row };
  if (imageUrl && !String(next.image_url || '').trim()) {
    next.image_url = imageUrl;
  }
  if (productId && !parsePositiveInt(next.product_id)) {
    next.product_id = productId;
  }
  if (variationId && !parsePositiveInt(next.variation_id)) {
    next.variation_id = variationId;
  }
  return next;
};

const brochureRowHasCatalogImage = (row) => Boolean(String(row?.image_url || row?.imageUrl || '').trim());

const hydrateBrochureCsvRowsWithCatalogImages = async (rows) => {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (sourceRows.length === 0 || sourceRows.every(brochureRowHasCatalogImage)) {
    return sourceRows;
  }
  const matcher = buildBrochureMatcher(sourceRows);
  if (!matcher.rowCount) return sourceRows;

  const hydrated = new Map(sourceRows.map((row) => [row, row]));
  const unresolvedCount = () => sourceRows.filter((row) => !brochureRowHasCatalogImage(hydrated.get(row))).length;

  try {
    for (let page = 1; page <= 25 && unresolvedCount() > 0; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const products = await wooCommerceClient.fetchCatalog('products', {
        per_page: 100,
        page,
        status: 'publish',
        orderby: 'id',
        order: 'asc',
      }).catch((error) => {
        logger.info(
          { page, status: error?.status || error?.cause?.status },
          'Brochure catalog: unable to hydrate CSV images from Woo products',
        );
        return [];
      });
      const batch = Array.isArray(products) ? products.filter((product) => product && typeof product === 'object') : [];
      if (batch.length === 0) break;

      for (const product of batch) {
        if (unresolvedCount() <= 0) break;
        if (isExcludedCatalogProduct(product)) continue;
        // eslint-disable-next-line no-await-in-loop
        const entries = await matchBrochureRowEntriesForProduct(product, matcher);
        for (const entry of entries) {
          const current = hydrated.get(entry.row) || entry.row;
          hydrated.set(entry.row, brochureRowWithCatalogMedia(current, entry.item, entry.product));
        }
      }
      if (batch.length < 100) break;
    }
  } catch (error) {
    logger.info({ err: error }, 'Brochure catalog: CSV image hydration failed');
  }

  return sourceRows.map((row) => hydrated.get(row) || row);
};

const matchBrochureRow = async (product, matcher) => {
  const matches = await matchBrochureRowsForProduct(product, matcher);
  return matches[0] || null;
};

const filterBrochureCsvRowsForScope = async (rows, link) => {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const tokens = brochureScopeTokens(link);
  const scope = String(link?.productScope || link?.product_scope || 'all_physician_approved').trim().toLowerCase();
  if (tokens.size === 0 && ['specific_products', 'specific_cart_only'].includes(scope)) return [];
  if (tokens.size === 0 || scope === 'all_physician_approved') return sourceRows;

  const selected = new Map();
  const selectRow = (row, item = null, product = null) => {
    if (!row) return;
    const existing = selected.get(row) || row;
    selected.set(row, brochureRowWithCatalogMedia(existing, item, product));
  };
  for (const row of sourceRows.filter((entry) => brochureRowScopeMatches(entry, link))) {
    selectRow(row);
  }
  const productIds = [...new Set([...tokens].map((token) => parsePositiveInt(token)).filter(Boolean))];
  if (productIds.length > 0) {
    const matcher = buildBrochureMatcher(sourceRows);
    const matchedRowGroups = await Promise.all(productIds.map(async (productId) => {
      const product = await wooCommerceClient.fetchCatalog(`products/${productId}`, { status: 'publish' }).catch((error) => {
        logger.info(
          { productId, status: error?.status || error?.cause?.status },
          'Brochure catalog: unable to resolve scoped Woo product for CSV brochure data',
        );
        return null;
      });
      if (!product || typeof product !== 'object') return [];
      return matchBrochureRowEntriesForProduct(product, matcher);
    }));
    for (const matchedEntries of matchedRowGroups) {
      for (const entry of matchedEntries) selectRow(entry.row, entry.item, entry.product);
    }
  }

  const scopedRows = sourceRows.map((row) => selected.get(row)).filter(Boolean);
  if (scopedRows.length === 0) {
    logger.info(
      { scope, tokens: [...tokens].slice(0, 25) },
      'Brochure catalog: CSV scope matched no brochure rows',
    );
  }
  return scopedRows;
};

const coaAvailabilityByProductId = async (productIds) => {
  if (!mysqlClient.isEnabled()) return new Map();
  const ids = [...new Set((productIds || []).map((id) => parsePositiveInt(id)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const params = { kind: 'certificate_of_analysis' };
  const placeholders = ids.map((id, index) => {
    const key = `pid${index}`;
    params[key] = id;
    return `:${key}`;
  });
  const rows = await mysqlClient.fetchAll(
    `
      SELECT woo_product_id, sha256, OCTET_LENGTH(data) AS data_bytes
      FROM product_documents
      WHERE kind = :kind
        AND woo_product_id IN (${placeholders.join(', ')})
    `,
    params,
  );
  const result = new Map();
  for (const row of rows || []) {
    const productId = parsePositiveInt(row?.woo_product_id);
    if (productId) result.set(productId, Boolean(Number(row?.data_bytes || 0) > 0 && String(row?.sha256 || '').trim()));
  }
  return result;
};

const stripHtml = (value) => String(value || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#39;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ')
  .trim();

const csvBrochureCategory = (row) => {
  const sku = String(row?.product_sku || row?.parent_sku || '').trim();
  const name = String(row?.product_name || '').trim();
  if (/(?:^|[\s-])v(?:ial)?$/i.test(name) || /-v$/i.test(sku)) {
    return {
      id: 18,
      name: '10ml Amber Glass Vials w/ Silver Top',
      slug: '10ml-amber-glass-vials-w-silver-top',
    };
  }
  if (/nasal/i.test(name) || /-n$/i.test(sku)) {
    return {
      id: 17,
      name: 'Nasal / Oral Sprays (15ml White Bottle w/ Spray Top)',
      slug: 'nasal-oral-sprays-15ml-white-bottle-w-spray-top',
    };
  }
  return {
    id: null,
    name: 'Product information',
    slug: 'product-information',
  };
};

const brochureDtoFromCsvRow = (row) => {
  const sku = String(row?.product_sku || '').trim();
  const category = csvBrochureCategory(row);
  const imageUrl = String(row?.image_url || row?.imageUrl || '').trim();
  const wooProductId = parsePositiveInt(row?.product_id) || parsePositiveInt(row?.parent_product_id);
  return {
    id: sku ? `csv-${normalizeSkuLoose(sku)}` : `csv-${normalizeFilterKey(row?.product_name) || 'product'}`,
    wooProductId: wooProductId || null,
    sku: sku || null,
    parentSku: String(row?.parent_sku || sku || '').trim() || null,
    name: String(row?.product_name || sku || 'Product').trim(),
    category: category.name,
    categories: [category],
    imageUrl: imageUrl || null,
    productDescription: stripHtml(row?.product_description),
    productInformation: stripHtml(row?.product_information),
    coaAvailable: Boolean(wooProductId),
    documentation: { coaAvailable: Boolean(wooProductId) },
  };
};

const brochureCatalogLocalFallbackEnabled = () => {
  const raw = String(process.env.BROCHURE_CATALOG_WOO_FALLBACK || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  return env.nodeEnv !== 'production' && !mysqlClient.isEnabled();
};

const localBrochureInfoFromProduct = (product) => {
  if (!product || typeof product !== 'object') return null;
  const productId = parsePositiveInt(product?.id);
  const productSku = String(product?.sku || '').trim();
  const category = primaryCategoryName(product);
  const description = stripHtml(product?.short_description || product?.description || '');
  const attributeSummary = (Array.isArray(product?.attributes) ? product.attributes : [])
    .map((attribute) => {
      const name = String(attribute?.name || '').trim();
      const options = Array.isArray(attribute?.options)
        ? attribute.options.map((entry) => String(entry || '').trim()).filter(Boolean).join(', ')
        : '';
      return name && options ? `${name}: ${options}` : '';
    })
    .filter(Boolean)
    .join(' | ');
  const tagSummary = (Array.isArray(product?.tags) ? product.tags : [])
    .map((tag) => String(tag?.name || '').trim())
    .filter(Boolean)
    .join(', ');
  const longDescription = stripHtml(product?.description || '');
  const productInformation = [
    longDescription && longDescription !== description ? longDescription : '',
    attributeSummary,
    tagSummary ? `Focus: ${tagSummary}` : '',
    category ? `Category: ${category}` : '',
  ].map((entry) => String(entry || '').trim()).filter(Boolean).join(' ');
  if (!description && !productInformation) return null;
  return {
    product_name: String(product?.name || '').trim(),
    product_id: productId,
    parent_product_id: productId,
    variation_id: null,
    product_sku: productSku,
    parent_sku: productSku || null,
    product_description: description || null,
    product_information: productInformation || null,
  };
};

const brochureDto = (product, info, coaMap) => {
  const productId = parsePositiveInt(product?.id);
  const productSku = String(product?.sku || '').trim();
  const brochureSku = String(info?.product_sku || '').trim();
  const parentSku = String(info?.parent_sku || productSku || '').trim() || null;
  return {
    id: productId ? `woo-${productId}` : (brochureSku || productSku || String(product?.name || info?.product_name || 'Product').trim()),
    wooProductId: productId || null,
    sku: brochureSku || productSku || null,
    parentSku,
    name: String(product?.name || info?.product_name || 'Product').trim(),
    category: primaryCategoryName(product),
    categories: productCategories(product),
    imageUrl: firstProductImage(product),
    productDescription: String(info?.product_description || '').trim() || null,
    productInformation: String(info?.product_information || '').trim() || null,
    coaAvailable: Boolean(productId && coaMap.get(productId)),
    documentation: { coaAvailable: Boolean(productId && coaMap.get(productId)) },
  };
};

const fetchCatalogSimulationCandidates = async (limit) => {
  const candidates = [];
  const seen = new Set();
  const safeLimit = Math.max(3, Math.min(Number(limit) || 100, 100));

  for (let page = 1; page <= 4 && candidates.length < safeLimit; page += 1) {
    const products = await wooCommerceClient.fetchCatalog('products', {
      per_page: 100,
      page,
      status: 'publish',
      orderby: 'id',
      order: 'asc',
    });
    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      const productId = parsePositiveInt(product?.id);
      if (!productId || seen.has(productId) || isExcludedCatalogProduct(product)) continue;
      seen.add(productId);
      candidates.push({
        productId,
        name: String(product?.name || '').trim(),
      });
      if (candidates.length >= safeLimit) break;
    }

    if (products.length < 100) break;
  }

  return candidates;
};

const buildRecommendations = (user, limit) => {
  const scores = new Map();
  const reasons = new Map();
  const includePeerSimilarity = isDoctorRole(user?.role);
  const primaryReasons = new Set([
    'repeat_purchase',
    'cart_intent',
    'view_intent',
    'category_affinity',
    'tag_affinity',
    ...(includePeerSimilarity ? ['similar_physicians'] : []),
  ]);
  const addScore = (productId, amount, reason) => {
    if (!productId || !Number.isFinite(amount) || amount === 0) return;
    scores.set(productId, (scores.get(productId) || 0) + amount);
    if (!reasons.has(productId)) reasons.set(productId, new Set());
    reasons.get(productId).add(reason);
  };

  const userId = String(user?.id || '').trim();
  const allUsers = userRepository.getAll();
  const roleByUserId = new Map(allUsers.map((entry) => [String(entry?.id || ''), normalizeRole(entry?.role)]));
  const userOrders = orderRepository.findByUserId(userId);
  const purchased = new Set();
  const cartProductIds = new Set();

  for (const order of userOrders) {
    for (const item of orderItems(order)) {
      const productId = itemProductId(item);
      if (!productId) continue;
      purchased.add(productId);
      addScore(productId, 72 + 10 * Math.log1p(itemQuantity(item)), 'repeat_purchase');
    }
  }

  for (const item of Array.isArray(user?.cart) ? user.cart : []) {
    const productId = itemProductId(item);
    if (!productId) continue;
    cartProductIds.add(productId);
    addScore(productId, 82 + 8 * Math.log1p(itemQuantity(item)), 'cart_intent');
  }

  if (includePeerSimilarity) {
    const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const coPurchaseCounts = new Map();
    for (const order of orderRepository.getAll()) {
      const orderUserId = String(order?.userId || order?.user_id || '').trim();
      const role = roleByUserId.get(orderUserId);
      if (role && !isDoctorRole(role)) continue;
      const createdMs = Date.parse(order?.createdAt || order?.created_at || '');
      if (Number.isFinite(createdMs) && createdMs < cutoffMs) continue;
      const productIds = new Set();
      for (const item of orderItems(order)) {
        const productId = itemProductId(item);
        if (!productId) continue;
        productIds.add(productId);
      }
      if (orderUserId && orderUserId !== userId && purchased.size > 0) {
        const overlaps = [...productIds].some((productId) => purchased.has(productId));
        if (overlaps) {
          for (const productId of productIds) {
            if (!purchased.has(productId)) {
              coPurchaseCounts.set(productId, (coPurchaseCounts.get(productId) || 0) + 1);
            }
          }
        }
      }
    }

    for (const [productId, count] of coPurchaseCounts.entries()) {
      addScore(productId, Math.min(72, 28 * Math.log1p(count)), 'similar_physicians');
    }
  }

  const recommendations = [...scores.entries()]
    .filter(([productId, score]) => score > 0 && [...(reasons.get(productId) || [])].some((reason) => primaryReasons.has(reason)))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([productId, score]) => ({
      productId: `woo-${productId}`,
      wooProductId: productId,
      score: Math.round((score + Number.EPSILON) * 1_000_000) / 1_000_000,
      reasons: [...(reasons.get(productId) || [])].sort(),
      modelVersion: MODEL_VERSION,
    }));

  const hasPersonalSignal = purchased.size > 0 || cartProductIds.size > 0;

  return {
    recommendations,
    modelVersion: MODEL_VERSION,
    fallback: !hasPersonalSignal,
    fallbackReason: !hasPersonalSignal ? 'cold_start_no_personal_signals' : null,
  };
};

const buildSimulatedRecommendations = async (user, existingResult, limit) => {
  if (!isSimulationUser(user)) {
    return existingResult;
  }

  const existing = Array.isArray(existingResult?.recommendations)
    ? existingResult.recommendations
    : [];
  const existingIds = new Set(
    existing
      .map((entry) => parsePositiveInt(entry?.wooProductId) || parsePositiveInt(entry?.productId))
      .filter(Boolean),
  );

  const simulationLimit = resolveSimulationLimit(limit);
  const existingTrimmed = existing.slice(0, limit);
  const simulationSlots = Math.max(0, simulationLimit - existingTrimmed.length);
  if (simulationSlots <= 0) {
    return {
      recommendations: existingTrimmed,
      modelVersion: existingResult?.modelVersion || MODEL_VERSION,
      fallback: existingResult?.fallback ?? true,
      fallbackReason: existingResult?.fallbackReason || null,
    };
  }

  const candidates = await fetchCatalogSimulationCandidates(
    Math.min(100, simulationSlots + existingIds.size + 12),
  );
  const simulated = candidates
    .filter((candidate) => !existingIds.has(candidate.productId))
    .slice(0, simulationSlots)
    .map((candidate, index) => ({
      productId: `woo-${candidate.productId}`,
      wooProductId: candidate.productId,
      score: Math.max(50, 415 - index * 22),
      reasons: ['similar_physicians'],
      modelVersion: SIMULATION_MODEL_VERSION,
    }));

  const recommendations = [...existingTrimmed, ...simulated].slice(0, limit);
  return {
    recommendations,
    modelVersion: simulated.length > 0
      ? SIMULATION_MODEL_VERSION
      : (existingResult?.modelVersion || MODEL_VERSION),
    fallback: existingResult?.fallback ?? true,
    fallbackReason: simulated.length > 0
      ? 'node_simulation_for_diggledadiggz'
      : (existingResult?.fallbackReason || null),
  };
};

// Reuse the same proxy as the /api/woo routes so the client can hit /api/catalog
router.get('/recommendations', authenticate, async (req, res, next) => {
  try {
    if (!recommendationsEnabled()) {
      return res.json({ recommendations: [], modelVersion: MODEL_VERSION, fallback: true, fallbackReason: 'disabled' });
    }
    if (!canReadRecommendations(req.user)) {
      return res.status(403).json({ error: 'Recommendation access required' });
    }
    const limit = resolveRecommendationLimit(req.query?.limit);
    const baseRecommendations = buildRecommendations(req.user, limit);
    return res.json(await buildSimulatedRecommendations(req.user, baseRecommendations, limit));
  } catch (error) {
    return next(error);
  }
});

router.post('/events', authenticate, (req, res) => {
  const eventType = String(req.body?.eventType || req.body?.event || '').trim();
  if (!eventType) {
    return res.status(400).json({ error: 'eventType is required' });
  }
  if (!canReadRecommendations(req.user)) {
    return res.status(403).json({ error: 'Recommendation access required' });
  }
  return res.status(201).json({ ok: true, tracked: false, eventType });
});

router.get('/brochure-products', async (req, res, next) => {
  try {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'private, no-store');
    const token = String(req.query?.token || req.query?.brochure || req.query?.delegate || '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });

    const link = await resolveBrochureCatalogLink(token);
    if (!link) {
      return res.status(404).json({ error: 'Invalid or expired brochure link.' });
    }

    const allowLocalFallback = brochureCatalogLocalFallbackEnabled();
    if (!mysqlClient.isEnabled() && !allowLocalFallback) {
      return res.status(503).json({ error: 'MySQL is required for brochure catalog.' });
    }
    const brochureRows = await loadBrochureRows();
    if (!mysqlClient.isEnabled() && brochureCsvDirectCatalogEnabled() && brochureRows.some((row) => row?.source === 'csv')) {
      const scopedRows = await filterBrochureCsvRowsForScope(brochureRows, link);
      const hydratedRows = await hydrateBrochureCsvRowsWithCatalogImages(scopedRows);
      const products = hydratedRows.map((row) => brochureDtoFromCsvRow(row));
      return res.json({
        products,
        capabilities: link.capabilities,
        linkType: 'brochure',
        source: 'csv',
      });
    }
    const matcher = buildBrochureMatcher(brochureRows);
    const productList = [];
    for (let page = 1; page <= 25; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const products = await wooCommerceClient.fetchCatalog('products', {
        per_page: 100,
        page,
        status: 'publish',
        orderby: 'id',
        order: 'asc',
      });
      const batch = Array.isArray(products) ? products.filter((product) => product && typeof product === 'object') : [];
      productList.push(...batch);
      if (batch.length < 100) break;
    }
    const coaMap = await coaAvailabilityByProductId(productList.map((product) => product.id));
    const items = [];
    const unmatched = [];
    for (const product of productList) {
      if (isExcludedCatalogProduct(product) || !brochureScopeMatches(product, link)) continue;
      // eslint-disable-next-line no-await-in-loop
      const info = await matchBrochureRow(product, matcher) || (allowLocalFallback ? localBrochureInfoFromProduct(product) : null);
      if (!info) {
        const sku = String(product?.sku || product?.id || product?.name || '').trim();
        if (sku) unmatched.push(sku);
        continue;
      }
      items.push(brochureDto(product, info, coaMap));
    }
    if (unmatched.length > 0) {
      logger.info(
        { count: unmatched.length, sampleSkus: unmatched.slice(0, 25) },
        'Brochure catalog: products missing brochure copy',
      );
    }
    return res.json({
      products: items,
      capabilities: link.capabilities,
      linkType: 'brochure',
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/media', wooController.proxyMedia);

router.use(wooController.proxyCatalog);

module.exports = router;
module.exports.__test__ = {
  resolveRecommendationLimit,
  resolveSimulationLimit,
  brochureScopeMatches,
  findLocalLinkByTokenFromState,
  parseCsvText,
  normalizeBrochureCsvRows,
  loadBrochureRowsFromCsv,
  brochureRowScopeMatches,
  filterBrochureCsvRowsForScope,
  hydrateBrochureCsvRowsWithCatalogImages,
  brochureDtoFromCsvRow,
  buildBrochureMatcher,
  matchBrochureRow,
  localBrochureInfoFromProduct,
  brochureDto,
};
