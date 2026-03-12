export const RESEARCH_SUPPLY_DISCLOSURES = [
  'PepPro provides research materials only. Products are not intended for human consumption.',
  'PepPro does not provide prescriptions, treatment, dosing, therapy, or patient instructions.',
  'Physicians are responsible for any independent research protocols.',
  'PepPro does not direct or control physician activities.',
];

const normalizeToken = (value?: string | null) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const slugify = (value?: string | null) => {
  const text = typeof value === 'string' ? value.trim() : '';
  const normalized = text
    .toLowerCase()
    .replace(/^dr\.?\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'research';
};

export const buildResearchSupplyLinkUrl = (
  origin: string,
  token?: string | null,
  doctorName?: string | null,
) => {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return '';
  const slug = slugify(doctorName);
  return `${origin.replace(/\/+$/, '')}/research/${slug}/${encodeURIComponent(normalizedToken)}`;
};

export const readDelegateTokenFromLocation = (location: Location): string | null => {
  const fromQuery = normalizeToken(new URLSearchParams(location.search).get('delegate'));
  if (fromQuery) return fromQuery;
  const pathname = (location.pathname || '').replace(/\/+$/, '');
  const match = pathname.match(/^\/research\/[^/]+\/([^/]+)$/i);
  if (!match || !match[1]) return null;
  try {
    return normalizeToken(decodeURIComponent(match[1]));
  } catch {
    return normalizeToken(match[1]);
  }
};

export const normalizeAllowedProductsInput = (value: string): string[] => {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  return value
    .replace(/\n/g, ',')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
};

export const formatAllowedProductsInput = (value: unknown): string => {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .join(', ');
};

export const productMatchesAllowedSku = (
  product: { sku?: string | null; wooId?: number; variants?: Array<{ sku?: string | null }> } | null | undefined,
  allowedProducts: string[],
) => {
  if (!product || !Array.isArray(allowedProducts) || allowedProducts.length === 0) {
    return true;
  }
  const allowed = new Set(allowedProducts.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean));
  const productSku = typeof product.sku === 'string' ? product.sku.trim().toUpperCase() : '';
  if (productSku && allowed.has(productSku)) return true;
  const wooId = Number.isFinite(Number(product.wooId)) ? String(product.wooId).trim().toUpperCase() : '';
  if (wooId && allowed.has(wooId)) return true;
  for (const variant of product.variants || []) {
    const variantSku = typeof variant?.sku === 'string' ? variant.sku.trim().toUpperCase() : '';
    if (variantSku && allowed.has(variantSku)) return true;
  }
  return false;
};

export const physicianCompensationDisclosure = (markupPercent?: number | null) =>
  Number(markupPercent || 0) > 0
    ? 'Your physician receives compensation from this transaction.'
    : 'Your physician does not receive compensation from this PepPro transaction.';
