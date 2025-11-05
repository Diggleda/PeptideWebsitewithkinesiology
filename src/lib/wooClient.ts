const WOO_PROXY = '/api/woo.php';
const WOO_TOKEN = 'a-long-random-string-to-serve-as-proxy-token'; // must match server

type QueryParams = Record<string, string | number | boolean | undefined>;

function buildURL(endpoint: string, params: QueryParams = {}): string {
  const url = new URL(WOO_PROXY, window.location.origin);
  url.searchParams.set('token', WOO_TOKEN);
  url.searchParams.set('endpoint', endpoint.replace(/^\/+/, ''));
  if (params && Object.keys(params).length) {
    const query = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
        if (value !== undefined && value !== null) {
          acc[key] = String(value);
        }
        return acc;
      }, {}),
    ).toString();
    url.searchParams.set('q', query);
  }
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

export type { QueryParams };
