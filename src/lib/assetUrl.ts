const STATIC_ASSET_STAMP =
  String((import.meta as any).env?.VITE_FRONTEND_BUILD_ID || "").trim() || "";

const NON_STAMPABLE_URL_PATTERN = /^(?:data|blob|javascript|mailto|tel|about|file):/i;

const EMITTED_PUBLIC_ASSET_URLS: Record<string, string> = {
  "/PepPro_fulllogo.png": new URL("../generated/runtime-assets/PepPro_fulllogo.png", import.meta.url).href,
  "/PepPro_icon.png": new URL("../generated/runtime-assets/PepPro_icon.png", import.meta.url).href,
  "/leafTexture.jpg": new URL("../generated/runtime-assets/leafTexture.jpg", import.meta.url).href,
  "/icons/handshake_4233584.png": new URL("../generated/runtime-assets/icons/handshake_4233584.png", import.meta.url).href,
  "/logos/woocommerce.svg": new URL("../generated/runtime-assets/logos/woocommerce.svg", import.meta.url).href,
  "/logos/shipstation.svg": new URL("../generated/runtime-assets/logos/shipstation.svg", import.meta.url).href,
  "/peppro-favicon-v3.ico": new URL("../generated/runtime-assets/peppro-favicon-v3.ico", import.meta.url).href,
  "/peppro-favicon-v3-32x32.png": new URL("../generated/runtime-assets/peppro-favicon-v3-32x32.png", import.meta.url).href,
  "/peppro-favicon-v3-16x16.png": new URL("../generated/runtime-assets/peppro-favicon-v3-16x16.png", import.meta.url).href,
  "/peppro-apple-touch-icon-v3.png": new URL("../generated/runtime-assets/peppro-apple-touch-icon-v3.png", import.meta.url).href,
};

const splitUrlParts = (value: string) => {
  const match = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] || value,
    search: match?.[2] || "",
    hash: match?.[3] || "",
  };
};

const appendQueryParam = (value: string, key: string, paramValue: string) => {
  const { pathname, search, hash } = splitUrlParts(value);
  const suffix = `${encodeURIComponent(key)}=${encodeURIComponent(paramValue)}`;
  const nextSearch = search ? `${search}&${suffix}` : `?${suffix}`;
  return `${pathname}${nextSearch}${hash}`;
};

export const resolveStaticAssetUrl = (path: string): string => {
  const normalized = String(path || "").trim();
  if (!normalized) return normalized;
  const { pathname, search, hash } = splitUrlParts(normalized);
  const resolvedPath = EMITTED_PUBLIC_ASSET_URLS[pathname] || pathname;
  return `${resolvedPath}${search}${hash}`;
};

export const withStaticAssetStamp = (path: string): string => {
  const resolved = resolveStaticAssetUrl(path);
  if (!resolved || !STATIC_ASSET_STAMP) return resolved;
  if (NON_STAMPABLE_URL_PATTERN.test(resolved)) return resolved;
  return appendQueryParam(resolved, "v", STATIC_ASSET_STAMP);
};
