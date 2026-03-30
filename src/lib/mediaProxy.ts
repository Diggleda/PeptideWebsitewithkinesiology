import { API_BASE_URL } from "../services/api";

// Default ON because Woo media often sets restrictive CORP/CORS headers that block
// cross-site image loads (e.g. peppro.net -> shop.peppro.net). Disable explicitly if needed.
const shouldProxyMedia =
  String(import.meta.env?.VITE_PROXY_WOO_MEDIA || "").toLowerCase() !== "false";

const apiBase = API_BASE_URL.replace(/\/+$/, "");
const WOO_MEDIA_PROXY_PATH_PATTERN = /\/woo\/media$/i;
const proxyParseBase =
  typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin
    ? window.location.origin
    : "https://peppro.net";

const unwrapWooMediaProxySource = (value?: string | null): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value.trim();
  if (!candidate) {
    return null;
  }

  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate.startsWith("//")) {
      candidate = `https:${candidate}`;
    }
    if (/^http:\/\//i.test(candidate)) {
      candidate = candidate.replace(/^http:\/\//i, "https://");
    }

    try {
      const parsed = new URL(candidate, proxyParseBase);
      if (!WOO_MEDIA_PROXY_PATH_PATTERN.test(parsed.pathname)) {
        break;
      }
      const nestedSource = parsed.searchParams.get("src");
      if (typeof nestedSource !== "string" || !nestedSource.trim() || nestedSource.trim() === candidate) {
        break;
      }
      candidate = nestedSource.trim();
    } catch {
      break;
    }
  }

  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }
  if (/^http:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^http:\/\//i, "https://");
  }
  return candidate || null;
};

export const proxifyWooMediaUrl = (url?: string | null): string | null => {
  const source = unwrapWooMediaProxySource(url);
  if (!source) {
    return null;
  }
  if (!shouldProxyMedia) {
    return source;
  }
  if (/^(data|blob):/i.test(source) || source.startsWith("/")) {
    return source;
  }
  if (!/^https?:\/\//i.test(source)) {
    return source;
  }
  return `${apiBase}/woo/media?src=${encodeURIComponent(source)}`;
};
