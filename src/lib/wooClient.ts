import { API_BASE_URL } from '../services/api';

const DEFAULT_PHP_PROXY = '/api/woo.php';
const DEFAULT_PROXY_TOKEN = 'a-long-random-string-to-serve-as-proxy-token';
const WOO_DISABLED = String((import.meta as any).env?.VITE_WOO_DISABLED || '').toLowerCase() === 'true';
const WOO_DEBUG =
  String((import.meta as any).env?.VITE_WOO_DEBUG || '').toLowerCase() === 'true';
const WOO_REQUEST_TIMEOUT_MS = (() => {
  const raw = String((import.meta as any).env?.VITE_WOO_REQUEST_TIMEOUT_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 30000;
})();

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
  if (WOO_DISABLED) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[WooCommerce] Frontend Woo access is disabled via VITE_WOO_DISABLED');
    }
    // @ts-ignore
    return (Array.isArray([]) ? [] : {}) as T;
  }
  const url = buildURL(endpoint, params);
  const safeUrlForLogging = (() => {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', 'REDACTED');
      }
      return parsed.toString();
    } catch {
      return url;
    }
  })();
  const startedAt = Date.now();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller
    ? globalThis.setTimeout(() => controller.abort(), WOO_REQUEST_TIMEOUT_MS)
    : null;
  try {
    if (WOO_DEBUG) {
      console.info('[Woo] GET', { endpoint, url: safeUrlForLogging, params });
    }
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (WOO_DEBUG) {
      console.info('[Woo] GET complete', {
        endpoint,
        status: res.status,
        durationMs: Date.now() - startedAt,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Woo ${endpoint} failed: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
  } catch (error: any) {
    if (WOO_DEBUG) {
      const message =
        typeof error?.message === 'string' && error.message.trim().length > 0
          ? error.message
          : 'Unknown error';
      console.warn('[Woo] GET failed', {
        endpoint,
        url: safeUrlForLogging,
        message,
        durationMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    if (timeoutId) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

// Example domain functions
export const listProducts = <T = unknown>(opts: QueryParams = {}) =>
  WOO_DISABLED ? (Promise.resolve([]) as unknown as Promise<T>) : wooGet<T>('products', { per_page: 12, status: 'publish', ...opts });

export const listCategories = <T = unknown>(opts: QueryParams = {}) =>
  WOO_DISABLED ? (Promise.resolve([]) as unknown as Promise<T>) : wooGet<T>('products/categories', { per_page: 50, ...opts });

export const listProductVariations = <T = unknown>(productId: number, opts: QueryParams = {}) =>
  WOO_DISABLED ? (Promise.resolve([]) as unknown as Promise<T>) : wooGet<T>(`products/${productId}/variations`, { per_page: 100, status: 'publish', ...opts });

export const getProduct = <T = unknown>(productId: number | string, opts: QueryParams = {}) =>
  WOO_DISABLED ? (Promise.resolve(null) as unknown as Promise<T>) : wooGet<T>(`products/${productId}`, { ...opts });

export type { QueryParams };
