import { API_BASE_URL } from '../services/api';

const DEFAULT_PHP_PROXY = '/api/woo.php';
const DEFAULT_PROXY_TOKEN = 'a-long-random-string-to-serve-as-proxy-token';

const resolveProxyBase = () => {
  const configuredProxy = ((import.meta.env.VITE_WOO_PROXY_URL as string | undefined) || '').trim();
  if (configuredProxy) {
    return configuredProxy;
  }

  if (API_BASE_URL) {
    const normalizedApiBase = API_BASE_URL.replace(/\/+$/, '');
    return `${normalizedApiBase}/woo`;
  }

  return DEFAULT_PHP_PROXY;
};

const WOO_PROXY = resolveProxyBase();
const WOO_TOKEN = ((import.meta.env.VITE_WOO_PROXY_TOKEN as string | undefined) || DEFAULT_PROXY_TOKEN).trim();
const isPhpProxy = /\.php($|\?)/i.test(WOO_PROXY);

const getWindowOrigin = () => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost';
};

const isAbsoluteUrl = (value: string) => /^https?:\/\//i.test(value);

const toAbsoluteUrl = (value: string) => {
  if (isAbsoluteUrl(value)) {
    return new URL(value);
  }
  return new URL(value, getWindowOrigin());
};

type QueryParams = Record<string, string | number | boolean | undefined>;

const stringifyParams = (params: QueryParams = {}) =>
  Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value === undefined || value === null) {
      return acc;
    }

    if (typeof value === 'boolean') {
      acc[key] = value ? 'true' : 'false';
      return acc;
    }

    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        acc[key] = String(value);
      }
      return acc;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      acc[key] = value;
    }
    return acc;
  }, {});

function buildURL(endpoint: string, params: QueryParams = {}): string {
  const sanitizedEndpoint = endpoint.replace(/^\/+/, '');
  const query = stringifyParams(params);

  if (isPhpProxy) {
    const url = toAbsoluteUrl(WOO_PROXY);
    if (WOO_TOKEN) {
      url.searchParams.set('token', WOO_TOKEN);
    }
    url.searchParams.set('endpoint', sanitizedEndpoint);
    if (Object.keys(query).length > 0) {
      url.searchParams.set('q', new URLSearchParams(query).toString());
    }
    return url.toString();
  }

  const base = WOO_PROXY.replace(/\/+$/, '');
  const url = toAbsoluteUrl(`${base}/${sanitizedEndpoint}`);
  Object.entries(query).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}

export async function wooGet<T = unknown>(endpoint: string, params: QueryParams = {}): Promise<T> {
  const res = await fetch(buildURL(endpoint, params), { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Woo ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Example domain functions
export const listProducts = <T = unknown>(opts: QueryParams = {}) =>
  wooGet<T>('products', { per_page: 12, status: 'publish', ...opts });

export const listCategories = <T = unknown>(opts: QueryParams = {}) =>
  wooGet<T>('products/categories', { per_page: 50, ...opts });

export const listProductVariations = <T = unknown>(productId: number, opts: QueryParams = {}) =>
  wooGet<T>(`products/${productId}/variations`, { per_page: 100, status: 'publish', ...opts });

export type { QueryParams };
