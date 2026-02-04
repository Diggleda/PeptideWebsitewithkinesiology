const STATIC_ASSET_STAMP =
  String((import.meta as any).env?.VITE_FRONTEND_BUILD_ID || "").trim() || "";

export const withStaticAssetStamp = (path: string): string => {
  const normalized = String(path || "").trim();
  if (!normalized) return normalized;
  if (!STATIC_ASSET_STAMP) return normalized;
  return normalized.includes("?")
    ? `${normalized}&v=${encodeURIComponent(STATIC_ASSET_STAMP)}`
    : `${normalized}?v=${encodeURIComponent(STATIC_ASSET_STAMP)}`;
};

