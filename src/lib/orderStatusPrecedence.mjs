const normalizeStatusToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const AUTHORITATIVE_ORDER_STATUSES = new Set([
  "refunded",
  "cancelled",
  "canceled",
  "trash",
  "completed",
  "complete",
  "processing",
  "pending",
  "on_hold",
  "failed",
  "delegation_draft",
]);

export const isMeaningfulShippingStatus = (value) => {
  const normalized = normalizeStatusToken(value);
  if (!normalized) return false;
  return (
    normalized.includes("out_for_delivery") ||
    normalized.includes("in_transit") ||
    normalized.includes("delivered") ||
    normalized === "shipped" ||
    normalized === "awaiting_shipment"
  );
};

export const shouldDisplayShippingStatusForOrder = (orderStatus, shippingStatus) => {
  const normalizedShipping = normalizeStatusToken(shippingStatus);
  if (!normalizedShipping) return false;

  const normalizedOrder = normalizeStatusToken(orderStatus);
  if (!normalizedOrder) {
    return true;
  }

  if (isMeaningfulShippingStatus(normalizedShipping)) {
    return true;
  }

  return !AUTHORITATIVE_ORDER_STATUSES.has(normalizedOrder);
};
