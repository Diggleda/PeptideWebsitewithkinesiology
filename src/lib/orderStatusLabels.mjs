const normalizeStatusToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const humanizeStatus = (value) =>
  String(value || "")
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");

export const formatOrderStatusLabel = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const normalized = normalizeStatusToken(raw);
  if (!normalized) return null;

  if (normalized === "trash" || normalized === "canceled" || normalized === "cancelled") {
    return "Canceled";
  }
  if (normalized === "refunded") {
    return "Refunded";
  }
  if (normalized === "on_hold" || normalized === "onhold") {
    return "On-Hold";
  }
  if (normalized === "processing") {
    return "Processing";
  }
  if (
    normalized === "label_created" ||
    normalized === "awaiting_shipment" ||
    normalized === "awaiting" ||
    normalized.includes("shipment_ready_for_ups") ||
    normalized.includes("shipment_information_received") ||
    normalized.includes("information_received") ||
    normalized.includes("billing_information_received")
  ) {
    return "Label Created";
  }
  if (normalized.includes("out_for_delivery") || normalized.includes("outfordelivery")) {
    return "Out for Delivery";
  }
  if (
    normalized.includes("in_transit") ||
    normalized.includes("intransit") ||
    normalized.includes("on_the_way") ||
    normalized.includes("ontheway")
  ) {
    return "In transit";
  }
  if (normalized.includes("delivered")) {
    return "Delivered";
  }
  if (normalized === "completed" || normalized === "complete" || normalized === "shipped") {
    return "Shipped";
  }
  if (
    normalized.includes("exception") ||
    normalized.includes("delay") ||
    normalized.includes("held") ||
    normalized.includes("hold") ||
    normalized.includes("error")
  ) {
    return "Exception";
  }

  return humanizeStatus(raw);
};
