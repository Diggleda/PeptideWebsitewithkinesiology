import { API_BASE_URL } from "../services/api";

// Default ON because Woo media often sets restrictive CORP/CORS headers that block
// cross-site image loads (e.g. peppro.net -> shop.peppro.net). Disable explicitly if needed.
const shouldProxyMedia =
  String(import.meta.env?.VITE_PROXY_WOO_MEDIA || "").toLowerCase() !== "false";

const apiBase = API_BASE_URL.replace(/\/+$/, "");

export const proxifyWooMediaUrl = (url?: string | null): string | null => {
  if (!url) {
    return null;
  }
  if (!shouldProxyMedia) {
    return url;
  }
  return `${apiBase}/woo/media?src=${encodeURIComponent(url)}`;
};
