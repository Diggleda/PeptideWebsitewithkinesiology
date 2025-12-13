import { API_BASE_URL } from "../services/api";

const shouldProxyMedia =
  String(import.meta.env?.VITE_PROXY_WOO_MEDIA || "").toLowerCase() === "true";

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
