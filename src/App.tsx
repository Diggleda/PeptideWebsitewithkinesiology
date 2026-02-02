import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  FormEvent,
  ReactNode,
  Fragment,
  forwardRef,
} from "react";
import { computeUnitPrice, type PricingMode } from "./lib/pricing";
import { Header } from "./components/Header";
import { FeaturedSection } from "./components/FeaturedSection";
import { ProductCard } from "./components/ProductCard";
import type { Product as CardProduct } from "./components/ProductCard";
import type { Product, ProductVariant, BulkPricingTier } from "./types/product";
import { CategoryFilter } from "./components/CategoryFilter";
import { CheckoutModal } from "./components/CheckoutModal";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { toast } from "sonner@2.0.3";
import {
	  ShoppingCart,
	  Eye,
	  EyeOff,
	  ArrowRight,
	  ArrowLeft,
		  ChevronRight,
		  RefreshCw,
		  ArrowUpDown,
		  Fingerprint,
		  ExternalLink,
		  CalendarDays,
			  Loader2,
			  Plus,
				  Package,
				  Upload,
			  Download,
			  NotebookPen,
			  CheckSquare,
			  Trash2,
			} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type DateRange } from "react-day-picker";
import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  LabelList,
} from "recharts@2.15.2";
	import {
	  authAPI,
	  ordersAPI,
	  trackingAPI,
	  referralAPI,
	  newsAPI,
	  quotesAPI,
	  forumAPI,
	  wooAPI,
	  checkServerHealth,
	  passwordResetAPI,
	  settingsAPI,
	  API_BASE_URL,
	} from "./services/api";
import { getTabId, isTabLeader, releaseTabLeadership } from "./lib/tabLocks";
import { ProductDetailDialog } from "./components/ProductDetailDialog";
import { LegalFooter } from "./components/LegalFooter";
import { AuthActionResult } from "./types/auth";
import {
  DoctorCreditSummary,
  ReferralRecord,
  SalesRepDashboard,
  CreditLedgerEntry,
} from "./types/referral";
	import {
	  listProducts,
	  listCategories,
	  listProductVariations,
	  getProduct,
	} from "./lib/wooClient";
import { proxifyWooMediaUrl } from "./lib/mediaProxy";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  detectConditionalPasskeySupport,
  detectPlatformPasskeySupport,
} from "./lib/passkeys";
import {
  requestStoredPasswordCredential,
  storePasswordCredential,
} from "./lib/passwordCredential";

interface User {
  id: string;
  name: string;
  email: string;
  profileImageUrl?: string | null;
  hasPasskeys?: boolean;
  referralCode?: string | null;
  npiNumber?: string | null;
  npiLastVerifiedAt?: string | null;
  npiVerification?: {
    name?: string | null;
    credential?: string | null;
    enumerationType?: string | null;
    primaryTaxonomy?: string | null;
    organizationName?: string | null;
  } | null;
  role: "doctor" | "sales_rep" | "admin" | "test_doctor" | string;
  salesRepId?: string | null;
  salesRep?: {
    id: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  referrerDoctorId?: string | null;
  phone?: string | null;
  officeAddressLine1?: string | null;
  officeAddressLine2?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
  officePostalCode?: string | null;
  referralCredits?: number;
  totalReferrals?: number;
  mustResetPassword?: boolean;
}

interface ContactFormSubmission {
  id: number;
  name: string;
  email: string;
  phone: string;
  source: string;
  created_at: string;
}

// Feature flags for passkey UX. Defaults keep prompts manual-only.
const PASSKEY_AUTOPROMPT =
  String(
    (import.meta as any).env?.VITE_PASSKEY_AUTOPROMPT || "",
  ).toLowerCase() === "true";
const PASSKEY_AUTOREGISTER =
  String(
    (import.meta as any).env?.VITE_PASSKEY_AUTOREGISTER || "",
  ).toLowerCase() === "true";

const normalizeRole = (role?: string | null) =>
  (role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
const isAdmin = (role?: string | null) => normalizeRole(role) === "admin";
const isSalesLead = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return (
    normalized !== "admin" &&
    (normalized === "sales_lead" ||
      normalized === "saleslead" ||
      normalized === "sales-lead")
  );
};
const isRep = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return (
    normalized !== "admin" &&
    (normalized === "sales_rep" ||
      normalized === "rep" ||
      normalized === "sales_lead" ||
      normalized === "saleslead" ||
      normalized === "sales-lead")
  );
};
const isTestDoctor = (role?: string | null) =>
  normalizeRole(role) === "test_doctor";
const isDoctorRole = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized === "doctor" || normalized === "test_doctor";
};

const noop = () => {};

const isPageVisible = () => {
  if (typeof document === "undefined") return true;
  return !document.hidden;
};

const isOnline = () => {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
};

interface CartItem {
  id: string;
  product: Product;
  quantity: number;
  note?: string;
  variant?: ProductVariant | null;
}

interface FilterState {
  categories: string[];
  types: string[];
}

type WooImage = { src?: string | null };
type WooCategory = { id: number; name: string };
type WooMeta = { key?: string | null; value?: unknown };
type WooAttribute = {
  id?: number;
  name?: string | null;
  option?: string | null;
};
type WooVariationAttribute = {
  id?: number;
  name?: string | null;
  option?: string | null;
};

interface WooVariation {
  id: number;
  price?: string;
  regular_price?: string;
  stock_status?: string;
  stock_quantity?: number | null;
  image?: WooImage | null;
  attributes?: WooVariationAttribute[];
  description?: string | null;
  sku?: string | null;
  meta_data?: WooMeta[];
  tiered_pricing_fixed_rules?: Record<string, unknown> | null;
}

interface WooProduct {
  id: number;
  name: string;
  price?: string;
  regular_price?: string;
  price_html?: string;
  images?: WooImage[];
  categories?: WooCategory[];
  stock_status?: string;
  stock_quantity?: number | null;
  average_rating?: string;
  rating_count?: number;
  sku?: string;
  type?: string;
  short_description?: string;
  description?: string;
  meta_data?: WooMeta[];
  attributes?: WooAttribute[];
  default_attributes?: WooVariationAttribute[];
  variations?: number[];
}

interface PeptideNewsItem {
  title: string;
  url: string;
  summary?: string;
  image?: string;
  date?: string;
}

interface AccountOrderLineItem {
  id?: string | null;
  name?: string | null;
  quantity?: number | null;
  total?: number | null;
  price?: number | null;
  sku?: string | null;
  productId?: string | number | null;
  variantId?: string | number | null;
  image?: string | null;
}

interface AccountOrderAddress {
  name?: string | null;
  company?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface AccountShippingEstimate {
  carrierId?: string | null;
  serviceCode?: string | null;
  serviceType?: string | null;
  estimatedDeliveryDays?: number | null;
  deliveryDateGuaranteed?: string | null;
  rate?: number | null;
  currency?: string | null;
  packageCode?: string | null;
  packageDimensions?: { length?: number | null; width?: number | null; height?: number | null } | null;
  weightOz?: number | null;
  estimatedArrivalDate?: string | null;
  meta?: Record<string, any> | null;
}

interface CarrierTrackingInfo {
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingStatus?: string | null;
  trackingStatusRaw?: string | null;
  deliveredAt?: string | null;
  checkedAt?: string | null;
}

interface AccountOrderSummary {
  id: string;
  number?: string | null;
  trackingNumber?: string | null;
  shippingCarrier?: string | null;
  shippingService?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
  grandTotal?: number | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  source: "local" | "woocommerce" | "peppro";
  doctorId?: string | null;
  doctorName?: string | null;
  doctorEmail?: string | null;
  doctorProfileImageUrl?: string | null;
  lineItems?: AccountOrderLineItem[];
  integrations?: Record<string, string | null> | null;
  paymentMethod?: string | null;
  paymentDetails?: string | null;
  integrationDetails?: Record<string, any> | null;
  shippingAddress?: AccountOrderAddress | null;
  billingAddress?: AccountOrderAddress | null;
  shippingEstimate?: AccountShippingEstimate | null;
  shippingTotal?: number | null;
  taxTotal?: number | null;
  physicianCertified?: boolean | null;
  wooOrderNumber?: string | null;
  wooOrderId?: string | null;
  cancellationId?: string | null;
  expectedShipmentWindow?: string | null;
}

const humanizeAccountOrderStatus = (status?: string | null): string => {
  if (!status) return "Pending";
  const normalized = status.trim().toLowerCase();
  if (normalized === "trash") return "Canceled";
  return status
    .split(/[_\s]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
};

const formatPepProPaymentMethodLabel = (value?: string | null): string | null => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");

  if (normalized.includes("zelle")) return "Zelle";
  if (
    normalized === "bacs" ||
    normalized === "bank_transfer" ||
    normalized === "direct_bank_transfer" ||
    normalized.includes("direct_bank_transfer") ||
    normalized.includes("direct_bank") ||
    normalized.includes("bank_transfer") ||
    normalized.includes("banktransfer")
  ) {
    return "Direct Bank Transfer";
  }
  if (normalized.includes("stripe")) return "Card payment";

  return raw;
};

const parseMaybeJson = (value: any) => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

const buildTrackingUrl = (tracking: string, carrier?: string | null) => {
  if (!tracking) return null;
  const code = (carrier || "").toLowerCase();
  const encoded = encodeURIComponent(tracking);
  if (code.includes("ups")) return `https://www.ups.com/track?loc=en_US&tracknum=${encoded}`;
  if (code.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  if (code.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (code.includes("dhl")) return `https://www.dhl.com/en/express/tracking.html?AWB=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
};

const resolveTrackingNumber = (order: any): string | null => {
  if (!order) return null;

  const orderLabel =
    order?.number ||
    order?.id ||
    order?.wooOrderNumber ||
    order?.orderNumber ||
    "unknown";

  let tracking: string | null = null;

  const direct =
    order?.trackingNumber ||
    order?.tracking_number ||
    order?.tracking ||
    null;
  if (direct) {
    tracking = String(direct);
  }

  if (!tracking) {
    const integrations = parseMaybeJson(order.integrationDetails || order.integrations);
    const shipStation = parseMaybeJson(integrations?.shipStation || integrations?.shipstation);

    const shipStationDirect =
      shipStation?.trackingNumber ||
      shipStation?.tracking_number ||
      shipStation?.tracking ||
      null;
    if (shipStationDirect) {
      tracking = String(shipStationDirect);
    }

    if (!tracking) {
      const shipments =
        shipStation?.shipments ||
        shipStation?.shipment ||
        shipStation?.data?.shipments ||
        [];

      if (Array.isArray(shipments)) {
        const pickTracking = (entry: any) =>
          entry?.trackingNumber || entry?.tracking_number || entry?.tracking || null;
        const nonVoided = shipments.find(
          (entry) => entry && entry.voided === false && pickTracking(entry),
        );
        const anyEntry = shipments.find((entry) => entry && pickTracking(entry));
        const candidate = nonVoided || anyEntry;
        if (candidate) {
          tracking = String(pickTracking(candidate));
        }
      }
    }
  }

  if (tracking) {
    console.info("[Tracking] Resolved tracking number", { order: orderLabel, tracking });
    return tracking;
  }

  return null;
};

const resolveSalesOrderStatusSource = (
  order?: AccountOrderSummary | null,
): string | null => {
  if (!order) return null;
  const normalizedOrderStatus = String(order.status || "").trim().toLowerCase();
  if (
    normalizedOrderStatus === "refunded" ||
    normalizedOrderStatus === "cancelled" ||
    normalizedOrderStatus === "canceled" ||
    normalizedOrderStatus === "trash"
  ) {
    const status = String(order.status || "").trim();
    return status.length > 0 ? status : null;
  }
  const integrations = parseMaybeJson(order.integrationDetails || order.integrations);
  const shipStation = parseMaybeJson(integrations?.shipStation || integrations?.shipstation);
  const carrierTracking = parseMaybeJson(
    integrations?.carrierTracking ||
      integrations?.carrier_tracking ||
      integrations?.trackingDetails ||
      integrations?.tracking_details,
  );
  const shipments =
    shipStation?.shipments || shipStation?.shipment || shipStation?.data?.shipments || [];
  const shipStationStatus =
    shipStation?.status ||
    (Array.isArray(shipments)
      ? (() => {
          const candidate = shipments.find(
            (entry: any) =>
              entry &&
              (entry?.status ||
                entry?.shipmentStatus ||
                entry?.shipment_status ||
                entry?.trackingStatus ||
                entry?.tracking_status ||
                entry?.deliveryStatus ||
                entry?.delivery_status),
          );
          return (
            (candidate as any)?.status ||
            (candidate as any)?.shipmentStatus ||
            (candidate as any)?.shipment_status ||
            (candidate as any)?.trackingStatus ||
            (candidate as any)?.tracking_status ||
            (candidate as any)?.deliveryStatus ||
            (candidate as any)?.delivery_status ||
            null
          );
        })()
      : null);
  const carrierTrackingStatus =
    carrierTracking?.trackingStatus ||
    carrierTracking?.tracking_status ||
    carrierTracking?.status ||
    carrierTracking?.deliveryStatus ||
    carrierTracking?.delivery_status ||
    null;
  const shippingStatus =
    (order.shippingEstimate as any)?.status || carrierTrackingStatus || shipStationStatus;
  const candidate = shippingStatus || order.status || null;
  if (!candidate) return null;
  const str = String(candidate).trim();
  return str.length > 0 ? str : null;
};

const resolveSalesOrderShippingStatus = (
  order?: AccountOrderSummary | null,
): string | null => {
  if (!order) return null;
  const integrations = parseMaybeJson(order.integrationDetails || order.integrations);
  const shipStation = parseMaybeJson(integrations?.shipStation || integrations?.shipstation);
  const carrierTracking = parseMaybeJson(
    integrations?.carrierTracking ||
      integrations?.carrier_tracking ||
      integrations?.trackingDetails ||
      integrations?.tracking_details,
  );
  const shipments =
    shipStation?.shipments || shipStation?.shipment || shipStation?.data?.shipments || [];
  const carrierTrackingStatus =
    carrierTracking?.trackingStatus ||
    carrierTracking?.tracking_status ||
    carrierTracking?.status ||
    carrierTracking?.deliveryStatus ||
    carrierTracking?.delivery_status ||
    null;
  const direct =
    (order.shippingEstimate as any)?.status ||
    carrierTrackingStatus ||
    shipStation?.status ||
    null;
  if (direct) return String(direct).trim() || null;
  if (!Array.isArray(shipments)) return null;
  const candidate = shipments.find(
    (entry: any) =>
      entry &&
      (entry?.status ||
        entry?.shipmentStatus ||
        entry?.shipment_status ||
        entry?.trackingStatus ||
        entry?.tracking_status ||
        entry?.deliveryStatus ||
        entry?.delivery_status),
  );
  const value =
    (candidate as any)?.status ||
    (candidate as any)?.shipmentStatus ||
    (candidate as any)?.shipment_status ||
    (candidate as any)?.trackingStatus ||
    (candidate as any)?.tracking_status ||
    (candidate as any)?.deliveryStatus ||
    (candidate as any)?.delivery_status ||
    null;
  return value ? String(value).trim() || null : null;
};

const describeSalesOrderStatus = (
  order?: AccountOrderSummary | null,
): string => {
  const raw = resolveSalesOrderStatusSource(order);
  const statusRaw = raw ? String(raw) : "";
  const normalized = statusRaw.trim().toLowerCase();
  const shippingStatusRaw = resolveSalesOrderShippingStatus(order);
  const shippingNormalized = shippingStatusRaw
    ? String(shippingStatusRaw).trim().toLowerCase()
    : "";
  if (
    normalized === "trash" ||
    normalized === "canceled" ||
    normalized === "cancelled"
  ) {
    return "Canceled";
  }
  if (normalized === "refunded") {
    return "Refunded";
  }

  if (
    shippingNormalized.includes("out_for_delivery") ||
    shippingNormalized.includes("out-for-delivery")
  ) {
    return "Out for Delivery";
  }
  if (
    shippingNormalized.includes("in_transit") ||
    shippingNormalized.includes("in-transit")
  ) {
    return "In Transit";
  }
  if (shippingNormalized.includes("delivered")) {
    return "Delivered";
  }

  const tracking =
    typeof (order as any)?.trackingNumber === "string"
      ? String((order as any).trackingNumber).trim()
      : "";
  const eta = (order?.shippingEstimate as any)?.estimatedArrivalDate || null;
  const hasEta = typeof eta === "string" && eta.trim().length > 0;

  if (normalized === "shipped") {
    return tracking ? "Shipped" : "Shipped";
  }
  if (
    normalized.includes("out_for_delivery") ||
    normalized.includes("out-for-delivery")
  ) {
    return "Out for Delivery";
  }
  if (
    normalized.includes("in_transit") ||
    normalized.includes("in-transit")
  ) {
    return "In Transit";
  }
  if (normalized.includes("delivered")) {
    return "Delivered";
  }

  if (tracking) return "Shipped";
  if (normalized === "processing") {
    return "Order Received";
  }
  if (normalized === "completed" || normalized === "complete") {
    return "Shipped";
  }
  if (normalized === "awaiting_shipment" || normalized === "awaiting shipment") {
    return "Order Received";
  }

  if (!raw) return "Pending";
  return humanizeAccountOrderStatus(raw);
};

const VARIATION_CACHE_STORAGE_KEY = "peppro_variation_cache_v2";

const normalizeAddressPart = (value?: string | null) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const hasSavedAddress = (address?: AccountOrderAddress | null) => {
  if (!address) {
    return false;
  }
  return Boolean(
    normalizeAddressPart(address.addressLine1) ||
    normalizeAddressPart(address.city) ||
    normalizeAddressPart(address.state) ||
    normalizeAddressPart(address.postalCode),
  );
};

const sanitizeAccountAddress = (
  address?: AccountOrderAddress | null,
  fallbackName?: string | null,
): AccountOrderAddress | undefined => {
  if (!address && !fallbackName) {
    return undefined;
  }
  return {
    name:
      normalizeAddressPart(address?.name) || normalizeAddressPart(fallbackName),
    company: normalizeAddressPart(address?.company),
    addressLine1: normalizeAddressPart(address?.addressLine1),
    addressLine2: normalizeAddressPart(address?.addressLine2),
    city: normalizeAddressPart(address?.city),
    state: normalizeAddressPart(address?.state),
    postalCode: normalizeAddressPart(address?.postalCode),
    country: normalizeAddressPart(address?.country) || "US",
    phone: normalizeAddressPart(address?.phone),
    email: normalizeAddressPart(address?.email),
  };
};

const getInitials = (name?: string | null) => {
  if (!name) return "Dr";
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};

const buildShippingAddressFromUserProfile = (
  user?: User | null,
): AccountOrderAddress | undefined => {
  if (!user) {
    return undefined;
  }
  const candidate: AccountOrderAddress = {
    name: user.name || user.npiVerification?.name || null,
    addressLine1: user.officeAddressLine1 || null,
    addressLine2: user.officeAddressLine2 || null,
    city: user.officeCity || null,
    state: user.officeState || null,
    postalCode: user.officePostalCode || null,
    country: "US",
  };
  return hasSavedAddress(candidate)
    ? sanitizeAccountAddress(candidate)
    : undefined;
};

const deriveShippingAddressFromOrders = (
  orders: AccountOrderSummary[],
  fallbackName?: string | null,
): AccountOrderAddress | undefined => {
  if (!orders || orders.length === 0) {
    return undefined;
  }
  for (const order of orders) {
    if (hasSavedAddress(order.shippingAddress)) {
      return sanitizeAccountAddress(order.shippingAddress, fallbackName);
    }
    if (hasSavedAddress(order.billingAddress)) {
      return sanitizeAccountAddress(order.billingAddress, fallbackName);
    }
  }
  return undefined;
};

const WOO_PLACEHOLDER_IMAGE = "/Peppro_IconLogo_Transparent_NoBuffer.png";

const normalizeWooImageUrl = (value?: string | null): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  let candidate = value.trim();
  if (!candidate) {
    return null;
  }
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }
  if (/^http:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^http:\/\//i, "https://");
  }
  try {
    const url = new URL(candidate);
    url.protocol = "https:";
    url.pathname = url.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");
    return proxifyWooMediaUrl(url.toString());
  } catch (_error) {
    return proxifyWooMediaUrl(candidate);
  }
};

const RESET_PASSWORD_ROUTE = "/reset-password";

const normalizePathname = (pathname?: string | null) => {
  if (!pathname) {
    return "/";
  }
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
};

const isResetPasswordRoute = () =>
  typeof window !== "undefined" &&
  normalizePathname(window.location.pathname) === RESET_PASSWORD_ROUTE;

const readResetTokenFromLocation = () => {
  if (typeof window === "undefined") {
    return null;
  }
  return new URLSearchParams(window.location.search).get("token");
};

const getInitialLandingMode = (): "login" | "signup" | "forgot" | "reset" =>
  isResetPasswordRoute() ? "reset" : "login";

const getInitialResetToken = () =>
  isResetPasswordRoute() ? readResetTokenFromLocation() : null;

const coerceNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeIdField = (
  value: unknown,
): string | number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const resolveLineImageUrl = (item: any): string | null => {
  const candidates = [
    item?.image,
    item?.imageUrl,
    item?.image_url,
    item?.thumbnail,
    item?.thumb,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object") {
      const source =
        candidate.src ||
        candidate.url ||
        candidate.href ||
        candidate.source;
      if (typeof source === "string" && source.trim().length > 0) {
        return source.trim();
      }
    }
  }

  const metadata = Array.isArray(item?.meta_data)
    ? item.meta_data
    : Array.isArray(item?.meta)
      ? item.meta
      : [];
  for (const entry of metadata) {
    const value = entry?.value;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (value && typeof value === "object") {
      const source =
        value.src || value.url || value.href || value.source;
      if (typeof source === "string" && source.trim().length > 0) {
        return source.trim();
      }
    }
  }
  return null;
};

const toOrderLineItems = (items: any): AccountOrderLineItem[] => {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const quantity = coerceNumber(item?.quantity);
      const price = coerceNumber(item?.price);
      const total =
        coerceNumber(item?.total) ??
        (price && quantity ? price * quantity : undefined);
      return {
        id: item?.id ? String(item.id) : undefined,
        name: typeof item?.name === "string" ? item.name : null,
        quantity: quantity ?? null,
        total: total ?? null,
        price: price ?? null,
        sku:
          typeof item?.sku === "string" && item.sku.trim().length > 0
            ? item.sku.trim()
            : null,
        productId: normalizeIdField(
          item?.productId ?? item?.product_id ?? item?.wooProductId,
        ),
        variantId: normalizeIdField(
          item?.variantId ??
            item?.variation_id ??
            item?.wooVariationId,
        ),
        image: resolveLineImageUrl(item),
      };
    })
    .filter((line) => line.name);
};

const normalizeStringField = (value: unknown) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const sanitizeOrderAddress = (address: any): AccountOrderAddress | null => {
  if (!address || typeof address !== "object") {
    return null;
  }
  const first =
    normalizeStringField(address.first_name) ||
    normalizeStringField(address.firstName);
  const last =
    normalizeStringField(address.last_name) ||
    normalizeStringField(address.lastName);
  const fallbackName = [first, last].filter(Boolean).join(" ").trim() || null;

  return {
    name: normalizeStringField(address.name) || fallbackName,
    company: normalizeStringField(address.company),
    addressLine1:
      normalizeStringField(address.addressLine1) ||
      normalizeStringField(address.address_1),
    addressLine2:
      normalizeStringField(address.addressLine2) ||
      normalizeStringField(address.address_2),
    city: normalizeStringField(address.city),
    state: normalizeStringField(address.state),
    postalCode:
      normalizeStringField(address.postalCode) ||
      normalizeStringField(address.postcode),
    country: normalizeStringField(address.country),
    phone: normalizeStringField(address.phone),
    email: normalizeStringField(address.email),
  };
};

const normalizeShippingEstimateField = (
  estimate: any,
  options?: { fallbackDate?: string | null },
): AccountShippingEstimate | null => {
  if (!estimate || typeof estimate !== "object") {
    return null;
  }
  const normalizeDateToIso = (value?: string | null) => {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  };
  const normalizeDimensionNumber = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return Math.round(numeric * 100) / 100;
  };
  const normalizeDimensions = (value: any) => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const length =
      normalizeDimensionNumber(value.length) ??
      normalizeDimensionNumber(value.lengthIn) ??
      normalizeDimensionNumber(value.l);
    const width =
      normalizeDimensionNumber(value.width) ??
      normalizeDimensionNumber(value.widthIn) ??
      normalizeDimensionNumber(value.w);
    const height =
      normalizeDimensionNumber(value.height) ??
      normalizeDimensionNumber(value.heightIn) ??
      normalizeDimensionNumber(value.h);
    if (!length || !width || !height) {
      return null;
    }
    return { length, width, height };
  };
  const fallbackDate = options?.fallbackDate || null;
  const packageDimensions =
    normalizeDimensions(estimate.packageDimensions) ||
    normalizeDimensions(estimate.dimensions);
  const normalized = {
    carrierId: estimate.carrierId || estimate.carrier_id || null,
    serviceCode: estimate.serviceCode || estimate.service_code || null,
    serviceType: estimate.serviceType || estimate.service_type || null,
    estimatedDeliveryDays: Number.isFinite(
      Number(estimate.estimatedDeliveryDays),
    )
      ? Number(estimate.estimatedDeliveryDays)
      : null,
    deliveryDateGuaranteed:
      estimate.deliveryDateGuaranteed || estimate.delivery_date || null,
    rate: coerceNumber(estimate.rate) ?? null,
    currency: typeof estimate.currency === "string" ? estimate.currency : null,
    estimatedArrivalDate:
      typeof estimate.estimatedArrivalDate === "string"
        ? normalizeDateToIso(estimate.estimatedArrivalDate)
        : typeof estimate.estimated_arrival_date === "string"
          ? normalizeDateToIso(estimate.estimated_arrival_date)
          : null,
    packageCode:
      estimate.packageCode ||
      estimate.package_code ||
      estimate.packageType ||
      null,
    packageDimensions,
    weightOz: coerceNumber(estimate.weightOz) ?? null,
    meta:
      typeof estimate.meta === "object" && estimate.meta !== null
        ? estimate.meta
        : null,
  };
  if (!normalized.estimatedArrivalDate && normalized.deliveryDateGuaranteed) {
    normalized.estimatedArrivalDate = normalizeDateToIso(
      normalized.deliveryDateGuaranteed,
    );
  }
  if (
    !normalized.estimatedArrivalDate &&
    normalized.estimatedDeliveryDays &&
    Number.isFinite(normalized.estimatedDeliveryDays) &&
    normalized.estimatedDeliveryDays > 0 &&
    typeof fallbackDate === "string"
  ) {
    const base = new Date(fallbackDate);
    if (!Number.isNaN(base.getTime())) {
      const projected = new Date(base.getTime());
      projected.setDate(
        projected.getDate() + Number(normalized.estimatedDeliveryDays),
      );
      normalized.estimatedArrivalDate = projected.toISOString();
    }
  }
  const hasData = Object.values(normalized).some(
    (value) => value !== null && value !== undefined,
  );
  return hasData ? normalized : null;
};

const normalizeWooOrderNumberKey = (value?: string | null) => {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/^#/, "").trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
};

const normalizeWooOrderId = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    const match = trimmed.match(/(\d+)/);
    if (match) {
      return match[1];
    }
  }
  return null;
};

const resolveWooOrderIdFromIntegrations = (order: any): string | null => {
  if (!order) {
    return null;
  }
  const integrations =
    order.integrationDetails?.wooCommerce ||
    order.integrationDetails?.woocommerce ||
    {};
  const response = integrations.response || {};
  const payload = integrations.payload || {};
  const candidates = [
    order.wooOrderId,
    order.woo_order_id,
    integrations.wooOrderId,
    integrations.woo_order_id,
    response.id,
    response.orderId,
    payload.id,
    payload.orderId,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWooOrderId(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const mergeIntegrationDetails = (
  localDetails?: Record<string, any> | null,
  wooDetails?: Record<string, any> | null,
): Record<string, any> | null => {
  if (!localDetails && !wooDetails) {
    return null;
  }
  if (!localDetails) {
    return wooDetails ? { ...wooDetails } : null;
  }
  if (!wooDetails) {
    return localDetails;
  }
  return {
    ...wooDetails,
    ...localDetails,
    wooCommerce: {
      ...(localDetails.wooCommerce || {}),
      ...(wooDetails.wooCommerce || {}),
    },
  };
};

const mergeWooSummaryIntoLocal = (
  localOrder: AccountOrderSummary,
  wooOrder: AccountOrderSummary,
) => {
  localOrder.status = wooOrder.status || localOrder.status;
  localOrder.total =
    typeof wooOrder.total === "number" ? wooOrder.total : localOrder.total;
  localOrder.currency = wooOrder.currency || localOrder.currency;
  localOrder.number = wooOrder.number || localOrder.number;
  localOrder.wooOrderNumber =
    wooOrder.wooOrderNumber || wooOrder.number || localOrder.wooOrderNumber;
  localOrder.updatedAt = wooOrder.updatedAt || localOrder.updatedAt;
  if (typeof localOrder.notes !== "string" && typeof wooOrder.notes === "string") {
    localOrder.notes = wooOrder.notes;
  }

  if (!hasSavedAddress(localOrder.shippingAddress) && hasSavedAddress(wooOrder.shippingAddress)) {
    localOrder.shippingAddress = wooOrder.shippingAddress;
  }
  if (!hasSavedAddress(localOrder.billingAddress) && hasSavedAddress(wooOrder.billingAddress)) {
    localOrder.billingAddress = wooOrder.billingAddress;
  }
  if (!localOrder.shippingEstimate && wooOrder.shippingEstimate) {
    localOrder.shippingEstimate = wooOrder.shippingEstimate;
  }
  if (typeof wooOrder.shippingTotal === "number") {
    localOrder.shippingTotal = wooOrder.shippingTotal;
  }
  if (typeof wooOrder.taxTotal === "number") {
    localOrder.taxTotal = wooOrder.taxTotal;
  }
  if (!localOrder.lineItems?.length && wooOrder.lineItems?.length) {
    localOrder.lineItems = wooOrder.lineItems;
  }
  localOrder.paymentMethod = localOrder.paymentMethod || wooOrder.paymentMethod;
  localOrder.paymentDetails = localOrder.paymentDetails || wooOrder.paymentDetails;
  localOrder.integrationDetails = mergeIntegrationDetails(
    localOrder.integrationDetails,
    wooOrder.integrationDetails,
  );
  if (!localOrder.wooOrderId && wooOrder.wooOrderId) {
    localOrder.wooOrderId = wooOrder.wooOrderId;
  }
  if (!localOrder.cancellationId) {
    localOrder.cancellationId =
      wooOrder.cancellationId ||
      wooOrder.wooOrderId ||
      localOrder.wooOrderId ||
      localOrder.id;
  }
};

const normalizeAccountOrdersResponse = (
  payload: any,
  options?: { includeCanceled?: boolean },
): AccountOrderSummary[] => {
  const includeCanceled = options?.includeCanceled ?? false;
  const result: AccountOrderSummary[] = [];
  const localById = new Map<string, AccountOrderSummary>();
  const localByWooNumber = new Map<string, AccountOrderSummary>();
  const shouldIncludeStatus = (status?: string | null) => {
    if (!status) return true;
    const normalized = String(status).trim().toLowerCase();
    const isCanceledOrRefunded =
      normalized === "trash" ||
      normalized.includes("cancel") ||
      normalized.includes("refund");
    return includeCanceled || !isCanceledOrRefunded;
  };

  const registerLocalEntry = (entry: AccountOrderSummary) => {
    result.push(entry);
    if (entry.id) {
      localById.set(String(entry.id), entry);
    }
    const wooKey = normalizeWooOrderNumberKey(
      entry.wooOrderNumber ||
        entry.integrationDetails?.wooCommerce?.response?.number ||
        entry.integrationDetails?.wooCommerce?.wooOrderNumber ||
        entry.number,
    );
    if (wooKey) {
      localByWooNumber.set(wooKey, entry);
    }
  };

  if (payload && Array.isArray(payload.local)) {
    payload.local
      .filter((order: any) => shouldIncludeStatus(order?.status))
      .forEach((order: any) => {
        const identifier = order?.id
          ? String(order.id)
          : `local-${Math.random().toString(36).slice(2, 10)}`;
        const wooOrderId =
          normalizeWooOrderId(order?.wooOrderId) ||
          normalizeWooOrderId(order?.woo_order_id) ||
          resolveWooOrderIdFromIntegrations(order);
        const cancellationId = wooOrderId || identifier;
        registerLocalEntry({
          id: identifier,
          number: order?.number || identifier,
          trackingNumber: resolveTrackingNumber(order),
          status:
            order?.status === "trash" ? "canceled" : order?.status || "pending",
          currency: order?.currency || "USD",
          total: coerceNumber(order?.grandTotal ?? order?.total) ?? null,
          grandTotal: coerceNumber(order?.grandTotal ?? order?.total) ?? null,
          notes: typeof order?.notes === "string" ? order.notes : null,
          createdAt: order?.createdAt || null,
          updatedAt: order?.updatedAt || null,
          source: "peppro",
          lineItems: toOrderLineItems(
            order?.items || order?.lineItems || order?.line_items,
          ),
          integrations: order?.integrations || null,
          paymentMethod: order?.paymentMethod || null,
          paymentDetails:
            order?.paymentDetails ||
            (order?.integrationDetails?.stripe?.cardLast4
              ? `${order.integrationDetails?.stripe?.cardBrand || "Card"} •••• ${order.integrationDetails.stripe.cardLast4}`
              : order?.paymentMethod || null),
          integrationDetails: order?.integrationDetails || null,
          shippingAddress: sanitizeOrderAddress(
            order?.shippingAddress || order?.shipping_address || order?.shipping,
          ),
          billingAddress: sanitizeOrderAddress(
            order?.billingAddress || order?.billing_address || order?.billing,
          ),
          shippingEstimate: normalizeShippingEstimateField(
            order?.shippingEstimate || order?.shipping_estimate,
            { fallbackDate: order?.createdAt || null },
          ),
          shippingTotal: coerceNumber(order?.shippingTotal) ?? null,
          taxTotal: coerceNumber(order?.taxTotal) ?? null,
          physicianCertified: order?.physicianCertified === true,
          wooOrderNumber:
            normalizeStringField(
              order?.wooOrderNumber ||
                order?.integrationDetails?.wooCommerce?.response?.number ||
                order?.integrationDetails?.wooCommerce?.wooOrderNumber,
            ) || null,
          wooOrderId: wooOrderId || null,
          cancellationId,
        });
      });
  }

  if (payload && Array.isArray(payload.woo)) {
    payload.woo
      .filter((order: any) => shouldIncludeStatus(order?.status))
      .forEach((order: any) => {
        const identifier = order?.id
          ? String(order.id)
          : order?.number
            ? `woo-${order.number}`
            : `woo-${Math.random().toString(36).slice(2, 10)}`;
        const wooEntry: AccountOrderSummary = {
          id: identifier,
          number: order?.number || identifier,
          trackingNumber: resolveTrackingNumber(order),
          wooOrderNumber: normalizeStringField(order?.number),
          wooOrderId:
            normalizeWooOrderId(order?.id) ||
            normalizeWooOrderId(order?.wooOrderId) ||
            null,
          status:
            order?.status === "trash" ? "canceled" : order?.status || "pending",
          currency: order?.currency || "USD",
          total: coerceNumber(order?.grandTotal ?? order?.total) ?? null,
          grandTotal: coerceNumber(order?.grandTotal ?? order?.total) ?? null,
          notes: typeof order?.notes === "string" ? order.notes : null,
          createdAt:
            order?.createdAt ||
            order?.dateCreated ||
            order?.date_created ||
            null,
          updatedAt:
            order?.updatedAt ||
            order?.dateModified ||
            order?.date_modified ||
            null,
          source: "woocommerce",
          lineItems: toOrderLineItems(
            order?.lineItems || order?.line_items || order?.items,
          ),
          integrations: order?.integrations || null,
          paymentMethod: order?.paymentMethod || null,
          paymentDetails:
            normalizeStringField(order?.paymentDetails) ||
            normalizeStringField(order?.paymentMethod) ||
            null,
          integrationDetails: order?.integrationDetails || null,
          shippingAddress: sanitizeOrderAddress(
            order?.shippingAddress || order?.shipping || order?.shipping_address,
          ),
          billingAddress: sanitizeOrderAddress(
            order?.billingAddress || order?.billing || order?.billing_address,
          ),
          shippingEstimate: normalizeShippingEstimateField(
            order?.shippingEstimate || order?.shipping_estimate,
            {
              fallbackDate:
                order?.createdAt ||
                order?.dateCompleted ||
                order?.date_created ||
                null,
            },
          ),
          shippingTotal:
            coerceNumber(order?.shippingTotal ?? order?.shipping_total) ?? null,
          taxTotal:
            coerceNumber(
              order?.taxTotal ?? order?.total_tax ?? order?.totalTax,
            ) ?? null,
          physicianCertified: order?.physicianCertified === true,
          cancellationId:
            normalizeWooOrderId(order?.id) ||
            normalizeWooOrderId(order?.number) ||
            identifier,
        };
        const pepproOrderId = normalizeStringField(
          order?.integrationDetails?.wooCommerce?.pepproOrderId,
        );
        const wooKey = normalizeWooOrderNumberKey(wooEntry.wooOrderNumber);
        const localMatch =
          (pepproOrderId && localById.get(pepproOrderId)) ||
          (wooKey && localByWooNumber.get(wooKey));
        if (localMatch) {
          mergeWooSummaryIntoLocal(localMatch, wooEntry);
        } else {
          result.push(wooEntry);
        }
      });
  }

  return result.sort((a, b) => {
    const tsA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tsB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tsB - tsA;
  });
};

const normalizeHumanName = (value: string) =>
  (value || "").replace(/\s+/g, " ").trim().toLowerCase();

const HONORIFIC_TOKENS = new Set([
  "mr",
  "mrs",
  "ms",
  "mx",
  "dr",
  "prof",
  "sir",
  "madam",
]);
const SUFFIX_TOKENS = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const tokenizeName = (value: string) =>
  normalizeHumanName(value)
    .split(" ")
    .map((token) => token.replace(/[.,]/g, ""))
    .filter(
      (token) =>
        token && !HONORIFIC_TOKENS.has(token) && !SUFFIX_TOKENS.has(token),
    );

const namesRoughlyMatch = (a: string, b: string) => {
  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (!tokensA.length || !tokensB.length) {
    return false;
  }
  if (tokensA.join(" ") === tokensB.join(" ")) {
    return true;
  }
  const firstA = tokensA[0];
  const lastA = tokensA[tokensA.length - 1];
  const firstB = tokensB[0];
  const lastB = tokensB[tokensB.length - 1];
  if (!firstA || !lastA || !firstB || !lastB) {
    return false;
  }
  if (firstA !== firstB || lastA !== lastB) {
    return false;
  }
  const middleA = tokensA.slice(1, -1).join(" ");
  const middleB = tokensB.slice(1, -1).join(" ");
  if (!middleA || !middleB) {
    return true;
  }
  return middleA === middleB;
};

const PEPTIDE_NEWS_PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23B7D8F9'/%3E%3Cstop offset='100%25' stop-color='%2395C5F9'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='120' height='120' rx='16' fill='url(%23grad)'/%3E%3Cpath d='M35 80l15-18 12 14 11-12 12 16' stroke='%23ffffff' stroke-width='5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='44' cy='43' r='9' fill='none' stroke='%23ffffff' stroke-width='5'/%3E%3C/svg%3E";

const MIN_NEWS_LOADING_MS = 600;
const LOGIN_KEEPALIVE_INTERVAL_MS = 60000;
const CATALOG_RETRY_DELAY_MS = 4000;
const CATALOG_RETRY_FAST_DELAY_MS = 900;
const CATALOG_EMPTY_RESULT_RETRY_MAX = 3;
const CATALOG_EMPTY_RESULT_RETRY_DELAY_MS = 1200;
const CATALOG_POLL_INTERVAL_MS = 5 * 60 * 1000; // quietly refresh Woo catalog every 5 minutes
const CATALOG_EMPTY_STATE_GRACE_MS = 4500;
const CATALOG_DEBUG =
  String((import.meta as any).env?.VITE_CATALOG_DEBUG || "").toLowerCase() ===
  "true";
const FRONTEND_BUILD_ID =
  String((import.meta as any).env?.VITE_FRONTEND_BUILD_ID || "").trim() ||
  "v2.1.10";
const CATALOG_PAGE_CONCURRENCY = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_CATALOG_PAGE_CONCURRENCY || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, 1), 4);
  }
  return 3;
})();

if (typeof window !== "undefined") {
  (window as any).__PEPPRO_BUILD__ = FRONTEND_BUILD_ID;
}
const VARIANT_PREFETCH_CONCURRENCY = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_VARIANT_PREFETCH_CONCURRENCY || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, 1), 12);
  }
  return 1;
})();

// Disabled by default in production to avoid hammering the store/backend when Woo is degraded.
// Enable only when explicitly opted-in via env.
const BACKGROUND_VARIANT_PREFETCH_ENABLED = (() => {
  const enabled =
    String((import.meta as any).env?.VITE_BACKGROUND_VARIANT_PREFETCH || "")
      .toLowerCase()
      .trim() === "true";
  if (!enabled) return false;
  // Extra guardrail: require explicit opt-in in production builds.
  if ((import.meta as any).env?.PROD) {
    return (
      String((import.meta as any).env?.VITE_ALLOW_BACKGROUND_VARIANT_PREFETCH || "")
        .toLowerCase()
        .trim() === "true"
    );
  }
  return true;
})();
const BACKGROUND_VARIANT_PREFETCH_START_DELAY_MS = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_BACKGROUND_VARIANT_PREFETCH_START_DELAY_MS || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 1500;
})();
const BACKGROUND_VARIANT_PREFETCH_DELAY_MS = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_BACKGROUND_VARIANT_PREFETCH_DELAY_MS || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 650;
})();

const VARIANT_POLL_INTERVAL_MS = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_VARIANT_POLL_INTERVAL_MS || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 30000;
})();

const REFERRAL_BACKGROUND_MIN_INTERVAL_MS = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_REFERRAL_BACKGROUND_MIN_INTERVAL_MS || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 30_000;
})();

const IMAGE_PREFETCH_ENABLED =
  String((import.meta as any).env?.VITE_IMAGE_PREFETCH_ENABLED || "")
    .toLowerCase()
    .trim() !== "false";
const IMAGE_PREFETCH_CONCURRENCY = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_IMAGE_PREFETCH_CONCURRENCY || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, 1), 12);
  }
  return 4;
})();
const IMAGE_PREFETCH_DELAY_MS = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_IMAGE_PREFETCH_DELAY_MS || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 150;
})();

const SALES_REP_PIPELINE = [
  {
    key: "pending_combined",
    label: "Pending",
    statuses: ["pending", "contact_form"],
  },
  {
    key: "contacted",
    label: "Contacting",
    statuses: ["contacted"],
  },
  {
    key: "verified",
    label: "Verified",
    statuses: ["verified", "verifying"],
  },
  {
    key: "account_created",
    label: "Account Created",
    statuses: ["account_created"],
  },
  {
    key: "converted",
    label: "Converted",
    statuses: ["converted"],
  },
  {
    key: "nuture",
    label: "Nuturing",
    statuses: ["nuture"],
  },
];

const REFERRAL_STATUS_FLOW = [
  { key: "pending", label: "Pending" },
  { key: "contacted", label: "Contacting" },
  { key: "verified", label: "Verified" },
  { key: "account_created", label: "Account Created" },
  { key: "converted", label: "Converted" },
  { key: "nuture", label: "Nuturing" },
];
const REFERRAL_STATUS_FLOW_SELECT = REFERRAL_STATUS_FLOW.filter(
  (stage) => stage.key !== "nuture",
);
const REFERRAL_LEAD_STATUS_KEYS = new Set(
  REFERRAL_STATUS_FLOW.filter((stage) => stage.key !== "pending").map(
    (stage) => stage.key,
  ),
);
const REFERRAL_STATUS_SET = new Set([
  ...REFERRAL_STATUS_FLOW.map((stage) => stage.key),
  "contact_form",
]);
const sanitizeReferralStatus = (status?: string | null): string => {
  const normalized = (status || "").toLowerCase().trim();
  if (normalized === "verifying") {
    return "verified";
  }
  if (REFERRAL_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return "pending";
};

const toTitleCase = (value?: string | null): string | null => {
  if (!value) return value ?? null;
  const words = value
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    );
  return words.join(" ") || null;
};

const CONTACT_FORM_STATUS_FLOW = [
  { key: "contact_form", label: "Pending" },
  { key: "contacted", label: "Contacting" },
  { key: "verified", label: "Verified" },
  { key: "account_created", label: "Account Created" },
  { key: "converted", label: "Converted" },
  { key: "nuture", label: "Nuturing" },
];
const CONTACT_FORM_STATUS_FLOW_SELECT = CONTACT_FORM_STATUS_FLOW.filter(
  (stage) => stage.key !== "nuture",
);

const MANUAL_PROSPECT_DELETE_VALUE = "__manual_delete__";

const wrapPipelineLabel = (label: string, maxLength = 12): string[] => {
  if (!label) return [];
  const words = label
    .replace(/\//g, " / ")
    .split(" ")
    .filter(Boolean);
  const lines: string[] = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
      }
      current = word;
    }
  });
  if (current) {
    lines.push(current);
  }
  return lines;
};

const PipelineTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
}) => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const entry = payload[0]?.payload || {};
  const names = Array.isArray(entry.names) ? entry.names : [];
  const count = Number(entry.count) || 0;
  const maxNames = 10;
  const visibleNames = names.slice(0, maxNames);
  const remaining = names.length - visibleNames.length;
  return (
    <div className="pipeline-tooltip max-w-[260px] rounded-xl border border-slate-200/90 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur-lg">
      <div className="text-sm font-semibold text-slate-900">{label}</div>
      <div className="text-[11px] text-slate-500">
        {count} lead{count === 1 ? "" : "s"}
      </div>
      {visibleNames.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1 text-[11px] text-slate-700">
          {visibleNames.map((name: string) => (
            <li key={name} className="truncate">
              {name}
            </li>
          ))}
          {remaining > 0 && (
            <li className="text-slate-500">+{remaining} more</li>
          )}
        </ul>
      )}
    </div>
  );
};

const PipelineXAxisTick = ({
  x = 0,
  y = 0,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value: string };
}) => {
  const lines = wrapPipelineLabel(payload?.value || "");
  const lineHeight = 14;
  const startY = y + 12 - ((lines.length - 1) * lineHeight) / 2;
  return (
    <g transform={`translate(${x},${startY})`}>
      <text textAnchor="middle" fill="#334155" fontSize={12}>
        {lines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={0} dy={index === 0 ? 0 : lineHeight}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
};

const humanizeReferralStatus = (status?: string) => {
  if (!status) {
    return "Unknown";
  }
  const normalized = status.toLowerCase().trim();
  const match = REFERRAL_STATUS_FLOW.find((stage) => stage.key === normalized);
  if (match) {
    return match.label;
  }
  if (normalized === "contact_form") {
    return "Pending";
  }
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const stripHtml = (value?: string | null): string =>
  value
    ? value
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

const formatDateInputValue = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getDefaultSalesBySalesRepPeriod = (
  now: Date = new Date(),
): { start: string; end: string } => {
  const year = now.getFullYear();
  const month = now.getMonth();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const midpointDay = Math.ceil(daysInMonth / 2);
  const startDay = dayOfMonth <= midpointDay ? 1 : midpointDay;
  const start = formatDateInputValue(new Date(year, month, startDay));
  const end = formatDateInputValue(now);
  return { start, end };
};

const formatNewsDate = (dateString?: string | null): string => {
  if (!dateString) return "";
  const raw = dateString.trim();
  try {
    // Try generic Date parsing (covers RFC-2822 like: Mon, 27 Oct 2025 00:00:00 +0000)
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) {
      dt.setDate(dt.getDate() + 1);
      return dt.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    // Parse ISO date string (YYYY-MM-DD)
    const parts = raw.split("-");
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
      const day = parseInt(parts[2], 10);
      const date = new Date(year, month, day);
      if (!Number.isNaN(date.getTime())) {
        date.setDate(date.getDate() + 1);
        return date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      }
    }

    // Fallback: strip time segment if present and keep day+month+year
    const rfc = raw.match(/^([A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/);
    if (rfc) return rfc[1];

    const tIndex = raw.indexOf("T");
    if (tIndex > 0) {
      const ymd = raw.slice(0, tIndex);
      const ymdParts = ymd.split("-");
      if (ymdParts.length === 3) {
        const y = parseInt(ymdParts[0], 10);
        const m = parseInt(ymdParts[1], 10) - 1;
        const d = parseInt(ymdParts[2], 10);
        const d2 = new Date(y, m, d);
        if (!Number.isNaN(d2.getTime())) {
          d2.setDate(d2.getDate() + 1);
          return d2.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        }
      }
    }

    return raw;
  } catch {
    return raw;
  }
};

const describeNpiErrorMessage = (code?: string): string => {
  const normalized = (code || "").toUpperCase().trim();
  switch (normalized) {
    case "NPI_INVALID":
      return "Please enter a valid 10-digit NPI number.";
    case "NPI_NOT_FOUND":
      return "We could not verify that NPI in the CMS registry. Double-check the digits and try again.";
    case "NPI_ALREADY_REGISTERED":
      return "An account already exists for this NPI number.";
    case "NPI_LOOKUP_FAILED":
      return "We could not reach the CMS registry. Please try again in a moment.";
    default:
      return "Unable to verify this NPI number. Please confirm it is correct.";
  }
};

const BULK_META_KEYS = [
  "bulk_pricing_tiers",
  "bulk_pricing",
  "_bulk_pricing_tiers",
  "quantity_discounts",
  "quantity_discount",
];

const normalizeBulkTier = (
  min: unknown,
  discount: unknown,
): BulkPricingTier | null => {
  const minQuantity = Number(min);
  const discountPct = Number(discount);
  if (!Number.isFinite(minQuantity) || !Number.isFinite(discountPct)) {
    return null;
  }
  if (minQuantity <= 0) {
    return null;
  }
  return {
    minQuantity: Math.max(1, Math.floor(minQuantity)),
    discountPercentage: Math.max(0, Math.min(100, Number(discountPct))),
  };
};

const parseBulkPricingValue = (value: unknown): BulkPricingTier[] => {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "object" && entry !== null) {
          const maybe = entry as Record<string, unknown>;
          return normalizeBulkTier(
            maybe.minQuantity ?? maybe.min ?? maybe.quantity ?? maybe.qty,
            maybe.discountPercentage ??
              maybe.discount ??
              maybe.percent ??
              maybe.percentage,
          );
        }
        if (typeof entry === "string") {
          const match = entry.match(
            /(\d+(?:\.\d+)?)\s*[:=,-]\s*(\d+(?:\.\d+)?)/,
          );
          if (match) {
            return normalizeBulkTier(match[1], match[2]);
          }
        }
        return null;
      })
      .filter((tier): tier is BulkPricingTier => Boolean(tier));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.entries(record)
      .map(([key, discount]) => normalizeBulkTier(key, discount))
      .filter((tier): tier is BulkPricingTier => Boolean(tier));
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parseBulkPricingValue(parsed);
    } catch {
      return value
        .split(/[\n,;]/)
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => {
          const parts = token.split(/[:=|-]/).map((part) => part.trim());
          if (parts.length >= 2) {
            return normalizeBulkTier(
              parts[0].replace(/[^\d.]/g, ""),
              parts[1].replace(/[^\d.]/g, ""),
            );
          }
          return null;
        })
        .filter((tier): tier is BulkPricingTier => Boolean(tier));
    }
  }

  return [];
};

const toNumeric = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.\-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeFixedRule = (
  min: unknown,
  unitPrice: unknown,
  basePrice: number,
): BulkPricingTier | null => {
  const minQuantity = Number(min);
  const price = toNumeric(unitPrice);
  if (
    !Number.isFinite(minQuantity) ||
    !price ||
    !Number.isFinite(basePrice) ||
    basePrice <= 0 ||
    minQuantity <= 0
  ) {
    return null;
  }
  const discount = Math.max(0, Math.min(100, (1 - price / basePrice) * 100));
  return {
    minQuantity: Math.floor(minQuantity),
    discountPercentage: Math.round(discount),
  };
};

const parseFixedPriceRules = (
  value: unknown,
  basePrice: number,
): BulkPricingTier[] => {
  if (!value || !Number.isFinite(basePrice) || basePrice <= 0) {
    return [];
  }

  const entries: Array<{ min: unknown; price: unknown }> = [];
  const collect = (min: unknown, price: unknown) => {
    entries.push({ min, price });
  };

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (typeof item === "object" && item !== null) {
        collect(
          (item as any).quantity ??
            (item as any).min ??
            (item as any).minQuantity,
          (item as any).price ?? (item as any).value,
        );
      }
    });
  } else if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, price]) =>
      collect(key, price),
    );
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parseFixedPriceRules(parsed, basePrice);
    } catch {
      value.split(/[\n,;]/).forEach((token) => {
        if (!token) return;
        const parts = token.split(/[:=|-]/).map((part) => part.trim());
        if (parts.length >= 2) {
          collect(parts[0], parts[1]);
        }
      });
    }
  }

  return entries
    .map(({ min, price }) => normalizeFixedRule(min, price, basePrice))
    .filter((tier): tier is BulkPricingTier => Boolean(tier))
    .sort((a, b) => a.minQuantity - b.minQuantity);
};

const parsePepproTiersFromMeta = (
  meta: WooMeta[] | undefined,
  basePrice: number,
): BulkPricingTier[] => {
  if (!Array.isArray(meta) || basePrice <= 0) {
    return [];
  }
  const tiers: BulkPricingTier[] = [];
  meta.forEach((entry) => {
    const key = String(entry?.key || "");
    if (!key.includes("peppro_tier") || key.includes("note")) {
      return;
    }
    const qtyMatch = key.match(/(\d+)/);
    const minQuantity = qtyMatch ? Number(qtyMatch[1]) : null;
    const price = toNumeric(entry?.value);
    if (!minQuantity || !price) {
      return;
    }
    const tier = normalizeFixedRule(minQuantity, price, basePrice);
    if (tier) {
      tiers.push(tier);
    }
  });
  return tiers.sort((a, b) => a.minQuantity - b.minQuantity);
};

const parseVariantBulkPricing = (
  variation: WooVariation,
  basePrice: number,
): BulkPricingTier[] => {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return [];
  }
  const fromProp = parseFixedPriceRules(
    variation.tiered_pricing_fixed_rules ?? null,
    basePrice,
  );
  if (fromProp.length > 0) {
    return fromProp;
  }
  const meta = variation.meta_data ?? [];
  const fixedRulesMeta = meta.find(
    (entry) => entry?.key === "_fixed_price_rules",
  )?.value;
  const fromMeta = parseFixedPriceRules(fixedRulesMeta, basePrice);
  if (fromMeta.length > 0) {
    return fromMeta;
  }
  return parsePepproTiersFromMeta(meta as WooMeta[], basePrice);
};

const parseWeightOz = (value?: string | null) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const parseStrengthFromSku = (sku?: string | null): string | null => {
  if (typeof sku !== "string") {
    return null;
  }
  const trimmed = sku.trim();
  if (!trimmed) {
    return null;
  }
  const matches = Array.from(trimmed.matchAll(/(\d+(?:\.\d+)?)\s*mg/gi)).map(
    (match) => `${match[1]}mg`,
  );
  if (matches.length === 0) {
    return null;
  }
  const dedup: string[] = [];
  for (const token of matches) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== token) {
      dedup.push(token);
    }
  }
  if (dedup.length === 0) {
    return null;
  }
  if (dedup.length === 1) {
    return dedup[0];
  }
  return `${dedup[0]} / ${dedup[1]}`;
};

const titleCaseFromSlug = (slug: string): string => {
  const trimmed = slug.trim();
  if (!trimmed) return "";
  return trimmed
    .split("-")
    .map((part) => {
      const token = part.trim();
      if (!token) return "";
      return token[0].toUpperCase() + token.slice(1);
    })
    .filter(Boolean)
    .join(" ");
};

const hydrateWooProductCategoryNames = (
  product: WooProduct,
  categoryNameById: Map<number, string>,
): WooProduct => {
  const raw = (product as any)?.categories;
  if (!Array.isArray(raw) || raw.length === 0) {
    return product;
  }

  const normalizeId = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  let anyChanged = false;
  const hydrated = raw.map((cat: any) => {
    if (cat && typeof cat === "object") {
      const id = normalizeId(cat.id);
      const existingName = typeof cat.name === "string" ? cat.name.trim() : "";
      let name = existingName;
      if (!name && id !== null) {
        const fallback = categoryNameById.get(id);
        if (typeof fallback === "string" && fallback.trim()) {
          name = fallback.trim();
        }
      }
      if (!name && typeof cat.slug === "string" && cat.slug.trim()) {
        name = titleCaseFromSlug(cat.slug);
      }
      const itemChanged =
        (name !== existingName) || (id !== null && cat.id !== id);
      if (!itemChanged) {
        return cat;
      }
      anyChanged = true;
      return {
        ...cat,
        id: id ?? cat.id,
        name: name || cat.name,
      };
    }

    const id = normalizeId(cat);
    if (id === null) return cat;
    const name = categoryNameById.get(id) || "";
    anyChanged = true;
    return { id, name };
  });

  if (!anyChanged) {
    return product;
  }
  return { ...(product as any), categories: hydrated };
};

const mapWooProductToProduct = (
  product: WooProduct,
  productVariations: WooVariation[] = [],
): Product => {
  const parseStockQuantity = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return Math.floor(parsed);
  };

  const imageSources = (product.images ?? [])
    .map((image) => normalizeWooImageUrl(image?.src))
    .filter((src): src is string => Boolean(src));
  const categoryName = (() => {
    const categories = Array.isArray(product.categories) ? product.categories : [];
    const normalized: string[] = [];
    for (const cat of categories) {
      const rawName = (cat?.name ?? "").toString().trim();
      const name = rawName;
      const lowered = rawName.toLowerCase();
      if (!name) continue;
      if (lowered.includes("subscription")) continue;
      normalized.push(name);
    }
    if (normalized.length === 0) {
      return "";
    }
    // Woo often includes "Uncategorized" alongside the real category; prefer the real category.
    const withoutUncategorized = normalized.filter(
      (name) => name.toLowerCase() !== "uncategorized",
    );
    if (withoutUncategorized.length > 0) {
      return withoutUncategorized[0];
    }
    return normalized[0];
  })();
  const subscriptionMetaFlag = (product.meta_data ?? []).some((meta) => {
    const key = (meta?.key ?? "").toString().toLowerCase();
    const value =
      typeof meta?.value === "string" ? meta.value.toLowerCase() : "";
    return key.includes("subscription") || value.includes("subscription");
  });
  const priceHtml = (product.price_html ?? "").toLowerCase();
  const categorySubscription = (product.categories ?? []).some((cat) =>
    (cat?.name ?? "").toLowerCase().includes("subscription"),
  );
  const descriptionText =
    `${product.description ?? ""} ${product.short_description ?? ""}`.toLowerCase();
  const isSubscriptionProduct =
    subscriptionMetaFlag ||
    priceHtml.includes("subscription") ||
    priceHtml.includes("/ month") ||
    (product.type ?? "").toLowerCase().includes("subscription") ||
    (product.name ?? "").toLowerCase().includes("subscription") ||
    categorySubscription ||
    descriptionText.includes("subscription");

  const parsePrice = (value?: string) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const parseMinPriceFromPriceHtml = (value?: string | null) => {
    if (!value) {
      return undefined;
    }
    const stripped = stripHtml(value);
    if (!stripped) {
      return undefined;
    }
    const matches = stripped.match(/(\d[\d,]*)(\.\d+)?/g);
    if (!matches || matches.length === 0) {
      return undefined;
    }
    const numbers = matches
      .map((match) => Number.parseFloat(match.replace(/,/g, "")))
      .filter((num) => Number.isFinite(num) && num > 0);
    if (numbers.length === 0) {
      return undefined;
    }
    return Math.min(...numbers);
  };

  const normalizeAttributes = (attributes?: WooVariationAttribute[]) =>
    (attributes ?? [])
      .map((attr) => {
        const name = stripHtml(attr?.name ?? "").trim();
        const value = stripHtml(attr?.option ?? "").trim();
        if (!name && !value) {
          return null;
        }
        return {
          name: name || value || "Option",
          value: value || name || "",
        };
      })
      .filter((attr): attr is { name: string; value: string } =>
        Boolean(attr && (attr.name || attr.value)),
      );

  const bulkPricingMeta = product.meta_data?.find((meta) => {
    const key = (meta?.key ?? "").toString().toLowerCase();
    return BULK_META_KEYS.includes(key);
  });
  const parentBulkPricing = bulkPricingMeta
    ? parseBulkPricingValue(bulkPricingMeta.value)
    : [];
  let variantDerivedBulkPricing: BulkPricingTier[] = [];

  const baseProductWeight = parseWeightOz(product.weight);
  const parseDimensionInches = (value?: string | number | null) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const baseProductDimensions = product.dimensions
    ? {
        lengthIn: parseDimensionInches(product.dimensions.length),
        widthIn: parseDimensionInches(product.dimensions.width),
        heightIn: parseDimensionInches(product.dimensions.height),
      }
    : undefined;

  const wooProductId =
    typeof product.id === "number"
      ? product.id
      : Number.parseInt(String(product.id).replace(/[^\d]/g, ""), 10);

  const variantList: ProductVariant[] = (productVariations ?? [])
    .map((variation) => {
      const wooVariationId = Number.isFinite(variation.id)
        ? Number(variation.id)
        : Number.parseInt(String(variation.id).replace(/[^\d]/g, ""), 10);
      const parsedVariantPrice =
        parsePrice(variation.price) ?? parsePrice(variation.regular_price);
      const fallbackPrice =
        parsePrice(product.price) ?? parsePrice(product.regular_price) ?? 0;
      const price = parsedVariantPrice ?? fallbackPrice;
      const originalPrice = parsePrice(variation.regular_price);
      const attributes = normalizeAttributes(variation.attributes);
      const attributeLabel =
        attributes.length > 0
          ? attributes
              .map((attr) => attr.value || attr.name)
              .filter(Boolean)
              .join(" • ")
              .trim()
          : "";
      const skuStrength = parseStrengthFromSku(variation.sku);
      const shouldPreferSkuStrength =
        Boolean(skuStrength) &&
        (!attributeLabel ||
          attributeLabel.toLowerCase() === "option" ||
          (attributeLabel.includes("/") && skuStrength && skuStrength !== attributeLabel));
      const label = shouldPreferSkuStrength
        ? (skuStrength as string)
        : attributeLabel ||
          (variation.sku ? variation.sku : `Variant ${variation.id}`);
      const variantId = Number.isFinite(wooVariationId)
        ? `woo-variation-${wooVariationId}`
        : `woo-variation-${variation.id}`;
      const variantBulk = parseVariantBulkPricing(variation, price);
      if (!variantDerivedBulkPricing.length && variantBulk.length) {
        variantDerivedBulkPricing = variantBulk;
      }
      const weightOz =
        parseWeightOz(variation.weight) ?? baseProductWeight ?? null;
      return {
        id: variantId,
        wooId: Number.isFinite(wooVariationId) ? wooVariationId : undefined,
        label,
        price,
        originalPrice:
          originalPrice && originalPrice > price ? originalPrice : undefined,
        sku: variation.sku?.trim() || undefined,
        inStock: (variation.stock_status ?? "").toLowerCase() !== "outofstock",
        stockQuantity: parseStockQuantity((variation as any)?.stock_quantity),
        attributes,
        image: normalizeWooImageUrl(variation.image?.src) ?? undefined,
        description: stripHtml(variation.description ?? "") || undefined,
        weightOz,
        dimensions: variation.dimensions
          ? {
              lengthIn: parseDimensionInches(variation.dimensions.length),
              widthIn: parseDimensionInches(variation.dimensions.width),
              heightIn: parseDimensionInches(variation.dimensions.height),
            }
          : undefined,
      };
    })
    .filter((variant): variant is ProductVariant =>
      Number.isFinite(variant.price),
    );

  const hasVariants = variantList.length > 0;
  const variantPrices = variantList
    .map((variant) => variant.price)
    .filter((value): value is number => Number.isFinite(value));
  const minVariantPrice =
    variantPrices.length > 0 ? Math.min(...variantPrices) : undefined;
  const basePrice =
    parsePrice(product.price) ??
    parsePrice(product.regular_price) ??
    parseMinPriceFromPriceHtml(product.price_html) ??
    0;
  const price = hasVariants ? (minVariantPrice ?? basePrice) : basePrice;
  const baseOriginalPrice = parsePrice(product.regular_price);
  const originalPrice =
    !hasVariants && baseOriginalPrice && baseOriginalPrice > price
      ? baseOriginalPrice
      : undefined;
  const cleanedDescription = stripHtml(
    product.short_description || product.description,
  );
  const manufacturerMeta = product.meta_data?.find(
    (meta) => meta?.key === "manufacturer",
  )?.value;
  const productBulkPricing =
    parentBulkPricing.length > 0
      ? parentBulkPricing
      : variantDerivedBulkPricing;
  const variantImages = variantList
    .map((variant) => variant.image)
    .filter((src): src is string => Boolean(src));
  let galleryImages = [...variantImages, ...imageSources].filter(
    (src, index, self) => Boolean(src) && self.indexOf(src) === index,
  ) as string[];
  const variantSummary = hasVariants
    ? (() => {
        const labels = variantList
          .map((variant) => variant.label)
          .filter(Boolean);
        if (labels.length <= 3) {
          return labels.join(" • ");
        }
        const remaining = labels.length - 3;
        return `${labels.slice(0, 3).join(" • ")} +${remaining} more`;
      })()
    : undefined;
  const defaultVariantId = hasVariants
    ? (variantList.find((variant) => variant.inStock)?.id ?? variantList[0]?.id)
    : undefined;

  const isVariableProduct = String(product.type || "").toLowerCase() === "variable";
  const fallbackVariationCount = Array.isArray(product.variations)
    ? product.variations.length
    : 0;
  if (isVariableProduct && (!hasVariants || variantImages.length === 0)) {
    galleryImages = [WOO_PLACEHOLDER_IMAGE];
  } else if (galleryImages.length === 0) {
    galleryImages = [WOO_PLACEHOLDER_IMAGE];
  }

  return {
    id: `woo-${product.id}`,
    wooId: Number.isFinite(wooProductId) ? wooProductId : undefined,
    name: stripHtml(product.name) || `Product ${product.id}`,
    category: categoryName,
    price,
    originalPrice,
    rating: Number.parseFloat(product.average_rating || "") || 5,
    reviews: Number.isFinite(product.rating_count)
      ? Number(product.rating_count)
      : 0,
    image: galleryImages[0] ?? WOO_PLACEHOLDER_IMAGE,
    images: galleryImages,
    image_loaded: false,
    inStock: hasVariants
      ? variantList.some((variant) => variant.inStock)
      : (product.stock_status ?? "").toLowerCase() !== "outofstock",
    stockQuantity: parseStockQuantity((product as any)?.stock_quantity),
    prescription: false,
    dosage: hasVariants
      ? `${variantList.length} option${variantList.length === 1 ? "" : "s"} available`
      : isVariableProduct && fallbackVariationCount > 0
        ? `${fallbackVariationCount} option${fallbackVariationCount === 1 ? "" : "s"} available`
        : "See details",
    manufacturer:
      stripHtml(typeof manufacturerMeta === "string" ? manufacturerMeta : "") ||
      "",
    type: product.type ?? "General",
    isSubscription: isSubscriptionProduct,
    description: cleanedDescription || undefined,
    weightOz: baseProductWeight ?? null,
    dimensions: baseProductDimensions,
    sku: product.sku?.trim() || undefined,
    variants: hasVariants ? variantList : undefined,
    hasVariants,
    defaultVariantId,
    variantSummary,
    bulkPricingTiers:
      productBulkPricing.length > 0 ? productBulkPricing : undefined,
  };
};

const toCardProduct = (product: Product): CardProduct => {
  const needsVariantSelection =
    (product.type ?? "").toLowerCase() === "variable" &&
    (!product.variants || product.variants.length === 0);
  const baseImage = needsVariantSelection ? WOO_PLACEHOLDER_IMAGE : product.image;
  const baseImages =
    needsVariantSelection || !product.images || product.images.length === 0
      ? [WOO_PLACEHOLDER_IMAGE]
      : product.images;
  const variations =
    product.variants && product.variants.length > 0
      ? product.variants.map((variant) => ({
          id: variant.id,
          strength:
            variant.label ||
            variant.attributes.map((attr) => attr.value).join(" • ") ||
            "Option",
          basePrice: variant.price,
          image: variant.image,
          weightOz: variant.weightOz ?? null,
          stockQuantity: variant.stockQuantity ?? null,
        }))
      : needsVariantSelection
        ? [
            {
              id: "__peppro_needs_variant__",
              strength: "Select strength",
              basePrice: product.price,
              image: product.image,
              weightOz: product.weightOz ?? null,
              stockQuantity: null,
            },
          ]
        : [
            {
              id: product.id,
              strength: product.dosage || "Standard",
              basePrice: product.price,
              image: product.image,
              weightOz: product.weightOz ?? null,
              stockQuantity: product.stockQuantity ?? null,
            },
          ];

  return {
    id: product.id,
    name: product.name,
    category: product.category,
    image: baseImage,
    images: baseImages,
    inStock: product.inStock,
    stockQuantity: product.stockQuantity ?? null,
    manufacturer: product.manufacturer,
    weightOz: product.weightOz ?? null,
    variations,
    bulkPricingTiers: product.bulkPricingTiers ?? [],
  };
};

const CatalogSkeletonCard = forwardRef<HTMLDivElement>((_props, ref) => (
  <div ref={ref} className="catalog-skeleton-card squircle-xl" aria-hidden="true">
    <div className="catalog-skeleton-thumb" />
    <div className="catalog-skeleton-lines">
      <div className="catalog-skeleton-line catalog-skeleton-line--short" />
      <div className="catalog-skeleton-line" />
      <div className="catalog-skeleton-line catalog-skeleton-line--medium" />
      <div className="catalog-skeleton-line catalog-skeleton-line--xs" />
    </div>
    <div className="catalog-skeleton-footer">
      <div className="catalog-skeleton-pill" />
      <div className="catalog-skeleton-pill catalog-skeleton-pill--short" />
    </div>
  </div>
));
CatalogSkeletonCard.displayName = "CatalogSkeletonCard";

const formatPreviewCurrency = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }
  return `$${value.toFixed(2)}`;
};

const CatalogTextPreviewCard = ({ product }: { product: Product }) => (
  <div className="glass-card squircle-xl p-5 flex flex-col gap-3 min-h-[16rem]" aria-live="polite">
    <div className="flex items-center justify-between gap-2">
      {product.price && (
        <span className="text-sm font-bold text-slate-900">{formatPreviewCurrency(product.price)}</span>
      )}
    </div>
    <h3 className="text-base font-semibold text-slate-900 line-clamp-2">
      {product.name}
    </h3>
    {product.dosage && (
      <p className="text-xs text-slate-600">{product.dosage}</p>
    )}
    {product.manufacturer && (
      <p className="text-xs uppercase tracking-wide text-slate-500">{product.manufacturer}</p>
    )}
    <div className="mt-auto text-xs text-slate-400">
      Ready to view details once loaded…
    </div>
  </div>
);

interface LazyCatalogProductCardProps {
  product: Product;
  onAddToCart: (
    productId: string,
    variationId: string | undefined | null,
    quantity: number,
  ) => void;
  onEnsureVariants?: (
    product: Product,
    options?: { force?: boolean },
  ) => Promise<unknown> | void;
}

const LazyCatalogProductCard = ({
  product,
  onAddToCart,
  onEnsureVariants,
}: LazyCatalogProductCardProps) => {
  const cardProduct = useMemo(() => toCardProduct(product), [product]);

  return (
    <ProductCard
      product={cardProduct}
      onEnsureVariants={
        typeof onEnsureVariants === "function"
          ? (opts) => onEnsureVariants(product, opts)
          : undefined
      }
      onAddToCart={(productId, variationId, quantity) =>
        onAddToCart(productId, variationId, quantity)
      }
    />
  );
};

// (Removed eager variation prefetching for faster catalog loads.)

export default function App() {
  const BROWSER_VARIATION_CACHE_ENABLED =
    String((import.meta as any).env?.VITE_BROWSER_VARIATION_CACHE || "")
      .toLowerCase()
      .trim() === "true";
  const shipStationDashboardUrl = "https://ship14.shipstation.com";
  const [user, setUser] = useState<User | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutPricingMode, setCheckoutPricingMode] =
    useState<PricingMode>("wholesale");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productDetailOpen, setProductDetailOpen] = useState(false);
  const [loginPromptToken, setLoginPromptToken] = useState(0);
  const apiWarmupInFlight = useRef(false);
  const [shouldReopenCheckout, setShouldReopenCheckout] = useState(false);
  const [loginContext, setLoginContext] = useState<"checkout" | null>(null);
  const canUseRetailPricing = Boolean(
    user && (isRep(user.role) || isAdmin(user.role)),
  );
  const [landingAuthMode, setLandingAuthMode] = useState<
    "login" | "signup" | "forgot" | "reset"
  >(getInitialLandingMode);
  const [postLoginHold, setPostLoginHold] = useState(false);
  const [isReturningUser, setIsReturningUser] = useState(false);

  useEffect(() => {
    if (!canUseRetailPricing && checkoutPricingMode === "retail") {
      setCheckoutPricingMode("wholesale");
    }
  }, [canUseRetailPricing, checkoutPricingMode]);

  const [infoFocusActive, setInfoFocusActive] = useState(false);
  const [shouldAnimateInfoFocus, setShouldAnimateInfoFocus] = useState(false);
  const [peptideForumEnabled, setPeptideForumEnabled] =
    useState(true);
  const [peptideForumLoading, setPeptideForumLoading] = useState(false);
  const [peptideForumError, setPeptideForumError] = useState<string | null>(null);
  const [peptideForumUpdatedAt, setPeptideForumUpdatedAt] = useState<string | null>(null);
  const [peptideForumItems, setPeptideForumItems] = useState<
    Array<{
      id: string;
      title: string;
      date?: string | null;
      description?: string | null;
      link?: string | null;
      recording?: string | null;
    }>
  >([]);
  const [referralPollingSuppressed, setReferralPollingSuppressed] =
    useState(false);
  const variationCacheRef = useRef<Map<number, WooVariation[]>>(new Map());
  const variationCacheLoadedRef = useRef(false);
  const wooProductCacheRef = useRef<Map<number, WooProduct>>(new Map());
  const wooCategoryNameByIdRef = useRef<Map<number, string>>(new Map());
  const ensureVariationCacheReady = useCallback(() => {
    if (variationCacheLoadedRef.current) {
      return;
    }
    if (typeof window === "undefined") {
      variationCacheLoadedRef.current = true;
      return;
    }
    if (!BROWSER_VARIATION_CACHE_ENABLED) {
      variationCacheLoadedRef.current = true;
      variationCacheRef.current.clear();
      return;
    }
    variationCacheLoadedRef.current = true;
    try {
      const raw =
        window.localStorage.getItem(VARIATION_CACHE_STORAGE_KEY) ||
        window.sessionStorage.getItem(VARIATION_CACHE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.data &&
        typeof parsed.data === "object"
      ) {
        Object.entries(parsed.data as Record<string, WooVariation[]>).forEach(
          ([key, value]) => {
            const id = Number(key);
            if (Number.isFinite(id) && Array.isArray(value)) {
              variationCacheRef.current.set(id, value);
            }
          },
        );
      }
    } catch (error) {
      console.debug("[Catalog] Failed to load variation cache", error);
      variationCacheRef.current.clear();
    }
  }, []);
  const persistVariationCache = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!BROWSER_VARIATION_CACHE_ENABLED) {
      return;
    }
    try {
      const payload: Record<string, WooVariation[]> = {};
      variationCacheRef.current.forEach((value, key) => {
        payload[String(key)] = value;
      });
      const serialized = JSON.stringify({ data: payload, ts: Date.now() });
      window.localStorage.setItem(VARIATION_CACHE_STORAGE_KEY, serialized);
      window.sessionStorage.setItem(VARIATION_CACHE_STORAGE_KEY, serialized);
    } catch (error) {
      console.debug("[Catalog] Failed to persist variation cache", error);
    }
  }, []);

	  const refreshPeptideForum = useCallback(async () => {
	    if (!user) {
	      return;
	    }
	    setPeptideForumLoading(true);
	    setPeptideForumError(null);
	    try {
	      const response = await forumAPI.listPeptideForum();
	      const items = Array.isArray((response as any)?.items) ? (response as any).items : [];
	      const shouldAddLocalDummyForumItem =
	        import.meta.env.DEV && /localhost|127\\.0\\.0\\.1/i.test(API_BASE_URL);
	      const normalizedItems =
	        shouldAddLocalDummyForumItem && items.length === 0
	          ? ([
	              {
	                id: "local-dev-dummy",
	                title: "Dummy Forum Class (Local Dev)",
	                date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
	                description:
	                  "Placeholder item for the local Node backend. Replace with real forum data when available.",
	                link: "https://example.com",
	                recording: null,
	              },
	            ] as typeof items)
	          : items;
	      setPeptideForumItems(normalizedItems);
	      setPeptideForumUpdatedAt(
	        typeof (response as any)?.updatedAt === "string" ? (response as any).updatedAt : null,
	      );
	    } catch (error: any) {
	      setPeptideForumItems([]);
      setPeptideForumUpdatedAt(null);
      setPeptideForumError(
        typeof error?.message === "string" && error.message
          ? error.message
          : "Unable to load The Peptide Forum right now.",
      );
    } finally {
      setPeptideForumLoading(false);
    }
  }, [user]);

  const shouldShowPeptideForumCard =
    peptideForumEnabled || isAdmin(user?.role);

  useEffect(() => {
    if (!postLoginHold || !user) {
      return;
    }
    if (!shouldShowPeptideForumCard) {
      setPeptideForumItems([]);
      setPeptideForumUpdatedAt(null);
      setPeptideForumError(null);
      return;
    }
    void refreshPeptideForum();
  }, [postLoginHold, user?.id, refreshPeptideForum, shouldShowPeptideForumCard]);

  const variationFetchInFlightRef = useRef<Map<number, Promise<WooVariation[]>>>(
    new Map(),
  );
  const variationRetryRef = useRef<Map<number, { attempt: number; nextAt: number }>>(
    new Map(),
  );
  const wooBackoffUntilRef = useRef(0);
  const wooBackoffAttemptRef = useRef(0);
  const variantPrefetchActiveRef = useRef(0);
  const variantPrefetchQueueRef = useRef<Array<() => void>>([]);
  const variantPrefetchQueuedRef = useRef<Set<number>>(new Set());
  const imagePrefetchActiveRef = useRef(0);
  const imagePrefetchQueueRef = useRef<string[]>([]);
  const imagePrefetchStateRef = useRef<
    Map<
      string,
      {
        firstSeenAt: number;
        attempt: number;
        nextAt: number;
        queued: boolean;
        inFlight: boolean;
        loaded: boolean;
      }
    >
  >(new Map());
  const mediaRepairInFlightRef = useRef<Set<number>>(new Set());
  const mediaRepairRetryRef = useRef<Map<number, { attempt: number; nextAt: number }>>(
    new Map(),
  );

  const ensureCatalogProductHasVariants = useCallback(
    async (product: Product, options?: { force?: boolean }): Promise<Product> => {
      const isVariable = (product.type ?? "").toLowerCase() === "variable";
      const shouldForce = options?.force === true;
      if (!isVariable) {
        return product;
      }
      if (!shouldForce && product.variants && product.variants.length > 0) {
        return product;
      }
      if (!shouldForce && Date.now() < wooBackoffUntilRef.current) {
        return product;
      }

      ensureVariationCacheReady();
      const wooId =
        typeof product.wooId === "number"
          ? product.wooId
          : Number.parseInt(String(product.id).replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(wooId)) {
        return product;
      }

      let cached = BROWSER_VARIATION_CACHE_ENABLED
        ? variationCacheRef.current.get(wooId)
        : undefined;
      if (cached && cached.length === 0) {
        variationCacheRef.current.delete(wooId);
        cached = undefined;
      }
      let rawWooProduct = wooProductCacheRef.current.get(wooId);
      if (rawWooProduct) {
        const hydrated = hydrateWooProductCategoryNames(
          rawWooProduct,
          wooCategoryNameByIdRef.current,
        );
        if (hydrated !== rawWooProduct) {
          rawWooProduct = hydrated;
          wooProductCacheRef.current.set(wooId, hydrated);
        }
      }

      const retryState = variationRetryRef.current.get(wooId);
      if (retryState && Date.now() < retryState.nextAt && !shouldForce) {
        return product;
      }
      if (shouldForce) {
        variationRetryRef.current.delete(wooId);
      }

      const bumpRetry = () => {
        const prev = variationRetryRef.current.get(wooId);
        const attempt = (prev?.attempt ?? 0) + 1;
        const delayMs = Math.min(60000, 1500 * Math.pow(1.8, attempt - 1));
        variationRetryRef.current.set(wooId, {
          attempt,
          nextAt: Date.now() + delayMs,
        });
      };

      const hasVariationImages = (list: WooVariation[]) =>
        Array.isArray(list) &&
        list.some((variation) => Boolean((variation as any)?.image?.src));

      const loadVariations = async () => {
        if (cached && !shouldForce && hasVariationImages(cached)) {
          return cached;
        }
        const response = await listProductVariations<WooVariation[]>(wooId, {
          per_page: 100,
          status: "publish",
          ...(shouldForce ? { force: true } : null),
        });
        const resolved = Array.isArray(response) ? response : [];
        // If we got variants but none have images, retry once against Woo (bypass cache).
        if (!shouldForce && resolved.length > 0 && !hasVariationImages(resolved)) {
          try {
            const forced = await listProductVariations<WooVariation[]>(wooId, {
              per_page: 100,
              status: "publish",
              force: true,
            });
            const forcedList = Array.isArray(forced) ? forced : [];
            return forcedList.length > 0 ? forcedList : resolved;
          } catch {
            return resolved;
          }
        }
        return resolved;
      };

      try {
        const inFlight = variationFetchInFlightRef.current.get(wooId);
        const promise =
          inFlight ??
          (async () => {
            const variations = await loadVariations();
            // Don't persist empty responses for variable products; they're often transient.
            if (variations.length > 0 && BROWSER_VARIATION_CACHE_ENABLED) {
              variationCacheRef.current.set(wooId, variations);
              persistVariationCache();
            }
            return variations;
          })();
        if (!inFlight) {
          variationFetchInFlightRef.current.set(wooId, promise);
        }
        const resolved = await promise;
        variationFetchInFlightRef.current.delete(wooId);

        if (!rawWooProduct) {
          try {
            const fetched = await getProduct<WooProduct>(wooId, shouldForce ? { force: true } : {});
            if (fetched && typeof fetched === "object" && "id" in fetched) {
              const hydrated = hydrateWooProductCategoryNames(
                fetched,
                wooCategoryNameByIdRef.current,
              );
              rawWooProduct = hydrated;
              wooProductCacheRef.current.set(wooId, hydrated);
            }
          } catch (error) {
            console.debug("[Catalog] Failed to fetch Woo product payload", {
              wooId,
              error,
            });
          }
        }
        if (!rawWooProduct) {
          return product;
        }

        const nextProduct = mapWooProductToProduct(rawWooProduct, resolved);
        nextProduct.image_loaded =
          nextProduct.image !== WOO_PLACEHOLDER_IMAGE &&
          Boolean(imagePrefetchStateRef.current.get(nextProduct.image)?.loaded);
        if (
          isVariable &&
          (!nextProduct.variants || nextProduct.variants.length === 0) &&
          Array.isArray(rawWooProduct.variations) &&
          rawWooProduct.variations.length > 0
        ) {
          bumpRetry();
          return product;
        }
        variationRetryRef.current.delete(wooId);
        wooBackoffAttemptRef.current = 0;
        wooBackoffUntilRef.current = 0;
        setCatalogProducts((prev) =>
          prev.map((item) => (item.id === product.id ? nextProduct : item)),
        );
        setSelectedProduct((prev) =>
          prev?.id === product.id ? nextProduct : prev,
        );
        return nextProduct;
      } catch (error) {
        variationFetchInFlightRef.current.delete(wooId);
        bumpRetry();
        const status =
          typeof (error as any)?.status === "number" ? (error as any).status : null;
        const message =
          typeof (error as any)?.message === "string" ? (error as any).message : "";
        const errorName =
          typeof (error as any)?.name === "string" ? (error as any).name : "";
        const shouldBackoff =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          message === "Failed to fetch" ||
          message === "Load failed" ||
          errorName === "TypeError";
        if (!shouldForce && shouldBackoff) {
          wooBackoffAttemptRef.current += 1;
          const attempt = Math.min(8, wooBackoffAttemptRef.current);
          const delayMs = Math.min(5 * 60 * 1000, 2000 * Math.pow(2, attempt - 1));
          wooBackoffUntilRef.current = Date.now() + delayMs;
          console.warn("[Catalog] Woo backoff engaged", {
            status,
            attempt,
            delayMs,
          });
        }
        console.warn("[Catalog] Failed to load variants for product", {
          productId: product.id,
          wooId,
          error,
        });
        return product;
      }
    },
    [ensureVariationCacheReady, persistVariationCache],
  );

  const prefetchCatalogProductVariants = useCallback(
    (product: Product) => {
      const isVariable = (product.type ?? "").toLowerCase() === "variable";
      if (!isVariable || (product.variants && product.variants.length > 0)) {
        return;
      }
      if (Date.now() < wooBackoffUntilRef.current) {
        return;
      }
      const wooId =
        typeof product.wooId === "number"
          ? product.wooId
          : Number.parseInt(String(product.id).replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(wooId)) {
        return;
      }
      if (variantPrefetchQueuedRef.current.has(wooId)) {
        return;
      }
      variantPrefetchQueuedRef.current.add(wooId);

      const startNext = () => {
        while (
          variantPrefetchActiveRef.current < VARIANT_PREFETCH_CONCURRENCY &&
          variantPrefetchQueueRef.current.length > 0
        ) {
          const next = variantPrefetchQueueRef.current.shift();
          if (next) {
            variantPrefetchActiveRef.current += 1;
            next();
          }
        }
      };

      variantPrefetchQueueRef.current.push(() => {
        if (Date.now() < wooBackoffUntilRef.current) {
          variantPrefetchActiveRef.current = Math.max(
            0,
            variantPrefetchActiveRef.current - 1,
          );
          variantPrefetchQueuedRef.current.delete(wooId);
          startNext();
          return;
        }
        void ensureCatalogProductHasVariants(product)
          .catch(() => {})
          .finally(() => {
            variantPrefetchActiveRef.current = Math.max(
              0,
              variantPrefetchActiveRef.current - 1,
            );
            variantPrefetchQueuedRef.current.delete(wooId);
            startNext();
          });
      });

      startNext();
    },
    [ensureCatalogProductHasVariants],
  );

  const enqueueImagePrefetch = useCallback((src: string) => {
    if (!IMAGE_PREFETCH_ENABLED) return;
    if (typeof window === "undefined") return;
    if (!src) return;
    const trimmed = src.trim();
    if (!trimmed) return;
    if (trimmed === WOO_PLACEHOLDER_IMAGE) return;
    if (trimmed.startsWith("data:")) return;

    const state =
      imagePrefetchStateRef.current.get(trimmed) ??
      ({
        firstSeenAt: Date.now(),
        attempt: 0,
        nextAt: 0,
        queued: false,
        inFlight: false,
        loaded: false,
      } as const);

    if (!imagePrefetchStateRef.current.has(trimmed)) {
      imagePrefetchStateRef.current.set(trimmed, { ...state });
    }

    const current = imagePrefetchStateRef.current.get(trimmed);
    if (!current || current.loaded || current.inFlight || current.queued) {
      return;
    }
    if (Date.now() < current.nextAt) {
      return;
    }

    current.queued = true;
    imagePrefetchQueueRef.current.push(trimmed);
  }, []);

  const runImagePrefetchQueue = useCallback(() => {
    if (!IMAGE_PREFETCH_ENABLED) return;
    if (typeof window === "undefined") return;
    if (!isPageVisible()) return;

    const startNext = () => {
      while (
        imagePrefetchActiveRef.current < IMAGE_PREFETCH_CONCURRENCY &&
        imagePrefetchQueueRef.current.length > 0
      ) {
        const url = imagePrefetchQueueRef.current.shift();
        if (!url) continue;
        const state = imagePrefetchStateRef.current.get(url);
        if (!state || state.loaded || state.inFlight) {
          continue;
        }
        if (Date.now() < state.nextAt) {
          state.queued = false;
          continue;
        }

        state.queued = false;
        state.inFlight = true;
        state.attempt += 1;
        imagePrefetchActiveRef.current += 1;

        const img = new Image();
        const timeoutMs = 20000;
        const timeoutId = window.setTimeout(() => {
          img.onload = null;
          img.onerror = null;
          const current = imagePrefetchStateRef.current.get(url);
          if (current) {
            current.inFlight = false;
            const delayMs = Math.min(120000, 1200 * Math.pow(1.8, current.attempt - 1));
            current.nextAt = Date.now() + delayMs;
            window.setTimeout(() => {
              enqueueImagePrefetch(url);
              startNext();
            }, delayMs + 5);
          }
          imagePrefetchActiveRef.current = Math.max(0, imagePrefetchActiveRef.current - 1);
          startNext();
        }, timeoutMs);

        img.onload = () => {
          window.clearTimeout(timeoutId);
          img.onload = null;
          img.onerror = null;
          const current = imagePrefetchStateRef.current.get(url);
          if (current) {
            current.loaded = true;
            current.inFlight = false;
          }
          imagePrefetchActiveRef.current = Math.max(0, imagePrefetchActiveRef.current - 1);
          window.setTimeout(startNext, IMAGE_PREFETCH_DELAY_MS);
        };
        img.onerror = () => {
          window.clearTimeout(timeoutId);
          img.onload = null;
          img.onerror = null;
          const current = imagePrefetchStateRef.current.get(url);
          if (current) {
            current.inFlight = false;
            const delayMs = Math.min(120000, 1200 * Math.pow(1.8, current.attempt - 1));
            current.nextAt = Date.now() + delayMs;
            window.setTimeout(() => {
              enqueueImagePrefetch(url);
              startNext();
            }, delayMs + 5);
          }
          imagePrefetchActiveRef.current = Math.max(0, imagePrefetchActiveRef.current - 1);
          startNext();
        };

        img.src = url;
      }
    };

    startNext();
  }, [enqueueImagePrefetch]);

  const referralSummaryCooldownRef = useRef<number | null>(null);
  const prevUserRef = useRef<User | null>(null);
  const [showLandingLoginPassword, setShowLandingLoginPassword] =
    useState(false);
  const [showLandingSignupPassword, setShowLandingSignupPassword] =
    useState(false);
  const [showLandingSignupConfirm, setShowLandingSignupConfirm] =
    useState(false);
  const [passwordResetEmail, setPasswordResetEmail] = useState("");
  const [passwordResetRequestPending, setPasswordResetRequestPending] =
    useState(false);
  const [passwordResetRequestSuccess, setPasswordResetRequestSuccess] =
    useState(false);
  const [passwordResetRequestError, setPasswordResetRequestError] =
    useState("");
  const [resetPasswordToken, setResetPasswordToken] = useState<string | null>(
    getInitialResetToken,
  );
  const [resetPasswordPending, setResetPasswordPending] = useState(false);
  const [resetPasswordError, setResetPasswordError] = useState("");
  const [resetPasswordSuccess, setResetPasswordSuccess] = useState("");
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetPasswordConfirmValue, setResetPasswordConfirmValue] =
    useState("");
  const resetCompletionTimerRef = useRef<number | null>(null);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [showResetPasswordConfirm, setShowResetPasswordConfirm] =
    useState(false);
  const checkoutButtonObserverRef = useRef<IntersectionObserver | null>(null);
  const [isCheckoutButtonVisible, setIsCheckoutButtonVisible] = useState(false);
  const filterSidebarRef = useRef<HTMLDivElement | null>(null);
  const landingLoginEmailRef = useRef<HTMLInputElement | null>(null);
  const landingLoginPasswordRef = useRef<HTMLInputElement | null>(null);
  const landingCredentialAutofillInFlight = useRef(false);
  const [passkeySupport, setPasskeySupport] = useState({
    platform: false,
    conditional: false,
    checked: false,
  });
  const [passkeyAutopromptEnabled, setPasskeyAutopromptEnabled] =
    useState(PASSKEY_AUTOPROMPT);
  const passkeyConditionalInFlight = useRef(false);
  const [passkeyLoginPending, setPasskeyLoginPending] = useState(false);
  const [landingLoginPending, setLandingLoginPending] = useState(false);
  const [enablePasskeyPending, setEnablePasskeyPending] = useState(false);
  const [enablePasskeyError, setEnablePasskeyError] = useState("");
  const passkeyAutopromptAttemptedRef = useRef(false);
  const passkeyAutoRegisterAttemptedRef = useRef(false);
  const consoleRestoreRef = useRef<null | {
    log: Console["log"];
    info: Console["info"];
    debug: Console["debug"];
    warn: Console["warn"];
  }>(null);
  const [accountOrders, setAccountOrders] = useState<AccountOrderSummary[]>([]);
  const [accountOrdersLoading, setAccountOrdersLoading] = useState(false);
  const [accountOrdersError, setAccountOrdersError] = useState<string | null>(
    null,
  );
  const [accountOrdersSyncedAt, setAccountOrdersSyncedAt] = useState<
    string | null
  >(null);
  const [showCanceledOrders, setShowCanceledOrders] = useState(true);
  const postCheckoutOrderRef = useRef<{
    pepproOrderId: string | null;
    wooOrderId: string | null;
    wooOrderNumber: string | null;
    createdAtMs: number;
  } | null>(null);
  const postCheckoutOptimisticOrderRef = useRef<AccountOrderSummary | null>(null);
  const postCheckoutOrdersRefreshTimersRef = useRef<number[]>([]);
  const [accountModalRequest, setAccountModalRequest] = useState<{
    tab: "details" | "orders";
    open?: boolean;
    token: number;
    order?: AccountOrderSummary;
  } | null>(null);
  const openAccountDetailsTab = useCallback(() => {
    const token = Date.now();
    setAccountModalRequest({
      tab: "details",
      open: true,
      token,
    });
  }, []);
  const profileShippingAddress = useMemo(
    () => buildShippingAddressFromUserProfile(user),
    [user],
  );
  const historyShippingAddress = useMemo(
    () =>
      deriveShippingAddressFromOrders(
        accountOrders,
        user?.name || user?.npiVerification?.name || null,
      ),
    [accountOrders, user?.name, user?.npiVerification?.name],
  );
  const checkoutDefaultShippingAddress = useMemo(() => {
    if (profileShippingAddress) {
      return profileShippingAddress;
    }
    if (historyShippingAddress) {
      return historyShippingAddress;
    }
    if (user) {
      return {
        name: user.name || user.npiVerification?.name || null,
        addressLine1: user.officeAddressLine1 || null,
        addressLine2: user.officeAddressLine2 || null,
        city: user.officeCity || null,
        state: user.officeState || null,
        postalCode: user.officePostalCode || null,
        country: "US",
      };
    }
    return undefined;
  }, [profileShippingAddress, historyShippingAddress, user]);
  const triggerLandingCredentialAutofill = useCallback(async () => {
    if (landingCredentialAutofillInFlight.current) {
      return;
    }
    landingCredentialAutofillInFlight.current = true;
    try {
      const credential = await requestStoredPasswordCredential();
      if (credential) {
        if (landingLoginEmailRef.current) {
          landingLoginEmailRef.current.value = credential.id;
        }
        if (landingLoginPasswordRef.current) {
          landingLoginPasswordRef.current.value = credential.password;
        }
      }
    } finally {
      landingCredentialAutofillInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const suppress = Boolean(
      user && (isDoctorRole(user.role) || isRep(user.role)),
    );
    if (suppress && !consoleRestoreRef.current) {
      consoleRestoreRef.current = {
        log: console.log,
        info: console.info,
        debug: console.debug,
        warn: console.warn,
      };
      console.log = noop;
      console.info = noop;
      console.debug = noop;
      console.warn = noop;
    }
    if (!suppress && consoleRestoreRef.current) {
      console.log = consoleRestoreRef.current.log;
      console.info = consoleRestoreRef.current.info;
      console.debug = consoleRestoreRef.current.debug;
      console.warn = consoleRestoreRef.current.warn;
      consoleRestoreRef.current = null;
    }
    return () => {
      if (consoleRestoreRef.current) {
        console.log = consoleRestoreRef.current.log;
        console.info = consoleRestoreRef.current.info;
        console.debug = consoleRestoreRef.current.debug;
        console.warn = consoleRestoreRef.current.warn;
        consoleRestoreRef.current = null;
      }
    };
  }, [user?.role]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleLocationSync = () => {
      if (isResetPasswordRoute()) {
        setLandingAuthMode("reset");
        setResetPasswordToken(readResetTokenFromLocation());
      }
    };
    window.addEventListener("popstate", handleLocationSync);
    return () => window.removeEventListener("popstate", handleLocationSync);
  }, []);

  const closeResetWindow = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const origin = window.location.origin;
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({ type: "PASSWORD_RESET_COMPLETE" }, origin);
      } catch (error) {
        console.warn(
          "[Auth] Unable to notify opener about password reset completion",
          error,
        );
      }
      window.close();
    } else {
      window.location.replace("/");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!resetPasswordSuccess) {
      if (resetCompletionTimerRef.current) {
        window.clearTimeout(resetCompletionTimerRef.current);
        resetCompletionTimerRef.current = null;
      }
      return;
    }
    resetCompletionTimerRef.current = window.setTimeout(closeResetWindow, 1500);
    return () => {
      if (resetCompletionTimerRef.current) {
        window.clearTimeout(resetCompletionTimerRef.current);
        resetCompletionTimerRef.current = null;
      }
    };
  }, [closeResetWindow, resetPasswordSuccess]);

  const clearResetRoute = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (isResetPasswordRoute()) {
      window.history.replaceState({}, "", "/");
    }
  }, []);

		  const loadAccountOrders = useCallback(
		    async (options?: { includeCanceled?: boolean; force?: boolean }) => {
	      const includeCanceled = options?.includeCanceled ?? showCanceledOrders;
	      const force = options?.force === true;
	      if (!user?.id) {
	        setAccountOrders([]);
	        setAccountOrdersSyncedAt(null);
	        setAccountOrdersError(null);
	        return [];
	      }
	      setAccountOrdersLoading(true);
	      setAccountOrdersError(null);
	      try {
	        const response = await ordersAPI.getAll({ includeCanceled, force });
	        let normalized = normalizeAccountOrdersResponse(response, {
	          includeCanceled,
	        });
	        const optimistic = postCheckoutOptimisticOrderRef.current;
	        const optimisticMeta = postCheckoutOrderRef.current;
	        if (optimistic && optimisticMeta) {
          const ageMs = Date.now() - optimisticMeta.createdAtMs;
          if (ageMs > 10 * 60 * 1000) {
            postCheckoutOptimisticOrderRef.current = null;
          } else {
	            const optimisticNumber = optimistic.number
	              ? String(optimistic.number).trim()
	              : "";
	            const optimisticId = optimistic.id ? String(optimistic.id).trim() : "";
	            const optimisticPepproId = optimisticMeta.pepproOrderId
	              ? String(optimisticMeta.pepproOrderId).trim()
	              : "";
	            const exists = normalized.some((order) => {
	              const orderNumber = order.number ? String(order.number).trim() : "";
	              const orderId = order.id ? String(order.id).trim() : "";
	              const orderPepproId =
	                typeof (order as any)?.integrationDetails?.wooCommerce?.pepproOrderId === "string"
	                  ? String((order as any).integrationDetails.wooCommerce.pepproOrderId).trim()
	                  : "";
	              return (
	                (optimisticNumber && orderNumber && orderNumber === optimisticNumber) ||
	                (optimisticId && orderId && orderId === optimisticId) ||
	                (optimisticPepproId && orderPepproId && orderPepproId === optimisticPepproId)
	              );
	            });
            if (exists) {
              postCheckoutOptimisticOrderRef.current = null;
            } else {
              normalized = [optimistic, ...normalized];
            }
          }
        }
        setAccountOrders(normalized);
        const fetchedAt =
          response &&
          typeof response === "object" &&
          (response as any).fetchedAt
            ? (response as any).fetchedAt
            : new Date().toISOString();
        setAccountOrdersSyncedAt(
          typeof fetchedAt === "string" ? fetchedAt : new Date().toISOString(),
        );
        const wooErrorMessage =
          response && typeof response === "object" && (response as any).wooError
            ? (response as any).wooError.message || null
            : null;
        setAccountOrdersError(wooErrorMessage);
        return normalized;
      } catch (error: any) {
        if (error?.code === "AUTH_REQUIRED") {
          setAccountOrders([]);
          setAccountOrdersSyncedAt(null);
          setAccountOrdersError(
            "Please sign in again to view your latest orders.",
          );
          setUser(null);
          toast.error("Your session expired. Please log in again.");
          return [];
        }
        const message =
          typeof error?.message === "string"
            ? error.message
            : "Unable to load orders.";
        setAccountOrdersError(message);
        throw error;
      } finally {
        setAccountOrdersLoading(false);
      }
    },
    [user?.id, showCanceledOrders],
  );

	  const triggerPostCheckoutOrdersRefresh = useCallback(async () => {
	    // Best-effort: Woo order creation can be eventually consistent; poll a few times so
	    // the brand new order shows up immediately in the Orders tab.
	    postCheckoutOrdersRefreshTimersRef.current.forEach((id) => window.clearTimeout(id));
	    postCheckoutOrdersRefreshTimersRef.current = [];

	    const meta = postCheckoutOrderRef.current;
	    const targetWooNumber = meta?.wooOrderNumber || null;
	    const targetWooId = meta?.wooOrderId || null;
	    const targetPepproId = meta?.pepproOrderId || null;
	    const attempts = [0, 900, 1800, 3500];

	    const tryRefresh = async () => {
	      try {
	        const latest = await loadAccountOrders({ force: true });
	        const found = latest.some((order) => {
	          const number = String(order.number || "").trim();
	          const id = String(order.id || "").trim();
	          const pepproId =
	            typeof (order as any)?.integrationDetails?.wooCommerce?.pepproOrderId === "string"
	              ? String((order as any).integrationDetails.wooCommerce.pepproOrderId).trim()
	              : "";
	          return (
	            (targetWooNumber && number && number === targetWooNumber) ||
	            (targetWooId && id && id === targetWooId) ||
	            (targetPepproId && pepproId && pepproId === targetPepproId)
	          );
	        });
	        if (found) return true;
	      } catch {
	        // ignore
	      }
	      return false;
	    };

	    // Immediate and a few short retries.
	    void tryRefresh();
	    for (const delayMs of attempts.slice(1)) {
	      const timerId = window.setTimeout(async () => {
	        const done = await tryRefresh();
        if (done) {
          postCheckoutOrdersRefreshTimersRef.current.forEach((id) => window.clearTimeout(id));
          postCheckoutOrdersRefreshTimersRef.current = [];
        }
      }, delayMs);
      postCheckoutOrdersRefreshTimersRef.current.push(timerId);
    }
  }, [loadAccountOrders]);

	  const handleCancelOrder = useCallback(
	    async (orderId: string) => {
	      if (!orderId) {
	        return;
	      }
	      try {
	        const result = (await ordersAPI.cancelOrder(
	          orderId,
	          "Cancelled via account portal",
	        )) as any;
	        const manualRefundReviewRequired =
	          Boolean(result?.manualRefundReviewRequired)
	          || (() => {
	            const paymentLabel = String(result?.order?.paymentMethod || result?.order?.paymentDetails || '');
	            const normalized = paymentLabel.toLowerCase();
	            return normalized.includes('zelle') || normalized.includes('bank') || normalized.includes('transfer');
	          })();
	        toast.success(
	          manualRefundReviewRequired
	            ? "Order canceled. If payment was already received, we’ll refund you manually."
	            : "Order canceled. A refund is pending.",
	        );
	        await loadAccountOrders();
	      } catch (error: any) {
	        if (error?.code === "AUTH_REQUIRED") {
	          setUser(null);
	          toast.error(
            "Your session expired. Please log in again to cancel orders.",
          );
          throw new Error("Please log in again to cancel orders.");
        }
        throw error;
      }
    },
    [loadAccountOrders],
  );

  const toggleShowCanceledOrders = useCallback(() => {
    setShowCanceledOrders((prev) => {
      const next = !prev;
      // Re-fetch with the updated includeCanceled flag so the UI reflects the toggle immediately.
      void loadAccountOrders({ includeCanceled: next }).catch(() => undefined);
      return next;
    });
  }, [loadAccountOrders]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const platform = await detectPlatformPasskeySupport();
      const conditional = detectConditionalPasskeySupport();
      if (!cancelled) {
        setPasskeySupport({
          platform,
          conditional,
          checked: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (newsLoadingTimeoutRef.current) {
        clearTimeout(newsLoadingTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setAccountOrders([]);
      setAccountOrdersSyncedAt(null);
      setAccountOrdersError(null);
      return;
    }
    loadAccountOrders();
  }, [user?.id, loadAccountOrders]);

  useEffect(() => {
    let cancelled = false;
    let retryTimeoutId: number | null = null;
    const warmApi = async () => {
      if (apiWarmupInFlight.current || cancelled) {
        return;
      }
      apiWarmupInFlight.current = true;
      try {
        await checkServerHealth();
        console.debug("[Health] API warmup complete");
      } catch (error) {
        console.warn("[Health] API warmup failed", error);
        if (!cancelled) {
          apiWarmupInFlight.current = false;
          retryTimeoutId = window.setTimeout(warmApi, 1200);
        }
        return;
      }
      apiWarmupInFlight.current = false;
    };
    warmApi();
    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, []);

  useEffect(() => {
    if (!user && loginPromptToken > 0) {
      checkServerHealth().catch((error) => {
        console.warn("[Health] Login prompt warmup failed", error);
      });
    }
  }, [loginPromptToken, user]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    if (user) {
      return undefined;
    }

    let cancelled = false;
    const leaderKey = "login-keepalive";
    const leaderTtlMs = Math.max(20_000, LOGIN_KEEPALIVE_INTERVAL_MS * 2);

    const sendKeepAlive = async () => {
      if (cancelled) {
        return;
      }
      if (!isPageVisible() || !isOnline()) {
        return;
      }
      if (!isTabLeader(leaderKey, leaderTtlMs)) {
        return;
      }
      try {
        await checkServerHealth();
      } catch (error) {
        if (!cancelled) {
          console.warn("[Health] Keep-alive ping failed", error);
        }
      }
    };

    sendKeepAlive();
    const intervalId = window.setInterval(() => {
      void sendKeepAlive();
    }, LOGIN_KEEPALIVE_INTERVAL_MS);

    return () => {
      cancelled = true;
      releaseTabLeadership(leaderKey);
      window.clearInterval(intervalId);
    };
  }, [user]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    if (!user) {
      return undefined;
    }
    const handlePageExit = () => {
      authAPI.markOffline();
    };
    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);
    return () => {
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
    };
  }, [user?.id]);

  useEffect(() => {
    if (postLoginHold && user && shouldAnimateInfoFocus) {
      setInfoFocusActive(true);
      const timeoutId = window.setTimeout(() => {
        setInfoFocusActive(false);
        setShouldAnimateInfoFocus(false);
      }, 1500);
      return () => {
        window.clearTimeout(timeoutId);
        setInfoFocusActive(false);
      };
    }
    if (!shouldAnimateInfoFocus) {
      setInfoFocusActive(false);
    }
  }, [postLoginHold, user?.id, shouldAnimateInfoFocus]);

  const applyLoginSuccessState = useCallback((nextUser: User) => {
    setUser(nextUser);
    setPostLoginHold(true);
    setShouldAnimateInfoFocus(true);
    setInfoFocusActive(true);
    const isReturning = (nextUser.visits ?? 1) > 1;
    setIsReturningUser(isReturning);
    setLoginContext(null);
    setShowLandingLoginPassword(false);
    setShowLandingSignupPassword(false);
    setShowLandingSignupConfirm(false);
    // Allow auto-registration attempt after each successful login
    passkeyAutoRegisterAttemptedRef.current = false;
  }, []);

  const performPasskeyLogin = useCallback(
    async (options?: {
      emailHint?: string | null;
      useConditionalUI?: boolean;
    }) => {
      const { requestId, publicKey } =
        await authAPI.passkeys.getAuthenticationOptions(
          options?.emailHint || undefined,
        );
      const assertion = await beginPasskeyAuthentication(
        publicKey,
        Boolean(options?.useConditionalUI),
      );
      const nextUser = await authAPI.passkeys.completeAuthentication({
        requestId,
        assertionResponse: assertion,
      });
      applyLoginSuccessState(nextUser);
      return nextUser;
    },
    [applyLoginSuccessState],
  );

  const startConditionalPasskeyLogin = useCallback(async () => {
    // Try conditional UI even if detection says unavailable; some browsers under-report support.
    if (user || passkeyConditionalInFlight.current) {
      return;
    }
    passkeyConditionalInFlight.current = true;
    try {
      await performPasskeyLogin({ useConditionalUI: true });
    } catch (error: any) {
      if (
        !(error instanceof DOMException) ||
        error.name !== "NotAllowedError"
      ) {
        console.debug("[Passkey] Conditional login dismissed or failed", error);
      } else {
        // User closed the prompt; disable autoprompt for this session so it does not reopen.
        setPasskeyAutopromptEnabled(false);
      }
    } finally {
      passkeyConditionalInFlight.current = false;
    }
  }, [performPasskeyLogin, user, setPasskeyAutopromptEnabled]);

  useEffect(() => {
    // Attempt conditional UI only once per session unless explicitly re-enabled.
    if (
      !user &&
      passkeyAutopromptEnabled &&
      passkeySupport.conditional &&
      !passkeyAutopromptAttemptedRef.current
    ) {
      passkeyAutopromptAttemptedRef.current = true;
      void startConditionalPasskeyLogin();
    }
  }, [
    user,
    passkeyAutopromptEnabled,
    passkeySupport.conditional,
    startConditionalPasskeyLogin,
  ]);

  const handleLandingCredentialFocus = useCallback(() => {
    // Only try to autofill saved username/password; do not auto-trigger passkey UI.
    void triggerLandingCredentialAutofill();
  }, [triggerLandingCredentialAutofill]);

  const handleManualPasskeyLogin = useCallback(async () => {
    if (!passkeySupport.platform) {
      setLandingLoginError("Passkey login is not available on this device.");
      return;
    }
    const emailInput = landingLoginEmailRef.current?.value?.trim();
    if (!emailInput) {
      setLandingLoginError("Enter your email to sign in with a passkey.");
      return;
    }
    setPasskeyLoginPending(true);
    setLandingLoginError("");
    try {
      await performPasskeyLogin({ emailHint: emailInput });
    } catch (error: any) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        return;
      }
      const message = (error?.message || "").toUpperCase();
      if (message.includes("PASSKEY_NOT_REGISTERED")) {
        setLandingLoginError(
          "No passkey found for that email yet. Sign in with your password once to enable passkeys.",
        );
      } else if (message.includes("EMAIL_NOT_FOUND")) {
        setLandingLoginError("We could not find that email.");
      } else {
        setLandingLoginError(
          "Unable to sign in with passkey. Please try again or use your password.",
        );
      }
      console.warn("[Passkey] Authentication failed", error);
    } finally {
      setPasskeyLoginPending(false);
    }
  }, [passkeySupport.platform, performPasskeyLogin]);

  const handleEnablePasskey = useCallback(async () => {
    if (!user) return;
    if (!passkeySupport.platform) {
      setEnablePasskeyError("Passkey setup is not available on this device.");
      return;
    }
    setEnablePasskeyPending(true);
    setEnablePasskeyError("");
    try {
      const { requestId, publicKey } =
        await authAPI.passkeys.getRegistrationOptions();
      const attestation = await beginPasskeyRegistration(publicKey);
      const result = await authAPI.passkeys.completeRegistration({
        requestId,
        attestationResponse: attestation,
        label: "This device",
      });
      if (result?.user) {
        setUser(result.user);
      }
    } catch (error: any) {
      const msg = (error?.message || "").toUpperCase();
      if (msg.includes("PASSKEY_ALREADY_REGISTERED")) {
        setEnablePasskeyError(
          "A passkey is already registered for this device.",
        );
      } else if (
        error instanceof DOMException &&
        error.name === "NotAllowedError"
      ) {
        // User canceled; do not show an error
      } else {
        setEnablePasskeyError(
          "Unable to enable biometric sign-in. Please try again.",
        );
      }
      console.warn("[Passkey] Registration failed", error);
    } finally {
      setEnablePasskeyPending(false);
    }
  }, [user, passkeySupport.platform]);

  // Optionally auto-register a passkey after successful login (opt-in via env).
  useEffect(() => {
    if (!PASSKEY_AUTOREGISTER) return;
    if (
      !user ||
      !passkeySupport.platform ||
      passkeyAutoRegisterAttemptedRef.current
    ) {
      return;
    }
    passkeyAutoRegisterAttemptedRef.current = true;
    void handleEnablePasskey();
  }, [user, passkeySupport.platform, handleEnablePasskey]);

	  useEffect(() => {
	    try {
	      const stored = localStorage.getItem("peppro:shop-enabled");
	      if (stored !== null) {
	        setShopEnabled(stored !== "false");
	      }
	    } catch {
	      setShopEnabled(true);
	    }
	    try {
	      const stored = localStorage.getItem("peppro:peptide-forum-enabled");
	      if (stored !== null) {
	        setPeptideForumEnabled(stored !== "false");
	      }
	    } catch {
	      setPeptideForumEnabled(true);
	    }
	    try {
	      const stored = localStorage.getItem("peppro:research-dashboard-enabled");
	      if (stored !== null) {
	        setResearchDashboardEnabled(stored !== "false");
	      }
	    } catch {
	      setResearchDashboardEnabled(false);
	    }
      try {
        const stored = localStorage.getItem("peppro:test-payments-override-enabled");
        if (stored !== null) {
          setTestPaymentsOverrideEnabled(stored === "true");
        }
      } catch {
        setTestPaymentsOverrideEnabled(false);
      }
	    let researchSupported = true;
	    try {
	      const stored = localStorage.getItem("peppro:settings-support:research");
	      if (stored !== null) {
	        researchSupported = stored !== "false";
	      }
	    } catch {
	      researchSupported = true;
	    }
	    setSettingsSupport((prev) => ({ ...prev, research: researchSupported }));
		    let cancelled = false;
		    const fetchSetting = async () => {
		      try {
		        const [shopResult, forumResult, researchResult] = await Promise.allSettled([
		          settingsAPI.getShopStatus(),
		          settingsAPI.getForumStatus(),
		          settingsAPI.getResearchStatus(),
		        ]);
		        if (cancelled) return;
	        if (shopResult.status === "fulfilled") {
	          const shop = shopResult.value as any;
	          if (shop && typeof shop.shopEnabled === "boolean") {
	            setShopEnabled(shop.shopEnabled);
	            localStorage.setItem(
	              "peppro:shop-enabled",
	              shop.shopEnabled ? "true" : "false",
	            );
	          }
	        }

	        if (forumResult.status === "fulfilled") {
	          const classes = forumResult.value as any;
	          if (classes && typeof classes.peptideForumEnabled === "boolean") {
	            setPeptideForumEnabled(classes.peptideForumEnabled);
	            localStorage.setItem(
	              "peppro:peptide-forum-enabled",
	              classes.peptideForumEnabled ? "true" : "false",
	            );
	          }
	        }

		        if (researchResult.status === "fulfilled") {
		          const research = researchResult.value as any;
		          if (research && typeof research.researchDashboardEnabled === "boolean") {
		            setSettingsSupport((prev) => ({ ...prev, research: true }));
		            try {
		              localStorage.setItem("peppro:settings-support:research", "true");
		            } catch {
		              // ignore
		            }
		            setResearchDashboardEnabled(research.researchDashboardEnabled);
		            localStorage.setItem(
		              "peppro:research-dashboard-enabled",
		              research.researchDashboardEnabled ? "true" : "false",
	            );
	          }
	        } else {
	          const reason: any = (researchResult as PromiseRejectedResult).reason;
	          const status = typeof reason?.status === "number" ? reason.status : null;
		          if (status === 404) {
		            setSettingsSupport((prev) => ({ ...prev, research: false }));
		            try {
		              localStorage.setItem("peppro:settings-support:research", "false");
		            } catch {
		              // ignore
		            }
		          }
		        }
	      } catch (error) {
	        console.warn(
	          "[Settings] Unable to load settings, using local fallback",
	          error,
        );
      }
    };
    fetchSetting();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user || !isAdmin(user.role) || postLoginHold) {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = (await settingsAPI.getTestPaymentsOverrideStatus()) as any;
        if (cancelled) return;
        if (result && typeof result.testPaymentsOverrideEnabled === "boolean") {
          setTestPaymentsOverrideEnabled(result.testPaymentsOverrideEnabled);
          try {
            localStorage.setItem(
              "peppro:test-payments-override-enabled",
              result.testPaymentsOverrideEnabled ? "true" : "false",
            );
          } catch {
            // ignore
          }
        }
      } catch (error: any) {
        const status = typeof error?.status === "number" ? error.status : null;
        if (status && status !== 404) {
          console.warn("[Settings] Failed to refresh test payments override", error);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role, postLoginHold]);

	  useEffect(() => {
	    if (!user) return;
	    let cancelled = false;
	    const refreshResearchSetting = async () => {
	      try {
	        const research = await settingsAPI.getResearchStatus();
	        if (cancelled) return;
	        if (research && typeof (research as any).researchDashboardEnabled === "boolean") {
	          setSettingsSupport((prev) => ({ ...prev, research: true }));
	          try {
	            localStorage.setItem("peppro:settings-support:research", "true");
	          } catch {
	            // ignore
	          }
	          setResearchDashboardEnabled((research as any).researchDashboardEnabled);
	          try {
	            localStorage.setItem(
	              "peppro:research-dashboard-enabled",
	              (research as any).researchDashboardEnabled ? "true" : "false",
	            );
	          } catch {
	            // ignore
	          }
	        }
	      } catch (error) {
	        const status =
	          typeof (error as any)?.status === "number" ? (error as any).status : null;
	        if (status === 404) {
	          setSettingsSupport((prev) => ({ ...prev, research: false }));
	          try {
	            localStorage.setItem("peppro:settings-support:research", "false");
	          } catch {
	            // ignore
	          }
	        } else {
	          console.warn("[Research] Failed to refresh research setting", error);
	        }
	      }
	    };
	    refreshResearchSetting();
	    return () => {
	      cancelled = true;
	    };
	  }, [user?.id]);

		  const handleShopToggle = useCallback(
		    async (value: boolean) => {
		      if (!isAdmin(user?.role)) {
		        return;
		      }
	      setSettingsSaving((prev) => ({ ...prev, shop: true }));
	      let previousValue = true;
	      setShopEnabled((prev) => {
	        previousValue = prev;
	        return value;
	      });
	      try {
	        localStorage.setItem("peppro:shop-enabled", value ? "true" : "false");
	      } catch {
	        // ignore
	      }
	      try {
	        const updated = await settingsAPI.updateShopStatus(value);
	        const confirmed =
	          updated && typeof (updated as any).shopEnabled === "boolean"
	            ? (updated as any).shopEnabled
	            : value;
	        setShopEnabled(confirmed);
	        try {
	          localStorage.setItem(
	            "peppro:shop-enabled",
	            confirmed ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } catch (error) {
	        console.warn("[Shop] Failed to update shop toggle", error);
	        toast.error("Unable to update Shop setting right now.");
	        setShopEnabled(previousValue);
	        try {
	          localStorage.setItem(
	            "peppro:shop-enabled",
	            previousValue ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } finally {
	        setSettingsSaving((prev) => ({ ...prev, shop: false }));
	      }
	    },
	    [user?.role],
	  );

	  const handlePeptideForumToggle = useCallback(
	    async (value: boolean) => {
	      if (!isAdmin(user?.role)) {
	        return;
	      }
	      setSettingsSaving((prev) => ({ ...prev, forum: true }));
	      let previousValue = true;
	      setPeptideForumEnabled((prev) => {
	        previousValue = prev;
	        return value;
	      });
	      try {
	        localStorage.setItem(
	          "peppro:peptide-forum-enabled",
	          value ? "true" : "false",
        );
	      } catch {
	        // ignore
	      }
	      try {
	        const updated = await settingsAPI.updateForumStatus(value);
	        const confirmed =
	          updated && typeof (updated as any).peptideForumEnabled === "boolean"
	            ? (updated as any).peptideForumEnabled
	            : value;
	        setPeptideForumEnabled(confirmed);
	        try {
	          localStorage.setItem(
	            "peppro:peptide-forum-enabled",
	            confirmed ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } catch (error) {
	        console.warn("[Forum] Failed to update forum toggle", error);
	        toast.error("Unable to update Forum setting right now.");
	        setPeptideForumEnabled(previousValue);
	        try {
	          localStorage.setItem(
	            "peppro:peptide-forum-enabled",
	            previousValue ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } finally {
	        setSettingsSaving((prev) => ({ ...prev, forum: false }));
	      }
	    },
	    [user?.role],
	  );

	  const handleResearchDashboardToggle = useCallback(
	    async (value: boolean) => {
	      if (!isAdmin(user?.role)) {
	        return;
	      }
	      if (!settingsSupport.research) {
	        toast.error("Research setting isn't available on this server yet.");
	        return;
	      }
	      setSettingsSaving((prev) => ({ ...prev, research: true }));
	      let previousValue = false;
	      setResearchDashboardEnabled((prev) => {
	        previousValue = prev;
	        return value;
	      });
	      try {
	        localStorage.setItem(
	          "peppro:research-dashboard-enabled",
	          value ? "true" : "false",
	        );
	      } catch {
	        // ignore
	      }
	      try {
	        const updated = await settingsAPI.updateResearchStatus(value);
	        const confirmed =
	          updated &&
	          typeof (updated as any).researchDashboardEnabled === "boolean"
	            ? (updated as any).researchDashboardEnabled
	            : value;
	        setResearchDashboardEnabled(confirmed);
	        try {
	          localStorage.setItem(
	            "peppro:research-dashboard-enabled",
	            confirmed ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } catch (error) {
	        console.warn("[Research] Failed to update research toggle", error);
	        const status = typeof (error as any)?.status === "number" ? (error as any).status : null;
	        if (status === 404) {
	          setSettingsSupport((prev) => ({ ...prev, research: false }));
	          try {
	            localStorage.setItem("peppro:settings-support:research", "false");
	          } catch {
	            // ignore
	          }
	          toast.error("Research setting isn't available on this server yet.");
	        }
	        if (status === null) {
	          try {
	            await settingsAPI.getResearchStatus();
	          } catch (probeError) {
	            const probeStatus =
	              typeof (probeError as any)?.status === "number"
	                ? (probeError as any).status
	                : null;
	            if (probeStatus === 404) {
	              setSettingsSupport((prev) => ({ ...prev, research: false }));
	              try {
	                localStorage.setItem("peppro:settings-support:research", "false");
	              } catch {
	                // ignore
	              }
	            }
	          }
	        }
	        if (status !== 404) {
	          toast.error("Unable to update Research setting right now.");
	        }
	        setResearchDashboardEnabled(previousValue);
	        try {
	          localStorage.setItem(
	            "peppro:research-dashboard-enabled",
	            previousValue ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } finally {
	        setSettingsSaving((prev) => ({ ...prev, research: false }));
	      }
	    },
	    [user?.role],
	  );

	  const handleTestPaymentsOverrideToggle = useCallback(
	    async (value: boolean) => {
	      if (!isAdmin(user?.role)) {
	        return;
	      }
	      setSettingsSaving((prev) => ({ ...prev, testPaymentsOverride: true }));
	      let previousValue = false;
	      setTestPaymentsOverrideEnabled((prev) => {
	        previousValue = prev;
	        return value;
	      });
	      try {
	        localStorage.setItem(
	          "peppro:test-payments-override-enabled",
	          value ? "true" : "false",
	        );
	      } catch {
	        // ignore
	      }
	      try {
	        const updated = await settingsAPI.updateTestPaymentsOverrideStatus(value);
	        const confirmed =
	          updated && typeof (updated as any).testPaymentsOverrideEnabled === "boolean"
	            ? (updated as any).testPaymentsOverrideEnabled
	            : value;
	        setTestPaymentsOverrideEnabled(confirmed);
	        try {
	          localStorage.setItem(
	            "peppro:test-payments-override-enabled",
	            confirmed ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } catch (error) {
	        console.warn("[Payments] Failed to update test payments override", error);
	        toast.error("Unable to update test payments override right now.");
	        setTestPaymentsOverrideEnabled(previousValue);
	        try {
	          localStorage.setItem(
	            "peppro:test-payments-override-enabled",
	            previousValue ? "true" : "false",
	          );
	        } catch {
	          // ignore
	        }
	      } finally {
	        setSettingsSaving((prev) => ({ ...prev, testPaymentsOverride: false }));
	      }
	    },
	    [user?.role],
	  );

  // (handled directly in handleLogin/handleCreateAccount to avoid flicker)
  const [landingLoginError, setLandingLoginError] = useState("");
  const [landingSignupError, setLandingSignupError] = useState("");
  const [landingNpiStatus, setLandingNpiStatus] = useState<
    "idle" | "checking" | "verified" | "rejected"
  >("idle");
  const [landingNpiMessage, setLandingNpiMessage] = useState("");
  const landingNpiRecordRef = useRef<{
    name?: string | null;
    verifiedNpiNumber?: string;
  } | null>(null);
  const landingNpiCheckIdRef = useRef(0);
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    types: [],
  });
  const [doctorSummary, setDoctorSummary] =
    useState<DoctorCreditSummary | null>(null);
  const availableReferralCredits = Math.max(
    0,
    Number(doctorSummary?.availableCredits ?? user?.referralCredits ?? 0),
  );
  const [doctorReferrals, setDoctorReferrals] = useState<ReferralRecord[]>([]);
  const [salesRepDashboard, setSalesRepDashboard] =
    useState<SalesRepDashboard | null>(null);

  const normalizeEmailIdentity = useCallback((value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    let email = String(value).trim();
    if (!email) return null;
    email = email.replace(/^mailto:/i, "").trim();
    const angleMatch = email.match(/<([^>]+)>/);
    if (angleMatch?.[1]) {
      email = angleMatch[1].trim();
    }
    email = email.replace(/\s+/g, "").toLowerCase();
    return email && email.includes("@") ? email : null;
  }, []);

  const buildEmailIdentityKeys = useCallback(
    (value: unknown): string[] => {
      const email = normalizeEmailIdentity(value);
      if (!email) return [];
      const keys = new Set<string>();
      const add = (candidate: string) => {
        const normalized = candidate.trim().toLowerCase();
        if (!normalized) return;
        keys.add(normalized);
        keys.add(`email:${normalized}`);
      };
      add(email);
      const [local, domain] = email.split("@", 2);
      if (!local || !domain) {
        return Array.from(keys);
      }
      const localNoPlus = local.split("+", 1)[0];
      if (localNoPlus) {
        add(`${localNoPlus}@${domain}`);
      }
      if (domain === "gmail.com" || domain === "googlemail.com") {
        const gmailLocal = localNoPlus.replace(/\./g, "");
        if (gmailLocal) {
          add(`${gmailLocal}@${domain}`);
        }
      }
      return Array.from(keys);
    },
    [normalizeEmailIdentity],
  );

  const buildPhoneIdentityKeys = useCallback((value: unknown): string[] => {
    if (value === null || value === undefined) return [];
    const raw = String(value).trim();
    if (!raw) return [];
    const digits = raw.replace(/\D/g, "");
    const keys = new Set<string>();
    keys.add(`phone:${raw}`);
    if (digits) {
      keys.add(`phone:${digits}`);
      if (digits.length === 11 && digits.startsWith("1")) {
        keys.add(`phone:${digits.slice(1)}`);
      }
    }
    return Array.from(keys);
  }, []);

  const normalizeIdentityKey = useCallback((value: string | null): string | null => {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();
    return normalized ? normalized : null;
  }, []);

  const debugAccountMatch = useMemo(() => {
    if (typeof window === "undefined") return false;
    const raw = new URLSearchParams(window.location.search).get("debugAccountMatch");
    if (raw === null) return false;
    if (raw === "" || raw === "1") return true;
    return ["true", "yes", "on"].includes(raw.toLowerCase().trim());
  }, []);

  const accountIdentitySet = useMemo(() => {
    const dashboardAny = salesRepDashboard as any;
    const rawAccounts = [
      ...(Array.isArray(dashboardAny?.users) ? dashboardAny.users : []),
      ...(Array.isArray(dashboardAny?.accounts) ? dashboardAny.accounts : []),
      ...(Array.isArray(dashboardAny?.doctors) ? dashboardAny.doctors : []),
    ];
    const keys = new Set<string>();
    const addKey = (value?: string | null) => {
      if (!value) return;
      const normalized = String(value).trim().toLowerCase();
      if (normalized) {
        keys.add(normalized);
      }
    };
    rawAccounts.forEach((acct: any) => {
      const acctRole = normalizeRole(acct?.role);
      if (acctRole === "admin" || acctRole === "sales_rep" || acctRole === "rep") {
        return;
      }
      const emailValue =
        acct?.email || acct?.referredContactEmail || acct?.userEmail || acct?.doctorEmail;
      const phone =
        acct?.phone ||
        acct?.phoneNumber ||
        acct?.phone_number ||
        acct?.referredContactPhone ||
        null;
      buildEmailIdentityKeys(emailValue).forEach((key) => addKey(key));
      buildPhoneIdentityKeys(phone).forEach((key) => addKey(key));
      addKey(acct?.id !== undefined && acct?.id !== null ? `acct:${String(acct.id).trim()}` : null);
      addKey(
        acct?.userId !== undefined && acct?.userId !== null ? `acct:${String(acct.userId).trim()}` : null,
      );
      addKey(
        acct?.doctorId !== undefined && acct?.doctorId !== null
          ? `acct:${String(acct.doctorId).trim()}`
          : null,
      );
      addKey(
        acct?.accountId !== undefined && acct?.accountId !== null
          ? `acct:${String(acct.accountId).trim()}`
          : null,
      );
      addKey(
        acct?.account_id !== undefined && acct?.account_id !== null
          ? `acct:${String(acct.account_id).trim()}`
          : null,
      );
    });
    return keys;
  }, [buildEmailIdentityKeys, buildPhoneIdentityKeys, salesRepDashboard]);

  const accountProfileLookup = useMemo(() => {
    const dashboardAny = salesRepDashboard as any;
    const rawAccounts = [
      ...(Array.isArray(dashboardAny?.users) ? dashboardAny.users : []),
      ...(Array.isArray(dashboardAny?.accounts) ? dashboardAny.accounts : []),
      ...(Array.isArray(dashboardAny?.doctors) ? dashboardAny.doctors : []),
    ];

    type Profile = { name: string; email?: string | null; profileImageUrl?: string | null };
    const map = new Map<string, Profile>();
    const setKey = (key: string | null | undefined, profile: Profile) => {
      if (!key) return;
      const normalized = String(key).trim().toLowerCase();
      if (!normalized) return;
      const existing = map.get(normalized);
      if (!existing || (!existing.profileImageUrl && profile.profileImageUrl)) {
        map.set(normalized, profile);
      }
    };

    rawAccounts.forEach((acct: any) => {
      const acctRole = normalizeRole(acct?.role);
      if (acctRole === "admin" || acctRole === "sales_rep" || acctRole === "rep") {
        return;
      }
      const email = normalizeEmailIdentity(
        acct?.email || acct?.referredContactEmail || acct?.userEmail || acct?.doctorEmail,
      );
      const phone =
        acct?.phone ||
        acct?.phoneNumber ||
        acct?.phone_number ||
        acct?.referredContactPhone ||
        null;
      const accountId =
        acct?.id ||
        acct?.userId ||
        acct?.doctorId ||
        acct?.accountId ||
        acct?.account_id ||
        acct?.referredContactAccountId ||
        null;

      const name =
        acct?.name ||
        [acct?.firstName, acct?.lastName].filter(Boolean).join(" ").trim() ||
        acct?.doctorName ||
        acct?.username ||
        email ||
        "Account";

      const profileImageUrl =
        acct?.profileImageUrl ||
        acct?.profile_image_url ||
        acct?.avatar ||
        acct?.avatarUrl ||
        null;

      const profile: Profile = {
        name,
        email: email || acct?.referredContactEmail || null,
        profileImageUrl,
      };

      buildEmailIdentityKeys(email).forEach((key) => setKey(key, profile));
      if (phone) {
        buildPhoneIdentityKeys(phone).forEach((key) => setKey(key, profile));
      }
      if (accountId) {
        const trimmed = String(accountId).trim();
        if (trimmed) {
          setKey(`acct:${trimmed}`, profile);
          setKey(`acct:${trimmed.toLowerCase()}`, profile);
          setKey(trimmed, profile);
        }
      }
    });

    return map;
  }, [buildEmailIdentityKeys, buildPhoneIdentityKeys, normalizeEmailIdentity, salesRepDashboard]);
  const normalizedReferrals = useMemo(
    () =>
      (() => {
        let debugPrinted = 0;
        const hasKey = (key: string | null): boolean => {
          const normalized = normalizeIdentityKey(key);
          return normalized ? accountIdentitySet.has(normalized) : false;
        };

        return (salesRepDashboard?.referrals ?? []).map((ref) => {
          const hasAccountFlag = typeof ref.referredContactHasAccount === "boolean"
            ? ref.referredContactHasAccount
            : null;
          const shouldUseFallback = hasAccountFlag === null;
          const emailKeys = shouldUseFallback
            ? buildEmailIdentityKeys(ref.referredContactEmail)
            : [];
          const phoneKeys = shouldUseFallback
            ? buildPhoneIdentityKeys(ref.referredContactPhone)
            : [];
          const acctIdRaw =
            ref.referredContactAccountId !== undefined && ref.referredContactAccountId !== null
              ? String(ref.referredContactAccountId).trim()
              : "";
          const acctKey = acctIdRaw ? `acct:${acctIdRaw}` : null;

          const matchByEmail = shouldUseFallback ? emailKeys.some((key) => hasKey(key)) : false;
          const matchByPhone = shouldUseFallback ? phoneKeys.some((key) => hasKey(key)) : false;
          const matchByAccountId = shouldUseFallback ? hasKey(acctKey) : false;
          const hasAccountMatch = shouldUseFallback
            ? (matchByEmail || matchByPhone || matchByAccountId)
            : Boolean(hasAccountFlag);

          if (
            debugAccountMatch &&
            shouldUseFallback &&
            !hasAccountMatch &&
            debugPrinted < 25 &&
            (emailKeys.length > 0 || phoneKeys.length > 0 || acctKey)
          ) {
            debugPrinted += 1;
            console.info("[AccountMatch] no match", {
              referredContactName: ref.referredContactName || null,
              referredContactEmail: ref.referredContactEmail || null,
              referredContactPhone: ref.referredContactPhone || null,
              referredContactAccountId: ref.referredContactAccountId || null,
              normalizedKeys: {
                emailKeys,
                phoneKeys,
                acctKey,
              },
              matched: {
                byEmail: matchByEmail,
                byPhone: matchByPhone,
                byAccountId: matchByAccountId,
              },
            });
          }

          return {
            ...ref,
            status: sanitizeReferralStatus(ref.status),
            referredContactName: toTitleCase(ref.referredContactName),
            referrerDoctorName: toTitleCase(ref.referrerDoctorName),
            referredContactHasAccount: hasAccountMatch,
          };
        });
      })(),
    [
      accountIdentitySet,
      buildPhoneIdentityKeys,
      buildEmailIdentityKeys,
      debugAccountMatch,
      normalizeEmailIdentity,
      normalizeIdentityKey,
      salesRepDashboard?.referrals,
    ],
  );
  const resolveOrderDoctorId = useCallback(
    (order: AccountOrderSummary): string | null => {
      const asAny = order as Record<string, any>;
      const integration = (order.integrationDetails ||
        order.integrations) as Record<string, any> | null;
      const candidate =
        asAny.userId ??
        asAny.user_id ??
        asAny.doctorId ??
        asAny.doctor_id ??
        asAny.salesRepDoctorId ??
        asAny.sales_rep_doctor_id ??
        integration?.doctorId ??
        integration?.referrerDoctorId ??
        integration?.doctor_id ??
        integration?.referrer_doctor_id ??
        integration?.userId ??
        null;
      if (!candidate) {
        return null;
      }
      return String(candidate);
    },
    [],
  );
  const isCurrentUserLead = useCallback(
    (lead: any) => {
      if (!user?.email) return false;
      const email = (lead?.referredContactEmail || "").toLowerCase();
      return email.length > 0 && email === user.email.toLowerCase();
    },
    [user?.email],
  );
  const userId = user?.id || null;
	  const userRole = user?.role || null;
	  const userSalesRepId = user?.salesRepId || null;
	  const salesDoctorNotesStorageKey = useMemo(() => {
	    const ownerKey = userSalesRepId || userId || null;
	    return ownerKey ? `peppro:sales-doctor-notes:v1:${String(ownerKey)}` : null;
	  }, [userId, userSalesRepId]);
	  const [salesDoctorNotes, setSalesDoctorNotes] = useState<Record<string, string>>(
	    {},
	  );
	  const [salesDoctorNoteDraft, setSalesDoctorNoteDraft] = useState<string>("");
	
	  useEffect(() => {
	    if (!salesDoctorNotesStorageKey) {
	      setSalesDoctorNotes({});
	      return;
	    }
	    if (typeof window === "undefined") {
	      return;
	    }
	    try {
	      const raw = window.localStorage.getItem(salesDoctorNotesStorageKey);
	      if (!raw) {
	        setSalesDoctorNotes({});
	        return;
	      }
	      const parsed = JSON.parse(raw);
	      if (parsed && typeof parsed === "object") {
	        setSalesDoctorNotes(parsed as Record<string, string>);
	      } else {
	        setSalesDoctorNotes({});
	      }
	    } catch {
	      setSalesDoctorNotes({});
	    }
	  }, [salesDoctorNotesStorageKey]);
	
	  const persistSalesDoctorNotes = useCallback(
	    (next: Record<string, string>) => {
	      setSalesDoctorNotes(next);
	      if (!salesDoctorNotesStorageKey || typeof window === "undefined") {
	        return;
	      }
	      try {
	        window.localStorage.setItem(
	          salesDoctorNotesStorageKey,
	          JSON.stringify(next),
	        );
	      } catch {
	        // ignore
	      }
	    },
	    [salesDoctorNotesStorageKey],
	  );
  const [salesTrackingOrders, setSalesTrackingOrders] = useState<
    AccountOrderSummary[]
  >([]);
  const orderIdentitySet = useMemo(() => {
    const set = new Set<string>();
    salesTrackingOrders.forEach((order) => {
      const doctorId = resolveOrderDoctorId(order) || order.userId || order.doctorId;
      if (doctorId) {
        set.add(`id:${String(doctorId)}`);
      }
      const emails = [
        (order as any).userEmail,
        (order as any).doctorEmail,
        (order as any).email,
      ];
      emails.forEach((email) => {
        if (email && typeof email === "string") {
          set.add(`email:${email.toLowerCase()}`);
        }
      });
    });
    return set;
  }, [resolveOrderDoctorId, salesTrackingOrders]);

	  const hasLeadPlacedOrder = useCallback(
	    (lead: any) => {
	      const currentUserId = user?.id != null ? String(user.id) : "";
	      const currentEmail =
	        typeof user?.email === "string" ? user.email.toLowerCase() : "";
	      const leadEmailRaw =
	        typeof lead?.referredContactEmail === "string"
	          ? lead.referredContactEmail
	          : typeof lead?.email === "string"
	            ? lead.email
	            : "";
	      const leadEmail = leadEmailRaw ? leadEmailRaw.toLowerCase() : "";
	      if (currentEmail && leadEmail && currentEmail === leadEmail) {
	        return false;
	      }
	      const leadAccountId =
	        lead?.referredContactAccountId ||
	        lead?.referredContactId ||
	        lead?.userId ||
	        lead?.doctorId;
	      if (currentUserId && leadAccountId && String(leadAccountId) === currentUserId) {
	        return false;
	      }

	      const orders =
	        coerceNumber(lead?.referredContactTotalOrders) ??
	        coerceNumber(lead?.totalOrders) ??
	        0;
	      if (orders > 0) return true;

	      const email = leadEmail;
	      if (email && orderIdentitySet.has(`email:${email}`)) {
	        return true;
	      }

	      if (leadAccountId && orderIdentitySet.has(`id:${String(leadAccountId)}`)) {
	        return true;
	      }

	      return false;
	    },
	    [orderIdentitySet, user?.email, user?.id],
	  );
		  const shouldRemoveFromActiveProspects = useCallback(
		    (lead: any) => {
		      if (lead?.creditIssuedAt) {
		        return true;
		      }
			      const status = sanitizeReferralStatus(lead?.status);
			      if (status === "nuture") {
			        return true;
			      }
			      // Converted prospects stay active until the rep explicitly clicks "Credit",
			      // even if the doctor has already placed an order.
			      if (status === "converted") {
			        return false;
			      }
			      return hasLeadPlacedOrder(lead);
			    },
			    [hasLeadPlacedOrder],
			  );

	  const normalizeNotesValue = useCallback((value: unknown): string | null => {
	    if (typeof value !== "string") {
	      return null;
	    }
	    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	    if (!normalized.trim()) {
	      return null;
	    }
	    return normalized;
	  }, []);

	  type SalesOrderEditableFields = {
	    trackingNumber: string;
	    shippingCarrier: string;
	    shippingService: string;
	    status: string;
	    expectedShipmentWindow: string;
	  };

	  const deriveSalesOrderEditableFields = useCallback(
	    (order: AccountOrderSummary | null): SalesOrderEditableFields => {
	      const trackingResolved = order ? resolveTrackingNumber(order as any) : null;
	      const trackingDirect =
	        order && typeof (order as any)?.trackingNumber === "string"
	          ? String((order as any).trackingNumber).trim()
	          : "";
	      const carrier =
	        (order && typeof (order as any)?.shippingCarrier === "string"
	          ? String((order as any).shippingCarrier)
	          : "") ||
	        (order && typeof (order.shippingEstimate as any)?.carrierId === "string"
	          ? String((order.shippingEstimate as any).carrierId)
	          : "") ||
	        "";
	      const service =
	        (order && typeof (order as any)?.shippingService === "string"
	          ? String((order as any).shippingService)
	          : "") ||
	        (order && typeof (order.shippingEstimate as any)?.serviceType === "string"
	          ? String((order.shippingEstimate as any).serviceType)
	          : "") ||
	        "";
	      const status = order && typeof order.status === "string" ? String(order.status) : "";
	      const expected =
	        order && typeof (order as any)?.expectedShipmentWindow === "string"
	          ? String((order as any).expectedShipmentWindow)
	          : "";
	      return {
	        trackingNumber: (trackingDirect || trackingResolved || "").toString().trim(),
	        shippingCarrier: carrier.toString().trim(),
	        shippingService: service.toString().trim(),
	        status: status.toString().trim(),
	        expectedShipmentWindow: expected.toString().trim(),
	      };
	    },
	    [],
	  );

	  const normalizeEditableField = (value: unknown): string | null => {
	    const trimmed = String(value || "").trim();
	    return trimmed.length ? trimmed : null;
	  };

	  const [salesOrderFieldsDraft, setSalesOrderFieldsDraft] =
	    useState<SalesOrderEditableFields>({
	      trackingNumber: "",
	      shippingCarrier: "",
	      shippingService: "",
	      status: "",
	      expectedShipmentWindow: "",
	    });
	  const [salesOrderFieldsSaved, setSalesOrderFieldsSaved] =
	    useState<SalesOrderEditableFields>({
	      trackingNumber: "",
	      shippingCarrier: "",
	      shippingService: "",
	      status: "",
	      expectedShipmentWindow: "",
	    });
	  const [salesOrderFieldsSaving, setSalesOrderFieldsSaving] = useState(false);
	  const salesOrderFieldsInitializedForRef = useRef<string | null>(null);
  const [salesOrderDetail, setSalesOrderDetail] =
    useState<AccountOrderSummary | null>(null);
  const [salesOrderDetailLoading, setSalesOrderDetailLoading] = useState(false);
  const [trackingStatusByNumber, setTrackingStatusByNumber] = useState<Record<string, CarrierTrackingInfo>>({});
  const trackingStatusByNumberRef = useRef<Record<string, CarrierTrackingInfo>>({});
  useEffect(() => {
    trackingStatusByNumberRef.current = trackingStatusByNumber;
  }, [trackingStatusByNumber]);
  const [salesOrderNotesDraft, setSalesOrderNotesDraft] = useState<string>("");
  const [salesOrderNotesSaving, setSalesOrderNotesSaving] = useState(false);
  const [salesOrderHydratingIds, setSalesOrderHydratingIds] = useState<
    Set<string>
  >(new Set());
  const [collapsedSalesDoctorIds, setCollapsedSalesDoctorIds] = useState<
    Set<string>
  >(new Set());
  const [collapsedReferralIds, setCollapsedReferralIds] = useState<
    Set<string>
  >(new Set());
  const hasInitializedSalesCollapseRef = useRef(false);
  const knownSalesDoctorIdsRef = useRef<Set<string>>(new Set());
  const salesTrackingOrdersRef = useRef<AccountOrderSummary[]>([]);
		  const [salesDoctorDetail, setSalesDoctorDetail] = useState<{
		    doctorId: string;
		    referralId?: string | null;
		    name: string;
		    email?: string | null;
	    avatar?: string | null;
		    revenue: number;
		    personalRevenue?: number | null;
		    salesRevenue?: number | null;
		    salesWholesaleRevenue?: number | null;
		    salesRetailRevenue?: number | null;
		    orderQuantity?: number | null;
		    totalOrderValue?: number | null;
		    orders: AccountOrderSummary[];
        personalOrders?: AccountOrderSummary[];
        salesOrders?: AccountOrderSummary[];
	    phone?: string | null;
	    address?: string | null;
	    lastOrderDate?: string | null;
	    avgOrderValue?: number | null;
	    role: string;
	    ownerSalesRepId?: string | null;
	    ownerSalesRepName?: string | null;
	    ownerSalesRepEmail?: string | null;
	    isOnline?: boolean | null;
	    isIdle?: boolean | null;
	    idleMinutes?: number | null;
	    lastSeenAt?: string | null;
	    lastInteractionAt?: string | null;
    lastLoginAt?: string | null;
	  } | null>(null);
	  const [salesDoctorDetailLoading, setSalesDoctorDetailLoading] = useState(false);
	  const [salesDoctorCommissionRange, setSalesDoctorCommissionRange] = useState<
	    DateRange | undefined
	  >(undefined);
	  const [salesDoctorCommissionPickerOpen, setSalesDoctorCommissionPickerOpen] =
	    useState(false);
		  const [salesDoctorOwnerRepProfiles, setSalesDoctorOwnerRepProfiles] = useState<
		    Record<
		      string,
		      {
		        id: string;
		        name: string | null;
		        email: string | null;
		        role: string | null;
		        userId?: string | null;
		      }
		    >
		  >({});
		  const salesDoctorOwnerRepFetchInFlightRef = useRef<Set<string>>(new Set());
	  const [salesDoctorCommissionFromReport, setSalesDoctorCommissionFromReport] =
	    useState<number | null>(null);
	  const [salesDoctorCommissionFromReportLoading, setSalesDoctorCommissionFromReportLoading] =
	    useState(false);
	  const salesDoctorCommissionFromReportKeyRef = useRef<string>("");

	  useEffect(() => {
	    setSalesDoctorCommissionRange(undefined);
	    setSalesDoctorCommissionPickerOpen(false);
	    setSalesDoctorCommissionFromReport(null);
	    setSalesDoctorCommissionFromReportLoading(false);
	    salesDoctorCommissionFromReportKeyRef.current = "";
	  }, [salesDoctorDetail?.doctorId]);

		  useEffect(() => {
		    const canSeeOwner =
		      Boolean(user?.role) && (isAdmin(user?.role) || isSalesLead(user?.role));
		    if (!canSeeOwner) return;
		    if (!salesDoctorDetail?.doctorId) return;
		    if (!isDoctorRole(salesDoctorDetail.role)) return;
		    const ownerId = String(salesDoctorDetail.ownerSalesRepId || "").trim();
		    if (!ownerId) return;
		    if (salesDoctorOwnerRepProfiles[ownerId]) return;
		    if (salesDoctorOwnerRepFetchInFlightRef.current.has(ownerId)) return;

		    salesDoctorOwnerRepFetchInFlightRef.current.add(ownerId);
		    const localName =
		      typeof salesDoctorDetail?.ownerSalesRepName === "string"
		        ? salesDoctorDetail.ownerSalesRepName.trim()
		        : "";
		    const localEmail =
		      typeof salesDoctorDetail?.ownerSalesRepEmail === "string"
		        ? salesDoctorDetail.ownerSalesRepEmail.trim()
		        : "";
		    (async () => {
		      try {
		        if (localName || localEmail) {
		          setSalesDoctorOwnerRepProfiles((current) => ({
		            ...current,
		            [ownerId]: {
		              id: ownerId,
		              name: localName || null,
		              email: localEmail || null,
		              role: "sales_rep",
		              userId: null,
		            },
		          }));
		          return;
		        }

		        // Fetch the doctor record to resolve its `salesRepId` (maps to `users.sales_rep_id`).
		        const doctorId = String(salesDoctorDetail?.doctorId || "").trim();
		        if (!doctorId) return;
		        const userResp = (await settingsAPI.getAdminUserProfile(doctorId)) as any;
		        const doctorProfile = userResp?.user || null;
		        const salesRepId = String(
		          doctorProfile?.salesRepId ||
		            doctorProfile?.sales_rep_id ||
		            ownerId,
		        ).trim();
		        if (!salesRepId) return;

		        // Fetch the sales rep record to get `name` (maps to `sales_rep.name` / `sales_reps.name`).
		        const repResp = (await settingsAPI.getSalesRepProfile(salesRepId)) as any;
		        const repProfile = repResp?.salesRep || repResp?.sales_rep || null;
		        if (!repProfile) return;
		        const repName =
		          typeof repProfile?.name === "string" ? repProfile.name.trim() : "";
		        const repEmail =
		          typeof repProfile?.email === "string" ? repProfile.email.trim() : "";
		        if (!repName && !repEmail) return;
		        setSalesDoctorOwnerRepProfiles((current) => ({
		          ...current,
		          [ownerId]: {
		            id: salesRepId,
		            name: repName || null,
		            email: repEmail || null,
		            role: "sales_rep",
		            userId: null,
		          },
		        }));
		      } catch {
		        // ignore; UI will show ID fallback
		      } finally {
		        salesDoctorOwnerRepFetchInFlightRef.current.delete(ownerId);
		      }
		    })();
		  }, [
		    salesDoctorDetail?.doctorId,
		    salesDoctorDetail?.ownerSalesRepId,
		    salesDoctorDetail?.ownerSalesRepName,
		    salesDoctorDetail?.ownerSalesRepEmail,
		    salesDoctorDetail?.role,
		    salesDoctorOwnerRepProfiles,
		    salesRepDashboard,
		    user?.role,
		  ]);
	  const [salesDoctorNotesLoading, setSalesDoctorNotesLoading] = useState(false);
	  const [salesDoctorNotesSaved, setSalesDoctorNotesSaved] = useState(false);
	  const salesDoctorNotesSavedTimeoutRef = useRef<number | null>(null);
	  const triggerSalesDoctorNotesSaved = useCallback(() => {
    setSalesDoctorNotesSaved(true);
    if (salesDoctorNotesSavedTimeoutRef.current) {
      window.clearTimeout(salesDoctorNotesSavedTimeoutRef.current);
    }
    salesDoctorNotesSavedTimeoutRef.current = window.setTimeout(() => {
      setSalesDoctorNotesSaved(false);
      salesDoctorNotesSavedTimeoutRef.current = null;
    }, 1000);
  }, []);
  const [salesDoctorPhoneDraft, setSalesDoctorPhoneDraft] = useState<string>("");
  const [salesDoctorPhoneSaving, setSalesDoctorPhoneSaving] = useState(false);
	
  useEffect(() => {
    if (!salesDoctorDetail?.doctorId || !isDoctorRole(salesDoctorDetail.role)) {
      setSalesDoctorNoteDraft("");
      setSalesDoctorNotesLoading(false);
      setSalesDoctorNotesSaved(false);
      return;
    }
	    const doctorId = String(salesDoctorDetail.doctorId);
	    let canceled = false;
	    (async () => {
	      setSalesDoctorNoteDraft("");
	      setSalesDoctorNotesLoading(true);
	      try {
	        const response = await referralAPI.getSalesProspect(doctorId);
	        const notes = (response as any)?.prospect?.notes;
	        if (!canceled) {
	          setSalesDoctorNoteDraft(typeof notes === "string" ? notes : "");
	          setSalesDoctorNotesLoading(false);
	          setSalesDoctorNotesSaved(false);
	        }
	      } catch {
	        if (!canceled) {
	          const fallbackKey = String(salesDoctorDetail.doctorId);
	          setSalesDoctorNoteDraft(salesDoctorNotes[fallbackKey] || "");
	          setSalesDoctorNotesLoading(false);
	          setSalesDoctorNotesSaved(false);
	        }
	      }
    })();
    return () => {
      canceled = true;
    };
  }, [salesDoctorDetail?.doctorId, salesDoctorDetail?.role, salesDoctorNotes]);

  useEffect(() => {
    if (!salesDoctorDetail?.doctorId) {
      setSalesDoctorPhoneDraft("");
      return;
    }
    setSalesDoctorPhoneDraft(salesDoctorDetail.phone || "");
  }, [salesDoctorDetail?.doctorId, salesDoctorDetail?.phone]);

	  useEffect(() => {
	    return () => {
	      if (salesDoctorNotesSavedTimeoutRef.current) {
	        window.clearTimeout(salesDoctorNotesSavedTimeoutRef.current);
	        salesDoctorNotesSavedTimeoutRef.current = null;
	      }
	    };
	  }, []);
	
  const saveSalesDoctorNotes = useCallback(async () => {
	    if (!salesDoctorDetail?.doctorId || !isDoctorRole(salesDoctorDetail.role)) {
	      return;
	    }
	    const doctorId = String(salesDoctorDetail.doctorId);
	    if (user && (isRep(user.role) || isAdmin(user.role))) {
	      try {
	        setAdminActionState((prev) => ({
	          ...prev,
	          updatingReferral: doctorId,
	          error: null,
	        }));
	        await referralAPI.upsertSalesProspect(doctorId, {
	          notes: salesDoctorNoteDraft,
	        });
	        triggerSalesDoctorNotesSaved();
	        return;
	      } catch (error: any) {
	        console.warn("[Referral] Update sales rep notes failed", error);
	        toast.error(
	          typeof error?.message === "string" && error.message
	            ? error.message
	            : "Unable to save notes right now.",
	        );
	      } finally {
	        setAdminActionState((prev) => ({ ...prev, updatingReferral: null }));
	      }
	    }

	    // Fallback: per-rep local notes when we can't attach to a referral row.
	    const key = String(salesDoctorDetail.doctorId);
	    const nextText = normalizeNotesValue(salesDoctorNoteDraft);
	    const next = { ...salesDoctorNotes };
	    if (nextText) {
	      next[key] = nextText;
	    } else {
	      delete next[key];
	    }
	    persistSalesDoctorNotes(next);
	    triggerSalesDoctorNotesSaved();
  }, [
    persistSalesDoctorNotes,
    salesDoctorDetail?.doctorId,
    salesDoctorDetail?.role,
    salesDoctorNoteDraft,
    salesDoctorNotes,
    normalizeNotesValue,
    triggerSalesDoctorNotesSaved,
    user,
  ]);

  const saveSalesDoctorPhone = useCallback(async () => {
    if (!salesDoctorDetail?.doctorId) {
      return;
    }
    const trimmed = salesDoctorPhoneDraft.trim();
    const existing = salesDoctorDetail.phone || "";
    if (trimmed === existing) {
      return;
    }
    setSalesDoctorPhoneSaving(true);
    try {
      await settingsAPI.updateUserProfile(salesDoctorDetail.doctorId, {
        phone: trimmed || null,
      });
      setSalesDoctorDetail((current) =>
        current ? { ...current, phone: trimmed || null } : current,
      );
      toast.success("Phone number updated.");
    } catch (error: any) {
      console.warn("[SalesDoctor] Failed to update phone number", error);
      toast.error(
        typeof error?.message === "string" && error.message
          ? error.message
          : "Unable to update phone number right now.",
      );
    } finally {
      setSalesDoctorPhoneSaving(false);
    }
  }, [
    salesDoctorDetail?.doctorId,
    salesDoctorDetail?.phone,
    salesDoctorPhoneDraft,
    settingsAPI,
  ]);
  const mergeSalesOrderDetail = useCallback(
    (detail: AccountOrderSummary | null) => {
      if (!detail) return;
      setSalesTrackingOrders((prev) =>
        prev.map((order) => {
          const match =
            String(order.id || "") === String(detail.id || detail.number || "") ||
            (order.wooOrderId && detail.wooOrderId && String(order.wooOrderId) === String(detail.wooOrderId)) ||
            (order.number && detail.number && String(order.number) === String(detail.number));
          if (!match) return order;
          return {
            ...order,
            ...detail,
            shippingEstimate: detail.shippingEstimate || order.shippingEstimate || null,
            createdAt: detail.createdAt || order.createdAt || null,
            updatedAt: detail.updatedAt || order.updatedAt || null,
            lineItems: detail.lineItems?.length ? detail.lineItems : order.lineItems,
          };
        }),
      );
    },
    [],
  );
  const toggleSalesDoctorCollapse = useCallback((doctorId: string) => {
    setCollapsedSalesDoctorIds((prev) => {
      const next = new Set(prev);
      if (next.has(doctorId)) {
        next.delete(doctorId);
      } else {
        next.add(doctorId);
      }
      return next;
    });
  }, []);
  const toggleReferralCollapse = useCallback((referralId: string) => {
    setCollapsedReferralIds((prev) => {
      const next = new Set(prev);
      if (next.has(referralId)) {
        next.delete(referralId);
      } else {
        next.add(referralId);
      }
      return next;
    });
  }, []);
  const [salesTrackingDoctors, setSalesTrackingDoctors] = useState<
    Map<
      string,
      {
        name: string;
        email?: string | null;
        profileImageUrl?: string | null;
        phone?: string | null;
        leadType?: string | null;
        leadTypeSource?: string | null;
        leadTypeLockedAt?: string | null;
        address1?: string | null;
        address2?: string | null;
        city?: string | null;
        state?: string | null;
        postalCode?: string | null;
        country?: string | null;
      }
    >
  >(new Map());
  const [salesTrackingLoading, setSalesTrackingLoading] = useState(false);
  const [salesTrackingRefreshing, setSalesTrackingRefreshing] = useState(false);
  const [salesTrackingError, setSalesTrackingError] = useState<string | null>(
    null,
  );
  const [salesTrackingLastUpdated, setSalesTrackingLastUpdated] = useState<
    number | null
  >(null);
  const salesTrackingFetchKeyRef = useRef<string | null>(null);
  const salesTrackingLastFetchAtRef = useRef<number>(0);
  const salesTrackingInFlightRef = useRef<boolean>(false);
  const salesTrackingOrderSignatureRef = useRef<Map<string, string>>(new Map());
  const salesOrderDetailFetchedAtRef = useRef<Map<string, number>>(new Map());
  const liveClientsRef = useRef<any[]>([]);
  const adminLiveUsersRef = useRef<any[]>([]);
  const [salesOrderRefreshingIds, setSalesOrderRefreshingIds] = useState<
    Set<string>
  >(new Set());
  const salesOrderRefreshingClearHandleRef = useRef<number | null>(null);

  useEffect(() => {
    salesTrackingOrdersRef.current = salesTrackingOrders;
  }, [salesTrackingOrders]);
	  const openSalesOrderDetails = useCallback(
	    async (order: AccountOrderSummary) => {
	      setSalesOrderDetail(order);
	      setSalesOrderNotesDraft(
	        typeof (order as any)?.notes === "string" ? String((order as any).notes) : "",
	      );
	      salesOrderFieldsInitializedForRef.current = null;
	      setSalesOrderDetailLoading(true);
	      try {
	        const detail = await ordersAPI.getSalesRepOrderDetail(
	          order.wooOrderId || order.id || order.number || "",
	          (order as any)?.doctorEmail ||
            (order as any)?.doctor_email ||
            (order as any)?.doctorId ||
            resolveOrderDoctorId(order) ||
            null,
        );
        const normalized = normalizeAccountOrdersResponse(
          { woo: Array.isArray(detail) ? detail : [detail] },
          { includeCanceled: true },
        );
	        if (normalized && normalized.length > 0) {
	          const enriched = normalized[0];
	          setSalesOrderDetail(enriched);
	          const derived = deriveSalesOrderEditableFields(enriched);
	          setSalesOrderFieldsSaved(derived);
	          setSalesOrderFieldsDraft(derived);
	          setSalesOrderNotesDraft(
	            typeof (enriched as any)?.notes === "string"
	              ? String((enriched as any).notes)
	              : "",
	          );
	          mergeSalesOrderDetail(enriched);
	        } else if (detail && typeof detail === "object") {
	          const enriched = detail as AccountOrderSummary;
	          setSalesOrderDetail(enriched);
	          const derived = deriveSalesOrderEditableFields(enriched);
	          setSalesOrderFieldsSaved(derived);
	          setSalesOrderFieldsDraft(derived);
	          setSalesOrderNotesDraft(
	            typeof (enriched as any)?.notes === "string"
	              ? String((enriched as any).notes)
	              : "",
	          );
	          mergeSalesOrderDetail(enriched);
        }
      } catch (error: any) {
        console.error("[Sales Tracking] Failed to fetch order detail", error);
        toast.error(
          typeof error?.message === "string"
            ? error.message
            : "Unable to load order details.",
        );
      } finally {
        setSalesOrderDetailLoading(false);
      }
	    },
	    [deriveSalesOrderEditableFields, mergeSalesOrderDetail],
	  );

	  useEffect(() => {
	    if (!salesOrderDetail) {
	      setSalesOrderNotesDraft("");
	      setSalesOrderFieldsSaved({
	        trackingNumber: "",
	        shippingCarrier: "",
	        shippingService: "",
	        status: "",
	        expectedShipmentWindow: "",
	      });
	      setSalesOrderFieldsDraft({
	        trackingNumber: "",
	        shippingCarrier: "",
	        shippingService: "",
	        status: "",
	        expectedShipmentWindow: "",
	      });
	      salesOrderFieldsInitializedForRef.current = null;
	      return;
	    }
	    setSalesOrderNotesDraft(
	      typeof (salesOrderDetail as any)?.notes === "string"
	        ? String((salesOrderDetail as any).notes)
	        : "",
	    );
	  }, [salesOrderDetail?.id]);

	  useEffect(() => {
	    if (!salesOrderDetail) {
	      return;
	    }
	    const trackingNumber = resolveTrackingNumber(salesOrderDetail as any);
	    if (!trackingNumber) {
	      return;
	    }

	    const cached = trackingStatusByNumberRef.current[trackingNumber];
	    if (cached) {
	      setSalesOrderDetail((prev) => {
	        if (!prev) return prev;
	        const integrations = parseMaybeJson(prev.integrationDetails || prev.integrations) || {};
	        const existingCarrierTracking = parseMaybeJson(
	          (integrations as any)?.carrierTracking || (integrations as any)?.carrier_tracking,
	        );
	        if (existingCarrierTracking?.trackingStatus) {
	          return prev;
	        }
	        return {
	          ...prev,
	          integrationDetails: {
	            ...integrations,
	            carrierTracking: cached,
	          },
	        };
	      });
	      return;
	    }

	    let cancelled = false;
	    void (async () => {
	      try {
	        const info = (await trackingAPI.getStatus(trackingNumber)) as CarrierTrackingInfo | null;
	        if (cancelled || !info) {
	          return;
	        }
	        setTrackingStatusByNumber((prev) => ({
	          ...prev,
	          [trackingNumber]: info,
	        }));
	        setSalesOrderDetail((prev) => {
	          if (!prev) return prev;
	          const integrations = parseMaybeJson(prev.integrationDetails || prev.integrations) || {};
	          return {
	            ...prev,
	            integrationDetails: {
	              ...integrations,
	              carrierTracking: info,
	            },
	          };
	        });
	      } catch (_error) {
	        // non-fatal
	      }
	    })();

	    return () => {
	      cancelled = true;
	    };
	  }, [salesOrderDetail?.id]);

	  useEffect(() => {
	    if (!salesOrderDetail || salesOrderDetailLoading) {
	      return;
	    }
	    const key = String(
	      salesOrderDetail.wooOrderId || salesOrderDetail.id || salesOrderDetail.number || "",
	    );
	    if (!key) {
	      return;
	    }
	    if (salesOrderFieldsInitializedForRef.current === key) {
	      return;
	    }
	    const derived = deriveSalesOrderEditableFields(salesOrderDetail);
	    setSalesOrderFieldsSaved(derived);
	    setSalesOrderFieldsDraft(derived);
	    salesOrderFieldsInitializedForRef.current = key;
	  }, [deriveSalesOrderEditableFields, salesOrderDetail, salesOrderDetailLoading]);

	  const handleSaveSalesOrderNotes = useCallback(async () => {
	    if (!salesOrderDetail) {
	      return;
	    }
    if (!user?.role || (!isRep(user.role) && !isAdmin(user.role))) {
      toast.error("You don't have permission to edit order notes.");
      return;
    }
    if (salesOrderNotesSaving) {
      return;
    }
    const normalizedNotes = normalizeNotesValue(salesOrderNotesDraft);
    const orderKey =
      salesOrderDetail.wooOrderId || salesOrderDetail.id || salesOrderDetail.number || "";
    if (!orderKey) {
      toast.error("Unable to identify this order.");
      return;
    }
    setSalesOrderNotesSaving(true);
    try {
      const response = (await ordersAPI.updateOrderNotes(orderKey, normalizedNotes)) as any;
      const updatedOrder = (response && typeof response === "object" && response.order) || null;
      const nextNotes =
        updatedOrder && typeof updatedOrder?.notes === "string"
          ? String(updatedOrder.notes)
          : normalizedNotes;
      setSalesOrderDetail((prev) => (prev ? { ...prev, notes: nextNotes } : prev));
      mergeSalesOrderDetail({ ...salesOrderDetail, notes: nextNotes });
      toast.success("Order notes updated.");
    } catch (error: any) {
      console.warn("[Orders] Failed to update order notes", error);
      toast.error(
        typeof error?.message === "string" && error.message
          ? error.message
          : "Unable to update order notes right now.",
      );
    } finally {
      setSalesOrderNotesSaving(false);
    }
	  }, [
	    mergeSalesOrderDetail,
	    normalizeNotesValue,
	    salesOrderDetail,
	    salesOrderNotesDraft,
	    salesOrderNotesSaving,
	    user?.role,
	  ]);

	  const handleSaveSalesOrderFields = useCallback(async () => {
	    if (!salesOrderDetail) {
	      return;
	    }
	    if (!user?.role || (!isRep(user.role) && !isAdmin(user.role))) {
	      toast.error("You don't have permission to edit this order.");
	      return;
	    }
	    if (salesOrderFieldsSaving) {
	      return;
	    }
	    const orderKey =
	      salesOrderDetail.wooOrderId || salesOrderDetail.id || salesOrderDetail.number || "";
	    if (!orderKey) {
	      toast.error("Unable to identify this order.");
	      return;
	    }

	    const payload: Record<string, string | null> = {};
	    const fields: Array<keyof SalesOrderEditableFields> = [
	      "trackingNumber",
	      "shippingCarrier",
	      "shippingService",
	      "status",
	      "expectedShipmentWindow",
	    ];
	    for (const field of fields) {
	      const draftValue = normalizeEditableField(salesOrderFieldsDraft[field]);
	      const savedValue = normalizeEditableField(salesOrderFieldsSaved[field]);
	      if (draftValue !== savedValue) {
	        payload[field] = draftValue;
	      }
	    }

	    if (Object.keys(payload).length === 0) {
	      toast("No changes to save.");
	      return;
	    }

	    setSalesOrderFieldsSaving(true);
	    try {
	      const response = (await ordersAPI.updateOrderFields(orderKey, payload as any)) as any;
	      const updatedOrder = (response && typeof response === "object" && response.order) || null;

	      setSalesOrderDetail((prev) => {
	        if (!prev) return prev;
	        const patch: any = {};
	        if (updatedOrder && typeof updatedOrder === "object") {
	          if ("trackingNumber" in updatedOrder) patch.trackingNumber = updatedOrder.trackingNumber ?? null;
	          if ("shippingCarrier" in updatedOrder) patch.shippingCarrier = updatedOrder.shippingCarrier ?? null;
	          if ("shippingService" in updatedOrder) patch.shippingService = updatedOrder.shippingService ?? null;
	          if ("status" in updatedOrder) patch.status = updatedOrder.status ?? null;
	          if ("expectedShipmentWindow" in updatedOrder) {
	            patch.expectedShipmentWindow = updatedOrder.expectedShipmentWindow ?? null;
	          }
	          if (updatedOrder.shippingEstimate) patch.shippingEstimate = updatedOrder.shippingEstimate;
	          if (updatedOrder.updatedAt) patch.updatedAt = updatedOrder.updatedAt;
	        } else {
	          if ("trackingNumber" in payload) patch.trackingNumber = payload.trackingNumber;
	          if ("shippingCarrier" in payload) patch.shippingCarrier = payload.shippingCarrier;
	          if ("shippingService" in payload) patch.shippingService = payload.shippingService;
	          if ("status" in payload) patch.status = payload.status;
	          if ("expectedShipmentWindow" in payload) patch.expectedShipmentWindow = payload.expectedShipmentWindow;
	        }
	        const next = { ...prev, ...patch };
	        mergeSalesOrderDetail(next);
	        return next;
	      });

	      setSalesOrderFieldsSaved((prevSaved) => {
	        const nextSaved = { ...prevSaved };
	        for (const field of fields) {
	          if (field in payload) {
	            nextSaved[field] = normalizeEditableField((payload as any)[field]) || "";
	          }
	        }
	        return nextSaved;
	      });
	      setSalesOrderFieldsDraft((prevDraft) => {
	        const nextDraft = { ...prevDraft };
	        for (const field of fields) {
	          if (field in payload) {
	            nextDraft[field] = normalizeEditableField((payload as any)[field]) || "";
	          }
	        }
	        return nextDraft;
	      });

	      toast.success("Order updated.");
	    } catch (error: any) {
	      console.warn("[Orders] Failed to update order fields", error);
	      toast.error(
	        typeof error?.message === "string" && error.message
	          ? error.message
	          : "Unable to update the order right now.",
	      );
	    } finally {
	      setSalesOrderFieldsSaving(false);
	    }
	  }, [
	    deriveSalesOrderEditableFields,
	    mergeSalesOrderDetail,
	    salesOrderDetail,
	    salesOrderFieldsDraft,
	    salesOrderFieldsSaved,
	    salesOrderFieldsSaving,
	    user?.role,
	  ]);

  const shouldCountRevenueForStatus = (status?: string | null) => {
    const normalized = String(status || "").toLowerCase().trim();
    return ![
      "cancelled",
      "canceled",
      "on-hold",
      "on_hold",
      "trash",
      "refunded",
    ].includes(normalized);
  };

  const openSalesDoctorDetail = useCallback(
	    (
      bucket: any,
      sourceRole?: string,
    ) => {
      const resolvePresence = () => {
        const doctorId = String(bucket?.doctorId || "").trim();
        const email =
          typeof bucket?.doctorEmail === "string" ? bucket.doctorEmail.trim().toLowerCase() : "";
        const candidates: any[] = [
          ...(Array.isArray(liveClientsRef.current) ? liveClientsRef.current : []),
          ...(Array.isArray(adminLiveUsersRef.current) ? adminLiveUsersRef.current : []),
        ];
        const match = candidates.find((entry) => {
          const entryId = String(entry?.id || "").trim();
          if (doctorId && entryId && doctorId === entryId) return true;
          const entryEmail =
            typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : "";
          return Boolean(email && entryEmail && email === entryEmail);
        });
        if (!match) return null;
        const idleMinutes =
          typeof match?.idleMinutes === "number" && Number.isFinite(match.idleMinutes)
            ? match.idleMinutes
            : typeof match?.idleForMinutes === "number" && Number.isFinite(match.idleForMinutes)
              ? match.idleForMinutes
              : null;
        return {
          isOnline: typeof match?.isOnline === "boolean" ? match.isOnline : null,
          isIdle: typeof match?.isIdle === "boolean" ? match.isIdle : null,
          idleMinutes,
          lastSeenAt: match?.lastSeenAt || match?.last_seen_at || null,
          lastInteractionAt: match?.lastInteractionAt || match?.last_interaction_at || null,
          lastLoginAt: match?.lastLoginAt || match?.last_login_at || null,
        };
      };

      const ordersSorted = [...(bucket.orders || [])].sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      });
      const latestOrder = ordersSorted[0];
      const addressSource =
        (latestOrder as any)?.shippingAddress ||
        (latestOrder as any)?.shipping ||
        (latestOrder as any)?.billingAddress ||
        (latestOrder as any)?.billing ||
        null;
      const addressFromOrder =
        addressSource &&
        [
          [addressSource.firstName, addressSource.lastName]
            .filter(Boolean)
            .join(" ")
            .trim(),
          addressSource.address1 || addressSource.address_1,
          addressSource.address2 || addressSource.address_2,
          [addressSource.city, addressSource.state, addressSource.postcode]
            .filter(Boolean)
            .join(", "),
          addressSource.country,
        ]
          .filter((part) => typeof part === "string" && part.trim().length > 0)
          .join("\n");
      const address =
        bucket.doctorAddress && bucket.doctorAddress.trim().length > 0
          ? bucket.doctorAddress
          : addressFromOrder || null;
      const lastOrderDate = latestOrder?.createdAt || null;
      const relevantOrders = bucket.orders.filter((order) =>
        shouldCountRevenueForStatus(order.status),
      );
      const avgOrderValue =
        relevantOrders.length > 0
          ? bucket.total / relevantOrders.length
          : null;
      const normalizedRole = normalizeRole(sourceRole || "doctor") || "doctor";
      const presence =
        typeof bucket?.isOnline === "boolean" || typeof bucket?.isIdle === "boolean"
          ? {
              isOnline: typeof bucket?.isOnline === "boolean" ? bucket.isOnline : null,
              isIdle: typeof bucket?.isIdle === "boolean" ? bucket.isIdle : null,
              idleMinutes:
                typeof bucket?.idleMinutes === "number" && Number.isFinite(bucket.idleMinutes)
                  ? bucket.idleMinutes
                  : typeof bucket?.idleForMinutes === "number" && Number.isFinite(bucket.idleForMinutes)
                    ? bucket.idleForMinutes
                    : null,
              lastSeenAt:
                typeof bucket?.lastSeenAt === "string"
                  ? bucket.lastSeenAt
                  : typeof bucket?.last_seen_at === "string"
                    ? bucket.last_seen_at
                    : null,
              lastInteractionAt:
                typeof bucket?.lastInteractionAt === "string"
                  ? bucket.lastInteractionAt
                  : typeof bucket?.last_interaction_at === "string"
                    ? bucket.last_interaction_at
                    : null,
              lastLoginAt:
                typeof bucket?.lastLoginAt === "string"
                  ? bucket.lastLoginAt
                  : typeof bucket?.last_login_at === "string"
                    ? bucket.last_login_at
                    : null,
            }
          : resolvePresence();

	      setSalesDoctorDetail({
	        doctorId: bucket.doctorId,
	        referralId: bucket.referralId ?? null,
	        name: bucket.doctorName,
	        email: bucket.doctorEmail,
	        avatar: bucket.doctorAvatar ?? null,
		        revenue: bucket.total,
	        personalRevenue: bucket.personalRevenue ?? null,
	        salesRevenue: bucket.salesRevenue ?? null,
	        salesWholesaleRevenue: bucket.salesWholesaleRevenue ?? null,
	        salesRetailRevenue: bucket.salesRetailRevenue ?? null,
	        orderQuantity: bucket.orderQuantity ?? null,
	        totalOrderValue: bucket.totalOrderValue ?? null,
	        orders: bucket.orders,
          personalOrders: Array.isArray(bucket.personalOrders) ? bucket.personalOrders : undefined,
          salesOrders: Array.isArray(bucket.salesOrders) ? bucket.salesOrders : undefined,
        phone:
          bucket.doctorPhone ||
          (addressSource as any)?.phone ||
          (addressSource as any)?.phoneNumber ||
          null,
        address,
        lastOrderDate,
	        avgOrderValue,
	        role: normalizedRole,
	        ownerSalesRepId: bucket.ownerSalesRepId ?? null,
	        ownerSalesRepName: (bucket as any).ownerSalesRepName ?? null,
	        ownerSalesRepEmail: (bucket as any).ownerSalesRepEmail ?? null,
	        isOnline: presence?.isOnline ?? null,
	        isIdle: presence?.isIdle ?? null,
	        idleMinutes: presence?.idleMinutes ?? null,
	        lastSeenAt: presence?.lastSeenAt ?? null,
        lastInteractionAt: presence?.lastInteractionAt ?? null,
        lastLoginAt: presence?.lastLoginAt ?? null,
      });
    },
    [],
  );

  const openLiveUserDetail = useCallback(
    (
      entry: any,
      options?: {
        salesRepWholesaleRevenue?: number | null;
        salesRepRetailRevenue?: number | null;
      },
    ) => {
      const id = String(entry?.id || "").trim();
      if (!id) return;

      const avatarUrl = entry?.profileImageUrl || null;
      const displayName = entry?.name || entry?.email || "User";
      const entryRole = normalizeRole(entry?.role);
      const salesWholesaleRevenue =
        typeof options?.salesRepWholesaleRevenue === "number" &&
        Number.isFinite(options.salesRepWholesaleRevenue)
          ? options.salesRepWholesaleRevenue
          : null;
      const salesRetailRevenue =
        typeof options?.salesRepRetailRevenue === "number" &&
        Number.isFinite(options.salesRepRetailRevenue)
          ? options.salesRepRetailRevenue
          : null;

      setSalesDoctorDetailLoading(true);
      openSalesDoctorDetail(
        {
          doctorId: id,
          referralId: null,
          doctorName: displayName,
          doctorEmail: entry?.email || null,
          doctorAvatar: avatarUrl,
          doctorPhone: null,
          doctorAddress: null,
          ownerSalesRepId:
            entry?.ownerSalesRepId ||
            entry?.owner_sales_rep_id ||
            entry?.salesRepId ||
            entry?.sales_rep_id ||
            entry?.assignedSalesRepId ||
            entry?.assigned_sales_rep_id ||
            null,
          isOnline: typeof entry?.isOnline === "boolean" ? entry.isOnline : null,
          isIdle: typeof entry?.isIdle === "boolean" ? entry.isIdle : null,
          idleMinutes:
            typeof entry?.idleMinutes === "number" && Number.isFinite(entry.idleMinutes)
              ? entry.idleMinutes
              : typeof entry?.idleForMinutes === "number" && Number.isFinite(entry.idleForMinutes)
                ? entry.idleForMinutes
                : null,
          lastSeenAt: entry?.lastSeenAt || entry?.last_seen_at || null,
          lastInteractionAt: entry?.lastInteractionAt || entry?.last_interaction_at || null,
          lastLoginAt: entry?.lastLoginAt || entry?.last_login_at || null,
          orders: [],
          total: 0,
          salesWholesaleRevenue,
          salesRetailRevenue,
        },
        entryRole || "doctor",
      );

	      if (!isAdmin(user?.role) && !isSalesLead(user?.role)) {
	        (async () => {
	          try {
	            const role = user?.role || null;
	            if (!role || !isRep(role)) {
	              return;
	            }

            const salesRepId = user?.salesRepId || user?.id || null;
            const response = await ordersAPI.getForSalesRep({
              salesRepId: salesRepId ? String(salesRepId) : undefined,
              scope: "mine",
            });

            const respObj = response && typeof response === "object" ? (response as any) : null;
            const rawOrders = Array.isArray(respObj?.orders) ? respObj.orders : Array.isArray(response) ? response : [];
            const doctors = Array.isArray(respObj?.doctors)
              ? respObj.doctors
              : Array.isArray(respObj?.users)
                ? respObj.users
                : [];

            const normalizedOrders = normalizeAccountOrdersResponse(
              { local: rawOrders },
              { includeCanceled: true },
            );

            const entryEmail =
              typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : "";

            const matchesDoctor = (order: any) => {
              const docId = resolveOrderDoctorId(order as any) || (order as any)?.userId || (order as any)?.doctorId || null;
              if (docId && String(docId) === id) {
                return true;
              }
              const orderEmailRaw =
                (order as any)?.doctorEmail ||
                (order as any)?.doctor_email ||
                (order as any)?.billing?.email ||
                (order as any)?.billing_email ||
                null;
              const orderEmail =
                typeof orderEmailRaw === "string" ? orderEmailRaw.trim().toLowerCase() : "";
              return Boolean(entryEmail && orderEmail && entryEmail === orderEmail);
            };

            const doctorOrders = normalizedOrders.filter(matchesDoctor);

            const totalOrderValue = doctorOrders.reduce((sum, order) => {
              if (!shouldCountRevenueForStatus(order.status)) {
                return sum;
              }
              return sum + (coerceNumber(order.total) || 0);
            }, 0);
            const orderQuantity = doctorOrders.filter((order) =>
              shouldCountRevenueForStatus(order.status),
            ).length;

            const doctorFromList = (() => {
              const byId = doctors.find((doc: any) => String(doc?.id || doc?.doctorId || doc?.userId || "") === id);
              if (byId) return byId;
              if (entryEmail) {
                return doctors.find(
                  (doc: any) =>
                    typeof doc?.email === "string" &&
                    doc.email.trim().toLowerCase() === entryEmail,
                );
              }
              return null;
            })();

            const doctorName =
              doctorFromList?.name ||
              [doctorFromList?.firstName, doctorFromList?.lastName].filter(Boolean).join(" ").trim() ||
              displayName;

            openSalesDoctorDetail(
              {
                doctorId: id,
                referralId: null,
                doctorName,
                doctorEmail: doctorFromList?.email || entry?.email || null,
                doctorAvatar: doctorFromList?.profileImageUrl || doctorFromList?.profile_image_url || avatarUrl,
                doctorPhone: doctorFromList?.phone || doctorFromList?.phoneNumber || doctorFromList?.phone_number || null,
                doctorAddress: null,
                ownerSalesRepId:
                  doctorFromList?.ownerSalesRepId ||
                  doctorFromList?.owner_sales_rep_id ||
                  doctorFromList?.salesRepId ||
                  doctorFromList?.sales_rep_id ||
                  null,
                isOnline: typeof entry?.isOnline === "boolean" ? entry.isOnline : null,
                isIdle: typeof entry?.isIdle === "boolean" ? entry.isIdle : null,
                idleMinutes:
                  typeof entry?.idleMinutes === "number" && Number.isFinite(entry.idleMinutes)
                    ? entry.idleMinutes
                    : typeof entry?.idleForMinutes === "number" && Number.isFinite(entry.idleForMinutes)
                      ? entry.idleForMinutes
                      : null,
                lastSeenAt: entry?.lastSeenAt || entry?.last_seen_at || null,
                lastInteractionAt: entry?.lastInteractionAt || entry?.last_interaction_at || null,
                lastLoginAt: entry?.lastLoginAt || entry?.last_login_at || null,
                orders: doctorOrders,
                total: totalOrderValue,
                orderQuantity,
                totalOrderValue,
                salesWholesaleRevenue,
                salesRetailRevenue,
              },
              "doctor",
            );
          } catch (error) {
            console.warn("[Sales Rep] Failed to hydrate live client detail", error);
          } finally {
            setSalesDoctorDetailLoading(false);
          }
	        })();
	        return;
	      }

	      (async () => {
	        try {
          const [profileResp, ordersResp] = await Promise.all([
            settingsAPI.getAdminUserProfile(id) as any,
            ordersAPI.getAdminOrdersForUser(id) as any,
          ]);

          const profile = (profileResp as any)?.user || null;
          const normalizedOrders = normalizeAccountOrdersResponse(ordersResp, {
            includeCanceled: true,
          });
          const resolveOrderSubtotal = (order: any) => {
            const direct = coerceNumber(
              order?.itemsSubtotal ??
                order?.items_subtotal ??
                order?.itemsTotal ??
                order?.items_total,
            );
            if (Number.isFinite(direct)) {
              return Math.max(0, direct);
            }
            const total = coerceNumber(order?.grandTotal ?? order?.grand_total ?? order?.total);
            const shipping = coerceNumber(order?.shippingTotal ?? order?.shipping_total) || 0;
            const tax = coerceNumber(order?.taxTotal ?? order?.tax_total ?? order?.totalTax) || 0;
            if (Number.isFinite(total)) {
              return Math.max(0, total - shipping - tax);
            }
            return 0;
          };

          const totalOrderValue = normalizedOrders.reduce((sum, order) => {
            if (!shouldCountRevenueForStatus(order.status)) {
              return sum;
            }
            return sum + resolveOrderSubtotal(order);
          }, 0);
          const orderQuantity = normalizedOrders.filter((order) =>
            shouldCountRevenueForStatus(order.status),
          ).length;
          const roleFromProfile = normalizeRole(profile?.role || entryRole || "doctor");

          const addressParts = [
            profile?.officeAddressLine1,
            profile?.officeAddressLine2,
            [profile?.officeCity, profile?.officeState, profile?.officePostalCode]
              .filter(Boolean)
              .join(", "),
            profile?.officeCountry,
          ].filter((part) => typeof part === "string" && part.trim().length > 0);
          const address = addressParts.length > 0 ? addressParts.join("\n") : null;

		          const isSalesProfile =
		            roleFromProfile === "sales_rep" ||
		            roleFromProfile === "rep" ||
		            roleFromProfile === "sales_lead" ||
		            roleFromProfile === "saleslead" ||
		            roleFromProfile === "sales-lead" ||
		            roleFromProfile === "admin";
		          let salesRevenue: number | null = null;
		          let personalRevenue: number | null = null;
		          let salesWholesaleRevenueValue: number | null = salesWholesaleRevenue;
		          let salesRetailRevenueValue: number | null = salesRetailRevenue;
              let totalOrderValueForModal = totalOrderValue;
		          let ordersForModal = normalizedOrders;
		          let personalOrdersForModal = normalizedOrders;
		          let salesOrdersForModal: AccountOrderSummary[] = [];
		          let orderQuantityForModal = orderQuantity;

		          if (isSalesProfile) {
		            try {
		              const repOrdersResp = await ordersAPI.getForSalesRep({
		                salesRepId: id,
		                scope: "all",
		              });
		              const repOrders = (repOrdersResp as any)?.orders;
		              const repOrdersList = Array.isArray(repOrders) ? repOrders : [];

		              const repOrdersNormalized = normalizeAccountOrdersResponse(
		                { local: repOrdersList },
		                { includeCanceled: true },
		              );

		              const entryEmail =
		                typeof profile?.email === "string"
		                  ? profile.email.trim().toLowerCase()
		                  : typeof entry?.email === "string"
		                    ? entry.email.trim().toLowerCase()
		                    : "";

                  const entryNameKey =
                    typeof profile?.name === "string" && profile.name.trim()
                      ? profile.name.trim().toLowerCase()
                      : typeof entry?.name === "string" && entry.name.trim()
                        ? entry.name.trim().toLowerCase()
                        : "";

                  const resolveOrderEmailKey = (order: any): string => {
                    const raw =
                      order?.doctorEmail ||
                      order?.doctor_email ||
                      order?.billingAddress?.email ||
                      order?.billing?.email ||
                      order?.billing_email ||
                      order?.customerEmail ||
                      order?.customer_email ||
                      null;
                    return typeof raw === "string" ? raw.trim().toLowerCase() : "";
                  };

                  const resolveOrderNameKey = (order: any): string => {
                    const fromDoctorName =
                      typeof order?.doctorName === "string" ? order.doctorName.trim() : "";
                    if (fromDoctorName) {
                      return fromDoctorName.toLowerCase();
                    }
                    const billing =
                      order?.billingAddress || order?.billing || (order as any)?.billing_address || null;
                    const shipping =
                      order?.shippingAddress || order?.shipping || (order as any)?.shipping_address || null;
                    const buildKey = (address: any) => {
                      if (!address) return "";
                      const first =
                        address?.firstName ||
                        address?.first_name ||
                        address?.firstname ||
                        "";
                      const last =
                        address?.lastName ||
                        address?.last_name ||
                        address?.lastname ||
                        "";
                      const combined = [first, last].filter(Boolean).join(" ").trim();
                      return combined ? combined.toLowerCase() : "";
                    };
                    return buildKey(billing) || buildKey(shipping) || "";
                  };

                  const resolveOrderUserId = (order: any): string => {
                    try {
                      const resolved = resolveOrderDoctorId(order as any);
                      return resolved ? String(resolved) : "";
                    } catch {
                      return String(
                        order?.doctorId ||
                          order?.doctor_id ||
                          order?.userId ||
                          order?.user_id ||
                          "",
                      ).trim();
                    }
                  };

                  const isPersonalOrderForRep = (order: any): boolean => {
                    const orderUserId = resolveOrderUserId(order);
                    if (orderUserId && orderUserId === id) {
                      return true;
                    }
                    const orderEmailKey = resolveOrderEmailKey(order);
                    if (entryEmail && orderEmailKey && entryEmail === orderEmailKey) {
                      return true;
                    }
                    const orderNameKey = resolveOrderNameKey(order);
                    if (entryNameKey && orderNameKey && entryNameKey === orderNameKey) {
                      return true;
                    }
                    return false;
                  };

                  const salesOrders = repOrdersNormalized.filter(
                    (order: any) => !isPersonalOrderForRep(order),
                  );
                  const personalOrders = personalOrdersForModal;
                  const personalOrderKeys = new Set<string>();
                  const addPersonalKey = (key: string | null, prefix: string) => {
                    if (!key) return;
                    personalOrderKeys.add(`${prefix}:${key}`);
                  };
                  personalOrders.forEach((order) => {
                    addPersonalKey(
                      normalizeWooOrderId(
                        (order as any).wooOrderId ||
                          (order as any).woo_order_id ||
                          (order as any).wooId ||
                          order.id,
                      ),
                      "woo",
                    );
                    addPersonalKey(
                      normalizeWooOrderNumberKey(
                        (order as any).wooOrderNumber ||
                          (order as any).woo_order_number ||
                          order.number,
                      ),
                      "num",
                    );
                    const localId = typeof order.id === "string" ? order.id.trim() : "";
                    if (localId) {
                      addPersonalKey(localId, "id");
                    }
                  });
                  const hasPersonalKey = (order: AccountOrderSummary) => {
                    const wooId = normalizeWooOrderId(
                      (order as any).wooOrderId ||
                        (order as any).woo_order_id ||
                        (order as any).wooId ||
                        order.id,
                    );
                    if (wooId && personalOrderKeys.has(`woo:${wooId}`)) return true;
                    const wooNumber = normalizeWooOrderNumberKey(
                      (order as any).wooOrderNumber ||
                        (order as any).woo_order_number ||
                        order.number,
                    );
                    if (wooNumber && personalOrderKeys.has(`num:${wooNumber}`)) return true;
                    const localId = typeof order.id === "string" ? order.id.trim() : "";
                    if (localId && personalOrderKeys.has(`id:${localId}`)) return true;
                    return false;
                  };
                  const filteredSalesOrders = salesOrders.filter(
                    (order) => !hasPersonalKey(order),
                  );
                  const combinedOrders = (() => {
                    const byKey = new Map<string, AccountOrderSummary>();
                    const keyFor = (order: AccountOrderSummary) =>
                      String(
                        order.id ||
                          order.number ||
                          (order as any).wooOrderId ||
                          (order as any).wooOrderNumber ||
                          "",
                      );
                    [...personalOrders, ...filteredSalesOrders].forEach((order) => {
                      const key = keyFor(order);
                      if (!key) return;
                      if (!byKey.has(key)) {
                        byKey.set(key, order);
                      }
                    });
                    return Array.from(byKey.values());
                  })();

                  ordersForModal = combinedOrders;
                  salesOrdersForModal = filteredSalesOrders;
                  orderQuantityForModal = combinedOrders.filter((order) =>
                    shouldCountRevenueForStatus(order?.status),
                  ).length;

                  personalRevenue = personalOrders.reduce((sum: number, order: any) => {
                    if (!shouldCountRevenueForStatus(order?.status)) {
                      return sum;
                    }
                    return sum + resolveOrderSubtotal(order);
                  }, 0);

                  totalOrderValueForModal = combinedOrders.reduce((sum: number, order: any) => {
                    if (!shouldCountRevenueForStatus(order?.status)) {
                      return sum;
                    }
                    return sum + resolveOrderSubtotal(order);
                  }, 0);

		              const totals = salesOrders.reduce(
		                (acc: { total: number; wholesale: number; retail: number }, order: any) => {
                          if (!shouldCountRevenueForStatus(order?.status)) {
                            return acc;
                          }
				                                    const amount = resolveOrderSubtotal(order);
		                  const pricingModeRaw =
		                    order?.pricingMode ||
		                    (order as any)?.pricing_mode ||
		                    (order as any)?.pricing ||
		                    (order as any)?.priceType ||
		                    null;
		                  const pricingMode = String(pricingModeRaw || "").toLowerCase().trim();
		                  acc.total += amount;
		                  if (pricingMode === "wholesale") {
		                    acc.wholesale += amount;
		                  } else if (pricingMode === "retail") {
		                    acc.retail += amount;
		                  } else {
		                    acc.retail += amount;
		                  }
		                  return acc;
		                },
		                { total: 0, wholesale: 0, retail: 0 },
		              );

		              salesRevenue = totals.total;
		              salesWholesaleRevenueValue = totals.wholesale;
		              salesRetailRevenueValue = totals.retail;
		            } catch (error) {
		              console.warn("[Admin] Failed to load sales rep revenue", error);
                  personalRevenue = totalOrderValue;
                  totalOrderValueForModal = totalOrderValue;
		            }
		          }

	          openSalesDoctorDetail(
	            {
              doctorId: id,
              referralId: null,
              doctorName: profile?.name || displayName,
              doctorEmail: profile?.email || entry?.email || null,
              doctorAvatar: profile?.profileImageUrl || avatarUrl,
              doctorPhone: profile?.phone || null,
              doctorAddress: address,
              ownerSalesRepId:
                profile?.salesRepId ||
                profile?.sales_rep_id ||
                profile?.ownerSalesRepId ||
                profile?.owner_sales_rep_id ||
                entry?.ownerSalesRepId ||
                entry?.owner_sales_rep_id ||
                null,
              isOnline: typeof entry?.isOnline === "boolean" ? entry.isOnline : null,
              isIdle: typeof entry?.isIdle === "boolean" ? entry.isIdle : null,
              idleMinutes:
                typeof entry?.idleMinutes === "number" && Number.isFinite(entry.idleMinutes)
                  ? entry.idleMinutes
                  : typeof entry?.idleForMinutes === "number" && Number.isFinite(entry.idleForMinutes)
                    ? entry.idleForMinutes
                    : null,
	              lastSeenAt: entry?.lastSeenAt || entry?.last_seen_at || null,
	              lastInteractionAt: entry?.lastInteractionAt || entry?.last_interaction_at || null,
	              lastLoginAt: entry?.lastLoginAt || entry?.last_login_at || null,
	              orders: ordersForModal,
                personalOrders: personalOrdersForModal,
                salesOrders: salesOrdersForModal,
	              total: totalOrderValueForModal,
	              personalRevenue,
	              salesRevenue,
	              salesWholesaleRevenue: salesWholesaleRevenueValue,
	              salesRetailRevenue: salesRetailRevenueValue,
	              orderQuantity: orderQuantityForModal,
	              totalOrderValue: totalOrderValueForModal,
	            },
	            roleFromProfile || "doctor",
	          );
        } catch (error) {
          console.warn("[Admin] Failed to hydrate live user detail", error);
        } finally {
          setSalesDoctorDetailLoading(false);
        }
      })();
    },
    [openSalesDoctorDetail, user?.role],
  );

  const renderSalesOrderSkeleton = () => (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="news-loading-line news-loading-shimmer w-36" />
          <div className="news-loading-line news-loading-shimmer w-28" />
        </div>
        <div className="news-loading-line news-loading-shimmer w-16" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, idx) => (
          <div key={idx} className="space-y-2">
            <div className="news-loading-line news-loading-shimmer w-24" />
            <div className="news-loading-line news-loading-shimmer w-28" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[...Array(2)].map((_, idx) => (
          <div
            key={idx}
            className="news-loading-card bg-white/75 shadow-none border border-slate-200/70 space-y-3"
          >
            <div className="news-loading-line news-loading-shimmer w-32" />
            <div className="space-y-2">
              <div className="news-loading-line news-loading-shimmer w-40" />
              <div className="news-loading-line news-loading-shimmer w-32" />
              <div className="news-loading-line news-loading-shimmer w-28" />
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="news-loading-line news-loading-shimmer w-32" />
        {[...Array(2)].map((_, idx) => (
          <div
            key={idx}
            className="news-loading-card flex items-center gap-3 bg-white/75 shadow-none border border-slate-200/70"
          >
            <div className="news-loading-thumb rounded-md" />
            <div className="flex-1 space-y-2">
              <div className="news-loading-line news-loading-shimmer w-40" />
              <div className="news-loading-line news-loading-shimmer w-28" />
            </div>
            <div className="news-loading-line news-loading-shimmer w-16" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="news-loading-line news-loading-shimmer w-36" />
        <div className="grid grid-cols-2 gap-2">
          {[...Array(4)].map((_, idx) => (
            <div key={idx} className="news-loading-line news-loading-shimmer w-full" />
          ))}
        </div>
      </div>
    </div>
  );

  const renderSalesDoctorDetailSkeleton = () => (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="news-loading-line news-loading-shimmer w-60" />
        <div className="news-loading-line news-loading-shimmer w-44" />
      </div>

      <div className="flex items-center gap-4">
        <div
          className="news-loading-thumb rounded-full"
          style={{ width: 72, height: 72, minWidth: 72 }}
        />
        <div className="flex-1 space-y-2">
          <div className="news-loading-line news-loading-shimmer w-40" />
          <div className="news-loading-line news-loading-shimmer w-32" />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[...Array(3)].map((_, idx) => (
          <div
            key={idx}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 space-y-2"
          >
            <div className="news-loading-line news-loading-shimmer w-24" />
            <div className="news-loading-line news-loading-shimmer w-16" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[...Array(2)].map((_, idx) => (
          <div
            key={idx}
            className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-3 space-y-2"
          >
            <div className="news-loading-line news-loading-shimmer w-28" />
            <div className="news-loading-line news-loading-shimmer w-full" />
            <div className="news-loading-line news-loading-shimmer w-5/6" />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="news-loading-line news-loading-shimmer w-36" />
        <div className="space-y-2">
          {[...Array(3)].map((_, idx) => (
            <div
              key={idx}
              className="news-loading-card flex items-center gap-3 bg-white/75 shadow-none border border-slate-200/70"
            >
              <div className="news-loading-thumb rounded-md" />
              <div className="flex-1 space-y-2">
                <div className="news-loading-line news-loading-shimmer w-40" />
                <div className="news-loading-line news-loading-shimmer w-28" />
              </div>
              <div className="news-loading-line news-loading-shimmer w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const enrichMissingOrderDetails = useCallback(
    async (
      ordersToEnrich: AccountOrderSummary[],
      options?: { onlyIds?: Set<string>; force?: boolean },
    ) => {
      const DETAIL_TTL_MS = 10 * 60 * 1000;
      const now = Date.now();
      const onlyIds = options?.onlyIds;
      const force = options?.force === true;

      const needsDetail = ordersToEnrich.filter((order) => {
        const key = String(order.id || order.number || "");
        if (!key) return false;
        if (onlyIds && !onlyIds.has(key)) return false;

        const hasPlaced =
          Boolean(
            order.createdAt ||
              (order as any).dateCreated ||
              (order as any).date_created ||
              (order as any).date_created_gmt,
          ) || false;
        const hasEta = Boolean(
          order?.shippingEstimate?.estimatedArrivalDate ||
            (order as any)?.shippingEstimate?.deliveryDateGuaranteed ||
            (order as any)?.shippingEstimate?.estimated_delivery_date ||
            (order as any)?.shipping?.estimatedArrivalDate ||
            (order as any)?.shipping?.estimated_delivery_date,
        );
        if (hasPlaced && hasEta) return false;

        if (!force) {
          const lastFetchedAt = salesOrderDetailFetchedAtRef.current.get(key) || 0;
          if (lastFetchedAt > 0 && now - lastFetchedAt < DETAIL_TTL_MS) {
            return false;
          }
        }
        return true;
      });

      if (needsDetail.length === 0) return;

      const shimmerStart =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      const MIN_SHIMMER_MS = 420;

      const ids = new Set(
        needsDetail.map((order) => String(order.id || order.number || "")),
      );
      setSalesOrderHydratingIds(ids);

      const MAX_DETAIL_CONCURRENCY = 3;
      const runWithConcurrency = async <T,>(
        items: T[],
        limit: number,
        worker: (item: T) => Promise<void>,
      ) => {
        const queue = [...items];
        const runners = Array.from({ length: Math.max(1, limit) }, async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            await worker(next);
          }
        });
        await Promise.all(runners);
      };

      await runWithConcurrency(needsDetail, MAX_DETAIL_CONCURRENCY, async (order) => {
          try {
            const key = String(order.id || order.number || "");
            if (key) {
              salesOrderDetailFetchedAtRef.current.set(key, now);
            }
            const detail = await ordersAPI.getSalesRepOrderDetail(
              order.wooOrderId || order.id || order.number || "",
              (order as any)?.doctorEmail ||
                (order as any)?.doctor_email ||
                (order as any)?.doctorId ||
                null,
            );
            const normalized = normalizeAccountOrdersResponse(
              { woo: Array.isArray(detail) ? detail : [detail] },
              { includeCanceled: true },
            );
            if (normalized && normalized.length > 0) {
              mergeSalesOrderDetail(normalized[0]);
            } else if (detail && typeof detail === "object") {
              mergeSalesOrderDetail(detail as AccountOrderSummary);
            }
          } catch (error) {
            console.debug("[Sales Tracking] detail enrichment skipped", {
              orderId: order.id,
              message:
                typeof (error as any)?.message === "string"
                  ? (error as any).message
                  : String(error),
            });
          }
        });

      const elapsed =
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()) - shimmerStart;
      if (elapsed < MIN_SHIMMER_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_SHIMMER_MS - elapsed));
      }
      setSalesOrderHydratingIds(new Set());
    },
    [mergeSalesOrderDetail],
  );
  const [salesRepSalesSummary, setSalesRepSalesSummary] = useState<
    {
      salesRepId: string;
      salesRepName: string;
      salesRepEmail: string | null;
      totalOrders: number;
      totalRevenue: number;
      wholesaleRevenue?: number;
      retailRevenue?: number;
    }[]
  >([]);
  const [salesRepSalesSummaryMeta, setSalesRepSalesSummaryMeta] = useState<{
    periodStart?: string | null;
    periodEnd?: string | null;
    totals?:
      | {
          totalOrders: number;
          totalRevenue: number;
          wholesaleRevenue?: number;
          retailRevenue?: number;
        }
      | null;
  } | null>(null);
  const [salesRepSalesSummaryLastFetchedAt, setSalesRepSalesSummaryLastFetchedAt] =
    useState<number | null>(null);
  const [salesRepSalesSummaryLoading, setSalesRepSalesSummaryLoading] =
    useState(false);
  const [salesRepSalesCsvDownloadedAt, setSalesRepSalesCsvDownloadedAt] =
    useState<string | null>(null);
  const [salesRepSalesSummaryError, setSalesRepSalesSummaryError] = useState<
    string | null
  >(null);
  const [adminTaxesByStateRows, setAdminTaxesByStateRows] = useState<
    { state: string; taxTotal: number; orderCount: number }[]
  >([]);
  const [adminTaxesByStateOrders, setAdminTaxesByStateOrders] = useState<
    { orderNumber: string; state: string; taxTotal: number }[]
  >([]);
  const [adminTaxesByStateBreakdownOpen, setAdminTaxesByStateBreakdownOpen] =
    useState(false);
  const [adminTaxesByStateMeta, setAdminTaxesByStateMeta] = useState<{
    periodStart?: string | null;
    periodEnd?: string | null;
    totals?: { orderCount: number; taxTotal: number } | null;
  } | null>(null);
  const [adminTaxesByStateLoading, setAdminTaxesByStateLoading] = useState(false);
  const [adminTaxesByStateError, setAdminTaxesByStateError] = useState<string | null>(null);
  const [adminTaxesByStateLastFetchedAt, setAdminTaxesByStateLastFetchedAt] =
    useState<number | null>(null);
  const [adminTaxesByStateCsvDownloadedAt, setAdminTaxesByStateCsvDownloadedAt] =
    useState<string | null>(null);

  const [adminProductSalesRows, setAdminProductSalesRows] = useState<
    {
      key: string;
      sku?: string | null;
      productId?: number | null;
      variationId?: number | null;
      name: string;
      quantity: number;
    }[]
  >([]);
  const [adminCommissionRows, setAdminCommissionRows] = useState<
    {
      id: string;
      name: string;
      role: string;
      amount: number;
      retailOrders?: number;
      wholesaleOrders?: number;
      retailBase?: number;
      wholesaleBase?: number;
      houseRetailOrders?: number;
      houseWholesaleOrders?: number;
      houseRetailBase?: number;
      houseWholesaleBase?: number;
      houseRetailCommission?: number;
      houseWholesaleCommission?: number;
      specialAdminBonus?: number;
      specialAdminBonusRate?: number;
      specialAdminBonusMonthlyCap?: number;
      specialAdminBonusByMonth?: Record<string, number>;
      specialAdminBonusBaseByMonth?: Record<string, number>;
    }[]
  >([]);
  const [adminProductsCommissionMeta, setAdminProductsCommissionMeta] = useState<{
    periodStart?: string | null;
    periodEnd?: string | null;
    totals?: Record<string, any> | null;
  } | null>(null);
  const [adminProductsCommissionLoading, setAdminProductsCommissionLoading] =
    useState(false);
  const [adminProductsCommissionError, setAdminProductsCommissionError] =
    useState<string | null>(null);
  const [adminProductsCommissionLastFetchedAt, setAdminProductsCommissionLastFetchedAt] =
    useState<number | null>(null);
  const [adminProductsCommissionCsvDownloadedAt, setAdminProductsCommissionCsvDownloadedAt] =
    useState<string | null>(null);
  const [salesRepPeriodStart, setSalesRepPeriodStart] = useState<string>(
    () => getDefaultSalesBySalesRepPeriod().start,
  );
  const [salesRepPeriodEnd, setSalesRepPeriodEnd] = useState<string>(
    () => getDefaultSalesBySalesRepPeriod().end,
  );
  const [adminDashboardPeriodRange, setAdminDashboardPeriodRange] = useState<
    DateRange | undefined
  >(undefined);
  const [adminDashboardPeriodPickerOpen, setAdminDashboardPeriodPickerOpen] =
    useState(false);

  useEffect(() => {
    if (adminDashboardPeriodPickerOpen) return;
    const parse = (value: string) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const from = salesRepPeriodStart ? parse(salesRepPeriodStart) : null;
    const to = salesRepPeriodEnd ? parse(salesRepPeriodEnd) : null;
    if (from && to) {
      setAdminDashboardPeriodRange({ from, to });
    } else {
      setAdminDashboardPeriodRange(undefined);
    }
  }, [adminDashboardPeriodPickerOpen, salesRepPeriodEnd, salesRepPeriodStart]);
  const [userReferralCodes, setUserReferralCodes] = useState<string[]>([]);
  const normalizeReferralCodeValue = useCallback((value: unknown): string => {
    if (typeof value === "string") {
      return value.trim().toUpperCase();
    }
    if (value && typeof value === "object") {
      const raw =
        (value as Record<string, unknown>).code ??
        (value as Record<string, unknown>).value ??
        null;
      if (typeof raw === "string") {
        return raw.trim().toUpperCase();
      }
    }
    return "";
  }, []);
  const normalizedDashboardCodes = useMemo(() => {
    const codes = salesRepDashboard?.codes;
    if (!Array.isArray(codes)) {
      return [];
    }
    return codes
      .map((code) => normalizeReferralCodeValue(code))
      .filter(
        (value, index, array) =>
          value.length > 0 && array.indexOf(value) === index,
      );
  }, [salesRepDashboard?.codes, normalizeReferralCodeValue]);
  const referralCodesForHeader = useMemo(() => {
    const merged = [...normalizedDashboardCodes, ...userReferralCodes];
    return merged.filter(
      (value, index, array) => value.length > 0 && array.indexOf(value) === index,
    );
  }, [normalizedDashboardCodes, userReferralCodes]);

	  useEffect(() => {
	    if (!user || (!isAdmin(user.role) && !isSalesLead(user.role))) {
	      setSalesRepSalesCsvDownloadedAt(null);
	      setAdminTaxesByStateCsvDownloadedAt(null);
	      setAdminProductsCommissionCsvDownloadedAt(null);
	      return;
	    }
	    let cancelled = false;
	    (async () => {
	      try {
	        const reportSettings = await settingsAPI.getReportSettings();
	        const salesDownloadedAtRaw = isSalesLead(user.role)
	          ? (reportSettings as any)?.salesLeadSalesBySalesRepCsvDownloadedAt
	          : (reportSettings as any)?.salesBySalesRepCsvDownloadedAt;
	        const downloadedAt =
	          typeof salesDownloadedAtRaw === "string" ? String(salesDownloadedAtRaw) : null;
	        const taxesDownloadedAt =
	          typeof (reportSettings as any)?.taxesByStateCsvDownloadedAt === "string"
	            ? String((reportSettings as any).taxesByStateCsvDownloadedAt)
	            : null;
	        const productsDownloadedAt =
	          typeof (reportSettings as any)?.productsCommissionCsvDownloadedAt === "string"
	            ? String((reportSettings as any).productsCommissionCsvDownloadedAt)
	            : null;
	        if (!cancelled) {
	          setSalesRepSalesCsvDownloadedAt(downloadedAt);
	          setAdminTaxesByStateCsvDownloadedAt(taxesDownloadedAt);
	          setAdminProductsCommissionCsvDownloadedAt(productsDownloadedAt);
	        }
	      } catch (error) {
	        console.debug("[Sales by Sales Rep] Failed to load report settings", error);
	      }
	    })();
	    return () => {
	      cancelled = true;
	    };
	  }, [user?.id, user?.role]);

	  const downloadSalesBySalesRepCsv = useCallback(async () => {
	    try {
	      const exportedAt = new Date();
	      const exportedAtIso = exportedAt.toISOString();
	      const escapeCsv = (value: unknown) => {
	        if (value === null || value === undefined) return "";
	        const text = String(value);
	        if (/[",\n\r]/.test(text)) {
	          return `"${text.replace(/"/g, '""')}"`;
	        }
	        return text;
	      };

	      const periodStart = salesRepSalesSummaryMeta?.periodStart
	        ? String(salesRepSalesSummaryMeta.periodStart).slice(0, 10)
	        : null;
	      const periodEnd = salesRepSalesSummaryMeta?.periodEnd
	        ? String(salesRepSalesSummaryMeta.periodEnd).slice(0, 10)
	        : null;
	      const periodTitle =
	        periodStart && periodEnd ? `${periodStart} to ${periodEnd} (PST)` : "All time (PST)";

	      const rows = [
	        escapeCsv(`Sales by Sales Rep — ${periodTitle}`),
	        "",
	        ["Sales Rep", "Email", "Orders", "Wholesale", "Retail"].join(","),
	        ...salesRepSalesSummary.map((rep) =>
	          [
	            escapeCsv(rep.salesRepName || ""),
	            escapeCsv(rep.salesRepEmail || ""),
            escapeCsv(Number(rep.totalOrders || 0)),
            escapeCsv(Number(rep.wholesaleRevenue || 0).toFixed(2)),
            escapeCsv(Number(rep.retailRevenue || 0).toFixed(2)),
          ].join(","),
        ),
      ];

	      const csv = rows.join("\n");
	      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
	      const url = URL.createObjectURL(blob);
	      const link = document.createElement("a");
	      const stamp = exportedAtIso.replace(/[:.]/g, "-");
	      const periodLabel =
	        periodStart && periodEnd ? `_${periodStart}_to_${periodEnd}` : "";
	      link.href = url;
	      link.download = `sales-by-sales-rep${periodLabel}_${FRONTEND_BUILD_ID}_${stamp}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSalesRepSalesCsvDownloadedAt(exportedAtIso);
	      if (user && (isAdmin(user.role) || isSalesLead(user.role))) {
	        try {
	          if (isSalesLead(user.role) && !isAdmin(user.role)) {
	            await settingsAPI.setSalesLeadSalesBySalesRepCsvDownloadedAt(exportedAtIso);
	          } else {
	            await settingsAPI.setSalesBySalesRepCsvDownloadedAt(exportedAtIso);
	          }
	        } catch (error) {
	          console.debug(
	            "[Sales by Sales Rep] Failed to persist CSV download timestamp",
	            error,
	          );
	        }
	      }
    } catch (error) {
      console.error("[Sales by Sales Rep] CSV export failed", error);
      toast.error("Unable to download report right now.");
    }
  }, [
    salesRepSalesSummary,
    salesRepSalesSummaryMeta?.periodEnd,
    salesRepSalesSummaryMeta?.periodStart,
    user,
    user?.role,
  ]);

  const refreshAdminTaxesByState = useCallback(async () => {
    if (!user || !isAdmin(user.role)) return;
    setAdminTaxesByStateLoading(true);
    setAdminTaxesByStateError(null);
    try {
      const defaults = getDefaultSalesBySalesRepPeriod();
      const periodStart = salesRepPeriodStart || defaults.start;
      const periodEnd = salesRepPeriodEnd || defaults.end;
      const response = await ordersAPI.getTaxesByStateForAdmin({
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      });
      const rows = Array.isArray((response as any)?.rows)
        ? ((response as any).rows as any[])
        : Array.isArray(response)
          ? (response as any[])
          : [];
	      setAdminTaxesByStateRows(
	        rows
	          .map((row) => ({
	            state: String((row as any)?.state || "UNKNOWN"),
	            taxTotal: Number((row as any)?.taxTotal || 0),
	            orderCount: Number((row as any)?.orderCount || 0),
	          }))
	          .filter((row) => row.orderCount > 0 || row.taxTotal > 0),
	      );
      const orderTaxesRaw = Array.isArray((response as any)?.orderTaxes)
        ? ((response as any).orderTaxes as any[])
        : [];
	      setAdminTaxesByStateOrders(
	        orderTaxesRaw
	          .map((line) => ({
	            orderNumber: String((line as any)?.orderNumber || ""),
	            state: String((line as any)?.state || "UNKNOWN"),
	            taxTotal: Number((line as any)?.taxTotal || 0),
	          }))
	          .filter(
	            (line) => line.orderNumber.trim().length > 0 && line.taxTotal > 0,
	          ),
	      );
      setAdminTaxesByStateBreakdownOpen(false);
      setAdminTaxesByStateMeta({
        periodStart: (response as any)?.periodStart ?? null,
        periodEnd: (response as any)?.periodEnd ?? null,
        totals: (response as any)?.totals ?? null,
      });
      setAdminTaxesByStateLastFetchedAt(Date.now());
    } catch (error: any) {
      const message =
        typeof error?.message === "string"
          ? error.message
          : "Unable to load taxes by state.";
      setAdminTaxesByStateError(message);
      setAdminTaxesByStateRows([]);
      setAdminTaxesByStateOrders([]);
      setAdminTaxesByStateBreakdownOpen(false);
      setAdminTaxesByStateMeta(null);
    } finally {
      setAdminTaxesByStateLoading(false);
    }
  }, [salesRepPeriodEnd, salesRepPeriodStart, user?.id, user?.role]);

	  const downloadAdminTaxesByStateCsv = useCallback(async () => {
		    try {
		      const exportedAt = new Date();
		      const exportedAtIso = exportedAt.toISOString();
	      const escapeCsv = (value: unknown) => {
        if (value === null || value === undefined) return "";
        const text = String(value);
        if (/[",\n\r]/.test(text)) {
          return `"${text.replace(/"/g, '""')}"`;
        }
        return text;
      };
      const periodStart = adminTaxesByStateMeta?.periodStart
        ? String(adminTaxesByStateMeta.periodStart).slice(0, 10)
        : null;
	      const periodEnd = adminTaxesByStateMeta?.periodEnd
	        ? String(adminTaxesByStateMeta.periodEnd).slice(0, 10)
	        : null;
	      const periodLabel =
	        periodStart && periodEnd ? `_${periodStart}_to_${periodEnd}` : "";
	      const stamp = exportedAtIso.replace(/[:.]/g, "-");
	      const periodTitle =
	        periodStart && periodEnd ? `${periodStart} to ${periodEnd} (PST)` : "All time (PST)";

	      const rows = [
	        escapeCsv(`Taxes by State — ${periodTitle}`),
	        "",
	        ["State", "Orders", "Tax Total"].join(","),
	        ...adminTaxesByStateRows.map((row) =>
	          [
	            escapeCsv(row.state),
            escapeCsv(Number(row.orderCount || 0)),
            escapeCsv(Number(row.taxTotal || 0).toFixed(2)),
          ].join(","),
        ),
      ];
      const csv = rows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `taxes-by-state${periodLabel}_${FRONTEND_BUILD_ID}_${stamp}.csv`;
      document.body.appendChild(link);
		      link.click();
		      link.remove();
		      URL.revokeObjectURL(url);
		      setAdminTaxesByStateCsvDownloadedAt(exportedAtIso);
		      if (user && isAdmin(user.role)) {
		        try {
		          await settingsAPI.setTaxesByStateCsvDownloadedAt(exportedAtIso);
		        } catch (error) {
		          console.debug(
		            "[Taxes by State] Failed to persist CSV download timestamp",
		            error,
		          );
		        }
		      }
		    } catch (error) {
		      console.error("[Taxes by State] CSV export failed", error);
		      toast.error("Unable to download report right now.");
		    }
		  }, [
		    adminTaxesByStateMeta?.periodEnd,
		    adminTaxesByStateMeta?.periodStart,
		    adminTaxesByStateRows,
		    user,
		    user?.role,
		  ]);

  const refreshAdminProductsCommission = useCallback(async () => {
    if (!user || !isAdmin(user.role)) return;
    setAdminProductsCommissionLoading(true);
    setAdminProductsCommissionError(null);
    try {
      const defaults = getDefaultSalesBySalesRepPeriod();
      const periodStart = salesRepPeriodStart || defaults.start;
      const periodEnd = salesRepPeriodEnd || defaults.end;
      const response = await ordersAPI.getProductSalesCommissionForAdmin({
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      });
      const backendError =
        response && typeof response === "object" && !Array.isArray(response)
          ? typeof (response as any)?.error === "string"
            ? String((response as any).error).trim()
            : null
          : null;
      const products = Array.isArray((response as any)?.products)
        ? ((response as any).products as any[])
        : [];
      const commissions = Array.isArray((response as any)?.commissions)
        ? ((response as any).commissions as any[])
        : [];
      if (backendError && products.length === 0 && commissions.length === 0) {
        setAdminProductsCommissionError(backendError);
      }
      const filteredCommissions = commissions.filter((row) => {
        const role = String((row as any)?.role || "").toLowerCase();
        const id = String((row as any)?.id || "");
        if (role === "supplier") return false;
        if (id === "__supplier__") return false;
        return true;
      });
      setAdminProductSalesRows(
        products
          .map((row) => ({
            key: String((row as any)?.key || (row as any)?.sku || ""),
            sku: (row as any)?.sku ?? null,
            productId: (row as any)?.productId ?? null,
            variationId: (row as any)?.variationId ?? null,
            name: String((row as any)?.name || ""),
            quantity: Number((row as any)?.quantity || 0),
          }))
          .filter((row) => row.quantity > 0),
      );
      setAdminCommissionRows(
        filteredCommissions
          .map((row) => ({
            id: String((row as any)?.id || ""),
            name: String((row as any)?.name || ""),
            role: String((row as any)?.role || ""),
            amount: Number((row as any)?.amount || 0),
            retailOrders: Number((row as any)?.retailOrders || 0),
            wholesaleOrders: Number((row as any)?.wholesaleOrders || 0),
            retailBase: Number((row as any)?.retailBase || 0),
            wholesaleBase: Number((row as any)?.wholesaleBase || 0),
            houseRetailOrders: Number((row as any)?.houseRetailOrders || 0),
            houseWholesaleOrders: Number((row as any)?.houseWholesaleOrders || 0),
            houseRetailBase: Number((row as any)?.houseRetailBase || 0),
            houseWholesaleBase: Number((row as any)?.houseWholesaleBase || 0),
            houseRetailCommission: Number((row as any)?.houseRetailCommission || 0),
            houseWholesaleCommission: Number((row as any)?.houseWholesaleCommission || 0),
            specialAdminBonus: Number((row as any)?.specialAdminBonus || 0),
            specialAdminBonusRate: Number((row as any)?.specialAdminBonusRate || 0),
            specialAdminBonusMonthlyCap: Number((row as any)?.specialAdminBonusMonthlyCap || 0),
            specialAdminBonusByMonth: ((row as any)?.specialAdminBonusByMonth ?? undefined) as any,
            specialAdminBonusBaseByMonth: ((row as any)?.specialAdminBonusBaseByMonth ?? undefined) as any,
          }))
          .filter((row) => {
            return (
              Number(row.amount || 0) > 0 ||
              Number(row.retailOrders || 0) > 0 ||
              Number(row.wholesaleOrders || 0) > 0 ||
              Number(row.retailBase || 0) > 0 ||
              Number(row.wholesaleBase || 0) > 0 ||
              Number(row.houseRetailOrders || 0) > 0 ||
              Number(row.houseWholesaleOrders || 0) > 0 ||
              Number(row.houseRetailBase || 0) > 0 ||
              Number(row.houseWholesaleBase || 0) > 0 ||
              Number(row.houseRetailCommission || 0) > 0 ||
              Number(row.houseWholesaleCommission || 0) > 0 ||
              Number(row.specialAdminBonus || 0) > 0
            );
          }),
      );
      setAdminProductsCommissionMeta({
        periodStart: (response as any)?.periodStart ?? null,
        periodEnd: (response as any)?.periodEnd ?? null,
        totals: (response as any)?.totals ?? null,
      });
      setAdminProductsCommissionLastFetchedAt(Date.now());
    } catch (error: any) {
      const message =
        typeof error?.message === "string"
          ? error.message
          : "Unable to load product/commission report.";
      setAdminProductsCommissionError(message);
      setAdminProductSalesRows([]);
      setAdminCommissionRows([]);
      setAdminProductsCommissionMeta(null);
    } finally {
      setAdminProductsCommissionLoading(false);
    }
  }, [salesRepPeriodEnd, salesRepPeriodStart, user?.id, user?.role]);

	  const downloadAdminProductsCommissionCsv = useCallback(async () => {
	    try {
	      const exportedAt = new Date();
	      const exportedAtIso = exportedAt.toISOString();
	      const escapeCsv = (value: unknown) => {
	        if (value === null || value === undefined) return "";
	        const text = String(value);
	        if (/[",\n\r]/.test(text)) {
	          return `"${text.replace(/"/g, '""')}"`;
	        }
	        return text;
	      };
	      const periodStart = adminProductsCommissionMeta?.periodStart
	        ? String(adminProductsCommissionMeta.periodStart).slice(0, 10)
	        : null;
	      const periodEnd = adminProductsCommissionMeta?.periodEnd
	        ? String(adminProductsCommissionMeta.periodEnd).slice(0, 10)
	        : null;
	      const periodLabel =
	        periodStart && periodEnd ? `_${periodStart}_to_${periodEnd}` : "";
	      const periodTitle =
	        periodStart && periodEnd ? `${periodStart} to ${periodEnd} (PST)` : "All time (PST)";
	      const stamp = exportedAtIso.replace(/[:.]/g, "-");

	      const rows: string[] = [];
	      rows.push(escapeCsv(`Products Sold & Commission — ${periodTitle}`));
	      rows.push("");
	      rows.push(["Report", "Products sold"].join(","));
	      rows.push(["Product", "SKU", "ProductId", "Quantity"].join(","));
	      adminProductSalesRows.forEach((product) => {
	        rows.push(
          [
            escapeCsv(product.name),
            escapeCsv(product.sku || ""),
            escapeCsv(product.productId ?? ""),
            escapeCsv(Number(product.quantity || 0)),
          ].join(","),
        );
      });
	      rows.push("");
	      rows.push(["Report", "Commissions"].join(","));
              rows.push(
                [
                  "Recipient",
                  "Role",
                  "RetailOrders",
                  "WholesaleOrders",
                  "RetailBase",
                  "WholesaleBase",
                  "HouseRetailOrders",
                  "HouseWholesaleOrders",
                  "HouseRetailBase",
                  "HouseWholesaleBase",
                  "HouseRetailCommission",
                  "HouseWholesaleCommission",
                  "Administrative",
                  "Amount",
                ].join(","),
              );
	      adminCommissionRows.forEach((row) => {
                rows.push(
                  [
                    escapeCsv(row.name),
                    escapeCsv(row.role),
                    escapeCsv(Number(row.retailOrders || 0)),
                    escapeCsv(Number(row.wholesaleOrders || 0)),
                    escapeCsv(Number(row.retailBase || 0).toFixed(2)),
                    escapeCsv(Number(row.wholesaleBase || 0).toFixed(2)),
                    escapeCsv(Number(row.houseRetailOrders || 0)),
                    escapeCsv(Number(row.houseWholesaleOrders || 0)),
                    escapeCsv(Number(row.houseRetailBase || 0).toFixed(2)),
                    escapeCsv(Number(row.houseWholesaleBase || 0).toFixed(2)),
                    escapeCsv(Number(row.houseRetailCommission || 0).toFixed(2)),
                    escapeCsv(Number(row.houseWholesaleCommission || 0).toFixed(2)),
                    escapeCsv(Number(row.specialAdminBonus || 0).toFixed(2)),
                    escapeCsv(Number(row.amount || 0).toFixed(2)),
                  ].join(","),
                );
              });

	      const csv = rows.join("\n");
	      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
	      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `products-and-commission${periodLabel}_${FRONTEND_BUILD_ID}_${stamp}.csv`;
      document.body.appendChild(link);
		      link.click();
		      link.remove();
		      URL.revokeObjectURL(url);
		      setAdminProductsCommissionCsvDownloadedAt(exportedAtIso);
		      if (user && isAdmin(user.role)) {
		        try {
		          await settingsAPI.setProductsCommissionCsvDownloadedAt(exportedAtIso);
		        } catch (error) {
		          console.debug(
		            "[Products/Commission] Failed to persist CSV download timestamp",
		            error,
		          );
		        }
		      }
		    } catch (error) {
		      console.error("[Products/Commission] CSV export failed", error);
		      toast.error("Unable to download report right now.");
		    }
	  }, [
	    adminCommissionRows,
	    adminProductSalesRows,
	    adminProductsCommissionMeta?.periodEnd,
	    adminProductsCommissionMeta?.periodStart,
	    user,
	    user?.role,
	  ]);

	  const refreshSalesBySalesRepSummary = useCallback(async () => {
	    if (!user || (!isAdmin(user.role) && !isSalesLead(user.role))) return;
	    setSalesRepSalesSummaryLoading(true);
	    setSalesRepSalesSummaryError(null);
	    try {
	      const defaults = getDefaultSalesBySalesRepPeriod();
      const periodStart = salesRepPeriodStart || defaults.start;
      const periodEnd = salesRepPeriodEnd || defaults.end;
      if (!salesRepPeriodStart) {
        setSalesRepPeriodStart(periodStart);
      }
      if (!salesRepPeriodEnd) {
        setSalesRepPeriodEnd(periodEnd);
      }
      const salesSummaryResponse = await ordersAPI.getSalesByRepForAdmin({
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      });
      const summaryArray = Array.isArray(salesSummaryResponse)
        ? salesSummaryResponse
        : Array.isArray((salesSummaryResponse as any)?.orders)
          ? (salesSummaryResponse as any).orders
          : [];
	      const meta =
	        salesSummaryResponse && typeof salesSummaryResponse === "object"
	          ? {
	              periodStart: (salesSummaryResponse as any)?.periodStart ?? null,
	              periodEnd: (salesSummaryResponse as any)?.periodEnd ?? null,
	              totals: (salesSummaryResponse as any)?.totals ?? null,
	            }
	          : null;
		      const filteredSummary = summaryArray
		        .filter((rep: any) => !isAdmin(user.role) || rep.salesRepId !== user.id)
		        .filter((rep: any) => {
		          const totalOrders = Number(rep?.totalOrders || 0);
		          const totalRevenue = Number(rep?.totalRevenue || 0);
		          const wholesaleRevenue = Number(rep?.wholesaleRevenue || 0);
		          const retailRevenue = Number(rep?.retailRevenue || 0);
	          return (
	            totalOrders > 0 ||
	            totalRevenue > 0 ||
	            wholesaleRevenue > 0 ||
	            retailRevenue > 0
	          );
	        });
	      setSalesRepSalesSummary(filteredSummary as any);
	      setSalesRepSalesSummaryMeta(meta);
	      setSalesRepSalesSummaryLastFetchedAt(Date.now());
    } catch (adminError: any) {
      const message =
        typeof adminError?.message === "string"
          ? adminError.message
          : "Unable to load sales summary";
      setSalesRepSalesSummaryError(message);
      setSalesRepSalesSummaryMeta(null);
    } finally {
      setSalesRepSalesSummaryLoading(false);
    }
  }, [salesRepPeriodEnd, salesRepPeriodStart, user?.id, user?.role]);

  const applyAdminDashboardPeriod = useCallback(() => {
    void refreshSalesBySalesRepSummary();
    void refreshAdminTaxesByState();
    void refreshAdminProductsCommission();
  }, [refreshAdminProductsCommission, refreshAdminTaxesByState, refreshSalesBySalesRepSummary]);

  const clearAdminDashboardPeriod = useCallback(() => {
    const defaults = getDefaultSalesBySalesRepPeriod();
    setSalesRepPeriodStart(defaults.start);
    setSalesRepPeriodEnd(defaults.end);
    void refreshSalesBySalesRepSummary();
    void refreshAdminTaxesByState();
    void refreshAdminProductsCommission();
  }, [refreshAdminProductsCommission, refreshAdminTaxesByState, refreshSalesBySalesRepSummary]);

	  const salesByRepAutoLoadedKeyRef = useRef<string>("");
	  useEffect(() => {
	    if (!user || (!isAdmin(user.role) && !isSalesLead(user.role))) {
	      salesByRepAutoLoadedKeyRef.current = "";
	      return;
	    }
	    const key = `${user.id}|${user.role}`;
	    if (salesByRepAutoLoadedKeyRef.current === key) {
	      return;
	    }
	    salesByRepAutoLoadedKeyRef.current = key;
	    if (isAdmin(user.role)) {
	      void refreshSalesBySalesRepSummary();
	      void refreshAdminTaxesByState();
	      void refreshAdminProductsCommission();
	    } else {
	      void refreshSalesBySalesRepSummary();
	    }
	  }, [
	    refreshAdminProductsCommission,
	    refreshAdminTaxesByState,
	    refreshSalesBySalesRepSummary,
    user?.id,
    user?.role,
  ]);

  useEffect(() => {
    if (!user || !isAdmin(user.role)) return;
    if (!salesDoctorDetail?.doctorId) return;
    const role = normalizeRole(salesDoctorDetail.role || "");
    if (role !== "admin") return;
    const targetId = String(salesDoctorDetail.doctorId || "");
    if (!targetId) return;
    const hasCommissionRow = adminCommissionRows.some(
      (row) => String(row.id || "") === targetId,
    );
    if (hasCommissionRow) return;
    if (adminProductsCommissionLoading) return;
    void refreshAdminProductsCommission();
  }, [
    adminCommissionRows,
    adminProductsCommissionLoading,
    refreshAdminProductsCommission,
    salesDoctorDetail?.doctorId,
    salesDoctorDetail?.role,
    user,
    user?.role,
  ]);

  useEffect(() => {
    if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
      setUserReferralCodes([]);
      return;
    }
    let cancelled = false;
    const fetchCodes = async () => {
      try {
        const response = await referralAPI.getReferralCodes();
        const codes = Array.isArray(response?.codes)
          ? response.codes
          : Array.isArray(response)
            ? response
            : [];
        if (!cancelled) {
          const normalized = codes
            .map((code) => normalizeReferralCodeValue(code))
            .filter(
              (value, index, array) =>
                value.length > 0 && array.indexOf(value) === index,
            );
          setUserReferralCodes(normalized);
        }
      } catch (error) {
        console.warn("[Referral] Failed to fetch referral codes", error);
        if (!cancelled) {
          setUserReferralCodes([]);
        }
      }
    };
    fetchCodes();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role, normalizeReferralCodeValue]);

  useEffect(() => {
    if (!user || !(isAdmin(user.role) || isSalesLead(user.role))) {
      setSalesDoctorCommissionFromReport(null);
      setSalesDoctorCommissionFromReportLoading(false);
      salesDoctorCommissionFromReportKeyRef.current = "";
      return;
    }
    if (!salesDoctorDetail?.doctorId) {
      setSalesDoctorCommissionFromReport(null);
      setSalesDoctorCommissionFromReportLoading(false);
      salesDoctorCommissionFromReportKeyRef.current = "";
      return;
    }

    const resolvePeriod = () => {
      const rangeFrom = salesDoctorCommissionRange?.from ?? null;
      const rangeTo = salesDoctorCommissionRange?.to ?? null;
      if (rangeFrom && rangeTo) {
        const from = new Date(rangeFrom);
        const to = new Date(rangeTo);
        if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
          return {
            periodStart: from.toISOString().slice(0, 10),
            periodEnd: to.toISOString().slice(0, 10),
          };
        }
      }
      const periodStart = adminProductsCommissionMeta?.periodStart
        ? String(adminProductsCommissionMeta.periodStart).slice(0, 10)
        : salesRepPeriodStart
          ? String(salesRepPeriodStart).slice(0, 10)
          : salesRepSalesSummaryMeta?.periodStart
            ? String(salesRepSalesSummaryMeta.periodStart).slice(0, 10)
            : null;
      const periodEnd = adminProductsCommissionMeta?.periodEnd
        ? String(adminProductsCommissionMeta.periodEnd).slice(0, 10)
        : salesRepPeriodEnd
          ? String(salesRepPeriodEnd).slice(0, 10)
          : salesRepSalesSummaryMeta?.periodEnd
            ? String(salesRepSalesSummaryMeta.periodEnd).slice(0, 10)
            : null;
      return { periodStart, periodEnd };
    };

    const { periodStart, periodEnd } = resolvePeriod();
    const key = `${salesDoctorDetail.doctorId}|${periodStart || "all"}|${periodEnd || "all"}`;
    if (salesDoctorCommissionFromReportKeyRef.current === key) {
      return;
    }

    salesDoctorCommissionFromReportKeyRef.current = key;
    setSalesDoctorCommissionFromReportLoading(true);
    setSalesDoctorCommissionFromReport(null);
    let cancelled = false;

    (async () => {
      try {
        const response = await ordersAPI.getProductSalesCommissionForAdmin({
          periodStart: periodStart || undefined,
          periodEnd: periodEnd || undefined,
        });
        const commissions = Array.isArray((response as any)?.commissions)
          ? ((response as any).commissions as any[])
          : [];
        const match = commissions.find(
          (row) => String((row as any)?.id || "") === String(salesDoctorDetail.doctorId || ""),
        );
        const amount = match != null ? Number((match as any)?.amount || 0) : null;
        if (!cancelled) {
          setSalesDoctorCommissionFromReport(
            typeof amount === "number" && Number.isFinite(amount) ? amount : null,
          );
        }
      } catch {
        if (!cancelled) {
          setSalesDoctorCommissionFromReport(null);
        }
      } finally {
        if (!cancelled) {
          setSalesDoctorCommissionFromReportLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    adminProductsCommissionMeta?.periodEnd,
    adminProductsCommissionMeta?.periodStart,
    salesDoctorCommissionRange?.from,
    salesDoctorCommissionRange?.to,
    salesDoctorDetail?.doctorId,
    salesRepPeriodEnd,
    salesRepPeriodStart,
    salesRepSalesSummaryMeta?.periodEnd,
    salesRepSalesSummaryMeta?.periodStart,
    user,
    user?.role,
  ]);
  const [referralForm, setReferralForm] = useState({
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    notes: "",
  });
  const [referralSubmitting, setReferralSubmitting] = useState(false);
  const [referralStatusMessage, setReferralStatusMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [doctorDeletingReferralId, setDoctorDeletingReferralId] = useState<
    string | null
  >(null);
  const [showManualProspectModal, setShowManualProspectModal] = useState(false);
  const [manualProspectSubmitting, setManualProspectSubmitting] =
    useState(false);
  const [manualProspectForm, setManualProspectForm] = useState({
    name: "",
    email: "",
    phone: "",
    notes: "",
    status: "pending",
  });
  const resetManualProspectForm = useCallback(() => {
    setManualProspectForm({
      name: "",
      email: "",
      phone: "",
      notes: "",
      status: "pending",
    });
  }, []);
  const closeManualProspectModal = useCallback(() => {
    setShowManualProspectModal(false);
    resetManualProspectForm();
  }, [resetManualProspectForm]);
	  const [referralDataLoading, setReferralDataLoading] = useState(false);
	  const [referralDataError, setReferralDataError] = useState<ReactNode>(null);
	  const [shopEnabled, setShopEnabled] = useState(true);
	  const [testPaymentsOverrideEnabled, setTestPaymentsOverrideEnabled] = useState(false);
	  const [researchDashboardEnabled, setResearchDashboardEnabled] = useState(false);
	  const [settingsSupport, setSettingsSupport] = useState<{
	    research: boolean;
	  }>({ research: true });
	  const [settingsSaving, setSettingsSaving] = useState<{
	    shop: boolean;
	    forum: boolean;
	    research: boolean;
      testPaymentsOverride: boolean;
	  }>({ shop: false, forum: false, research: false, testPaymentsOverride: false });
	  type ServerHealthPayload = {
	    status?: string;
	    message?: string;
	    build?: string;
    timestamp?: string;
    mysql?: { enabled?: boolean | null } | null;
    queue?: { name?: string | null; length?: number | null } | null;
    usage?: {
      cpu?: {
        count?: number | null;
        loadAvg?: Record<string, number> | null;
        loadPercent?: number | null;
        usagePercent?: number | null;
      } | null;
      memory?: { totalMb?: number; availableMb?: number; usedPercent?: number } | null;
      disk?: { totalGb?: number; freeGb?: number; usedPercent?: number } | null;
      process?: { maxRssMb?: number; rssMb?: number } | null;
      platform?: string | null;
    } | null;
    cgroup?: { memory?: { usageMb?: number | null; limitMb?: number | null; usedPercent?: number | null } | null } | null;
    uptime?: { serviceSeconds?: number | null; workerSeconds?: number | null } | null;
    workers?: {
      configured?: number | null;
      detected?: number | null;
      pid?: number | null;
      ppid?: number | null;
      gunicorn?: { workers?: number | null; threads?: number | null; timeoutSeconds?: number | null } | null;
    } | null;
    processes?: {
      master?: { pid?: number | null; vmRssMb?: number | null; vmSizeMb?: number | null; threads?: number | null; state?: string | null } | null;
      children?: Array<{ pid?: number | null; vmRssMb?: number | null; vmSizeMb?: number | null; threads?: number | null; state?: string | null }> | null;
    } | null;
  };
  const [serverHealthPayload, setServerHealthPayload] =
    useState<ServerHealthPayload | null>(null);
  const [serverHealthLoading, setServerHealthLoading] = useState(false);
  const [serverHealthError, setServerHealthError] = useState<string | null>(null);
  const serverHealthInFlightRef = useRef(false);
  const serverHealthLastFetchedAtRef = useRef<number>(0);

  const fetchServerHealth = useCallback(
    async (options?: { force?: boolean }) => {
      if (!user || !isAdmin(user.role) || postLoginHold) {
        return;
      }
      const now = Date.now();
      const ttlMs = 30_000;
      if (!options?.force && now - serverHealthLastFetchedAtRef.current < ttlMs) {
        return;
      }
      if (serverHealthInFlightRef.current) {
        return;
      }
      serverHealthInFlightRef.current = true;
      serverHealthLastFetchedAtRef.current = now;
      setServerHealthLoading(true);
      setServerHealthError(null);
      try {
        const res = await fetch(`${API_BASE_URL}/health?_ts=${Date.now()}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`Health check failed (${res.status})`);
        }
        const payload = (await res.json()) as ServerHealthPayload;
        setServerHealthPayload(payload);
      } catch (error: any) {
        setServerHealthError(
          typeof error?.message === "string" ? error.message : "Unable to load server health.",
        );
      } finally {
        setServerHealthLoading(false);
        serverHealthInFlightRef.current = false;
      }
    },
    [user?.id, user?.role, postLoginHold],
  );
  const [userActivityNowTick, setUserActivityNowTick] = useState(0);
	  const [isIdle, setIsIdle] = useState(false);
	  const isIdleRef = useRef(false);
	  const lastActivityAtRef = useRef<number>(Date.now());
	  const idleLogoutFiredRef = useRef(false);
	  const sessionLogoutFiredRef = useRef(false);
	  const lastPresenceHeartbeatPingAtRef = useRef(0);
	  const lastPresenceInteractionPingAtRef = useRef(0);

  useEffect(() => {
	    isIdleRef.current = isIdle;
	  }, [isIdle]);

	  useEffect(() => {
		    if (!isAdmin(user?.role) && !isRep(user?.role) && !isSalesLead(user?.role)) return;
		    const id = window.setInterval(() => {
		      setUserActivityNowTick((tick) => (tick + 1) % Number.MAX_SAFE_INTEGER);
		    }, 30000);
		    return () => window.clearInterval(id);
		  }, [user?.role]);

		  const [liveClients, setLiveClients] = useState<any[]>([]);
		  const [liveClientsLoading, setLiveClientsLoading] = useState(false);
		  const [liveClientsError, setLiveClientsError] = useState<string | null>(null);
		  const liveClientsEtagRef = useRef<string | null>(null);
		  const liveClientsLongPollDisabledRef = useRef(false);
		  const [liveClientsShowOffline, setLiveClientsShowOffline] = useState(true);
		  const [liveClientsSearch, setLiveClientsSearch] = useState<string>("");
		  const [salesLeadLiveUsersRoleFilter, setSalesLeadLiveUsersRoleFilter] = useState<string>("all");

	  const [adminLiveUsers, setAdminLiveUsers] = useState<any[]>([]);
	  const [adminLiveUsersLoading, setAdminLiveUsersLoading] = useState(false);
	  const [adminLiveUsersError, setAdminLiveUsersError] = useState<string | null>(null);
	  const adminLiveUsersEtagRef = useRef<string | null>(null);
	  const adminLiveUsersLongPollDisabledRef = useRef(false);
	  const [adminLiveUsersShowOffline, setAdminLiveUsersShowOffline] = useState(false);
	  const [adminLiveUsersSearch, setAdminLiveUsersSearch] = useState<string>("");
	  const [adminLiveUsersRoleFilter, setAdminLiveUsersRoleFilter] = useState<string>("all");

	  useEffect(() => {
	    liveClientsRef.current = liveClients;
	  }, [liveClients]);

	  useEffect(() => {
	    adminLiveUsersRef.current = adminLiveUsers;
	  }, [adminLiveUsers]);

	  useEffect(() => {
	    const canSeeOwner =
	      Boolean(user?.role) && (isAdmin(user?.role) || isSalesLead(user?.role));
	    if (!canSeeOwner) return;
	    if (!salesDoctorDetail?.doctorId) return;
	    if (!isDoctorRole(salesDoctorDetail.role)) return;
	    const ownerId = String(salesDoctorDetail.ownerSalesRepId || "").trim();
	    if (!ownerId) return;
	    if (salesDoctorOwnerRepProfiles[ownerId]) return;

	    const findCandidate = () => {
	      const sources = [
	        ...(Array.isArray(liveClientsRef.current) ? liveClientsRef.current : []),
	        ...(Array.isArray(adminLiveUsersRef.current) ? adminLiveUsersRef.current : []),
	      ];
	      return sources.find((entry: any) => String(entry?.id || "").trim() === ownerId) || null;
	    };

	    const candidate = findCandidate();
	    if (!candidate) return;

	    const name =
	      candidate?.name ||
	      [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim() ||
	      candidate?.email ||
	      `User ${ownerId}`;
	    const email = typeof candidate?.email === "string" ? candidate.email : null;
	    const role = typeof candidate?.role === "string" ? candidate.role : null;
	    setSalesDoctorOwnerRepProfiles((current) => ({
	      ...current,
	      [ownerId]: { id: ownerId, name, email, role },
	    }));
	  }, [
	    adminLiveUsers,
	    liveClients,
	    salesDoctorDetail?.doctorId,
	    salesDoctorDetail?.ownerSalesRepId,
	    salesDoctorDetail?.role,
	    salesDoctorOwnerRepProfiles,
	    user?.role,
	  ]);

		  useEffect(() => {
		    const userRole = user?.role || null;
		    const isSalesLeadRole = isSalesLead(userRole);
		    const isSalesRepRole = isRep(userRole);
		    if (!isSalesLeadRole && !isSalesRepRole) {
		      setLiveClients([]);
		      setLiveClientsLoading(false);
		      setLiveClientsError(null);
		      liveClientsEtagRef.current = null;
		      liveClientsLongPollDisabledRef.current = false;
		      return;
		    }

	    let cancelled = false;
	    let intervalId: ReturnType<typeof window.setInterval> | null = null;

		    const fetchOnce = async () => {
		      try {
		        setLiveClientsLoading(true);
		        setLiveClientsError(null);
		        const payload = (await (isSalesLeadRole
		          ? settingsAPI.getLiveUsers()
		          : settingsAPI.getLiveClients())) as any;
		        if (cancelled) return;
		        liveClientsEtagRef.current =
		          typeof payload?.etag === "string" ? payload.etag : null;
		        const raw = isSalesLeadRole
		          ? Array.isArray(payload?.users)
		            ? payload.users
		            : []
		          : Array.isArray(payload?.clients)
		            ? payload.clients
		            : [];
		        const clients = isSalesLeadRole
		          ? raw.filter((entry: any) => {
		              const role = normalizeRole(entry?.role || "");
		              if (role === "admin") return false;
		              return isDoctorRole(role) || isRep(role);
		            })
		          : raw;
		        setLiveClients(clients);
		      } catch (error: any) {
		        if (cancelled) return;
		        setLiveClients([]);
		        setLiveClientsError(
	          typeof error?.message === "string"
	            ? error.message
	            : "Unable to load clients.",
	        );
	      } finally {
	        if (!cancelled) setLiveClientsLoading(false);
	      }
	    };

	    const sleep = (ms: number) =>
	      new Promise<void>((resolve) => window.setTimeout(resolve, ms));

	    const startIntervalFallback = () => {
	      if (intervalId) return;
	      void fetchOnce();
	      intervalId = window.setInterval(() => {
	        void fetchOnce();
	      }, 5000);
	    };

	    const controller = new AbortController();
		    const runLongPoll = async () => {
		      if (liveClientsLongPollDisabledRef.current) {
		        startIntervalFallback();
		        return;
		      }
		      while (!cancelled) {
	        if (!isPageVisible() || !isOnline()) {
	          // eslint-disable-next-line no-await-in-loop
	          await sleep(800);
	          continue;
		        }
		        try {
		          const payload = (await (isSalesLeadRole
		            ? settingsAPI.getLiveUsersLongPoll(
		                liveClientsEtagRef.current,
		                25000,
		                controller.signal,
		              )
		            : settingsAPI.getLiveClientsLongPoll(
		                null,
		                liveClientsEtagRef.current,
		                25000,
		                controller.signal,
		              ))) as any;
		          if (cancelled) break;
		          liveClientsEtagRef.current =
		            typeof payload?.etag === "string" ? payload.etag : null;
		          const raw = isSalesLeadRole
		            ? Array.isArray(payload?.users)
		              ? payload.users
		              : []
		            : Array.isArray(payload?.clients)
		              ? payload.clients
		              : [];
		          const clients = isSalesLeadRole
		            ? raw.filter((entry: any) => {
		                const role = normalizeRole(entry?.role || "");
		                if (role === "admin") return false;
		                return isDoctorRole(role) || isRep(role);
		              })
		            : raw;
		          setLiveClients(clients);
		        } catch (error: any) {
		          if (cancelled) break;
		          if (typeof error?.status === "number" && error.status === 404) {
		            liveClientsLongPollDisabledRef.current = true;
	            startIntervalFallback();
	            return;
	          }
	          // eslint-disable-next-line no-await-in-loop
	          await sleep(1000);
	        }
	      }
	    };

	    void runLongPoll();

	    return () => {
	      cancelled = true;
	      if (intervalId) window.clearInterval(intervalId);
	      controller.abort();
	    };
	  }, [user?.role, user?.id]);

	  useEffect(() => {
	    if (!isAdmin(user?.role)) {
	      setAdminLiveUsers([]);
	      setAdminLiveUsersLoading(false);
	      setAdminLiveUsersError(null);
	      adminLiveUsersEtagRef.current = null;
	      adminLiveUsersLongPollDisabledRef.current = false;
	      return;
	    }

	    let cancelled = false;
	    let intervalId: ReturnType<typeof window.setInterval> | null = null;

	    const fetchOnce = async () => {
	      try {
	        setAdminLiveUsersLoading(true);
	        setAdminLiveUsersError(null);
	        const payload = (await settingsAPI.getLiveUsers()) as any;
	        if (cancelled) return;
	        adminLiveUsersEtagRef.current = typeof payload?.etag === "string" ? payload.etag : null;
	        const users = Array.isArray(payload?.users) ? payload.users : [];
	        setAdminLiveUsers(users);
	      } catch (error: any) {
	        if (cancelled) return;
	        setAdminLiveUsers([]);
	        setAdminLiveUsersError(
	          typeof error?.message === "string" ? error.message : "Unable to load users.",
	        );
	      } finally {
	        if (!cancelled) setAdminLiveUsersLoading(false);
	      }
	    };

	    const sleep = (ms: number) =>
	      new Promise<void>((resolve) => window.setTimeout(resolve, ms));

	    const startIntervalFallback = () => {
	      if (intervalId) return;
	      void fetchOnce();
	      intervalId = window.setInterval(() => {
	        void fetchOnce();
	      }, 5000);
	    };

	    const controller = new AbortController();
	    const runLongPoll = async () => {
	      if (adminLiveUsersLongPollDisabledRef.current) {
	        startIntervalFallback();
	        return;
	      }
	      while (!cancelled) {
	        if (!isPageVisible() || !isOnline()) {
	          // eslint-disable-next-line no-await-in-loop
	          await sleep(800);
	          continue;
	        }
	        try {
	          const payload = (await settingsAPI.getLiveUsersLongPoll(
	            adminLiveUsersEtagRef.current,
	            25000,
	            controller.signal,
	          )) as any;
	          if (cancelled) break;
	          adminLiveUsersEtagRef.current = typeof payload?.etag === "string" ? payload.etag : null;
	          const users = Array.isArray(payload?.users) ? payload.users : [];
	          setAdminLiveUsers(users);
	        } catch (error: any) {
	          if (cancelled) break;
	          if (typeof error?.status === "number" && error.status === 404) {
	            adminLiveUsersLongPollDisabledRef.current = true;
	            startIntervalFallback();
	            return;
	          }
	          // eslint-disable-next-line no-await-in-loop
	          await sleep(1000);
	        }
	      }
	    };

	    void runLongPoll();

	    return () => {
	      cancelled = true;
	      if (intervalId) window.clearInterval(intervalId);
	      controller.abort();
	    };
	  }, [user?.role, user?.id]);

		  const formatOnlineDuration = (lastLoginAt?: string | null) => {
		    void userActivityNowTick;
		    if (!lastLoginAt) return "Online";
	    const startedAt = new Date(lastLoginAt).getTime();
	    if (!Number.isFinite(startedAt)) return "Online";
	    const elapsedMs = Math.max(0, Date.now() - startedAt);
		    const formatElapsed = (ms: number, maxParts = 2) => {
		      const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
		      if (totalSeconds < 60) return "<1m";
		      const units = [
		        { label: "y", seconds: 365 * 24 * 60 * 60 },
		        { label: "mo", seconds: 30 * 24 * 60 * 60 },
		        { label: "d", seconds: 24 * 60 * 60 },
		        { label: "h", seconds: 60 * 60 },
		        { label: "m", seconds: 60 },
		      ];
		      let remaining = totalSeconds;
		      const parts: string[] = [];
		      for (const unit of units) {
		        const qty = Math.floor(remaining / unit.seconds);
		        if (qty > 0) {
		          parts.push(`${qty}${unit.label}`);
		          remaining -= qty * unit.seconds;
		        }
		        if (parts.length >= maxParts) break;
		      }
		      return parts.length ? parts.join(" ") : "<1m";
		    };
		    return `Online for ${formatElapsed(elapsedMs)}`;
		  };

	    const formatRelativeMinutes = (value?: string | null) => {
	      if (!value) return "a few moments ago";
	      const date = new Date(value);
	      const target = date.getTime();
	      if (Number.isNaN(target)) return String(value);
	      const diffMs = Math.max(0, Date.now() - target);
	      if (diffMs < 90_000) return "a few moments ago";
	      const totalSeconds = Math.floor(diffMs / 1000);
	      const units = [
	        { label: "y", seconds: 365 * 24 * 60 * 60 },
	        { label: "mo", seconds: 30 * 24 * 60 * 60 },
	        { label: "d", seconds: 24 * 60 * 60 },
	        { label: "h", seconds: 60 * 60 },
	        { label: "m", seconds: 60 },
	      ];
	      let remaining = totalSeconds;
	      const parts: string[] = [];
	      for (const unit of units) {
	        const qty = Math.floor(remaining / unit.seconds);
	        if (qty > 0) {
	          parts.push(`${qty}${unit.label}`);
	          remaining -= qty * unit.seconds;
	        }
	        if (parts.length >= 2) break;
	      }
	      if (!parts.length) return "a few moments ago";
	      return `${parts.join(" ")} ago`;
	    };

		  const formatIdleMinutes = (entry: any) => {
		    void userActivityNowTick;
	    const rawMinutes =
	      typeof entry?.idleMinutes === "number" && Number.isFinite(entry.idleMinutes)
	        ? entry.idleMinutes
	        : null;
		    if (rawMinutes == null) {
		      const raw =
		        entry?.lastInteractionAt ||
		        entry?.lastSeenAt ||
		        entry?.lastLoginAt ||
		        null;
		      if (!raw) return null;
		      const parsed = new Date(raw).getTime();
		      if (!Number.isFinite(parsed)) return null;
		      const diffMs = Math.max(0, Date.now() - parsed);
		      const totalSeconds = Math.floor(diffMs / 1000);
		      if (totalSeconds < 60) return "<1m";
		      const units = [
		        { label: "y", seconds: 365 * 24 * 60 * 60 },
		        { label: "mo", seconds: 30 * 24 * 60 * 60 },
		        { label: "d", seconds: 24 * 60 * 60 },
		        { label: "h", seconds: 60 * 60 },
		        { label: "m", seconds: 60 },
		      ];
		      let remaining = totalSeconds;
		      const parts: string[] = [];
		      for (const unit of units) {
		        const qty = Math.floor(remaining / unit.seconds);
		        if (qty > 0) {
		          parts.push(`${qty}${unit.label}`);
		          remaining -= qty * unit.seconds;
		        }
		        if (parts.length >= 2) break;
		      }
		      return parts.length ? parts.join(" ") : "<1m";
		    }
		    const minutes = Math.max(0, Math.floor(rawMinutes));
		    if (minutes < 1) return "<1m";
		    const diffMs = minutes * 60_000;
		    const totalSeconds = Math.floor(diffMs / 1000);
		    const units = [
		      { label: "y", seconds: 365 * 24 * 60 * 60 },
		      { label: "mo", seconds: 30 * 24 * 60 * 60 },
		      { label: "d", seconds: 24 * 60 * 60 },
		      { label: "h", seconds: 60 * 60 },
		      { label: "m", seconds: 60 },
		    ];
		    let remaining = totalSeconds;
		    const parts: string[] = [];
		    for (const unit of units) {
		      const qty = Math.floor(remaining / unit.seconds);
		      if (qty > 0) {
		        parts.push(`${qty}${unit.label}`);
		        remaining -= qty * unit.seconds;
		      }
		      if (parts.length >= 2) break;
		    }
		    return parts.length ? parts.join(" ") : "<1m";
		  };

	  
	  useEffect(() => {
	    if (!user || !isAdmin(user.role) || postLoginHold) {
	      setServerHealthPayload(null);
	      setServerHealthLoading(false);
	      setServerHealthError(null);
	      return;
	    }
	    void fetchServerHealth();
	  }, [user?.id, user?.role, postLoginHold, fetchServerHealth]);

		  type MissingCertificateProduct = {
		    wooProductId: number | string;
		    name?: string | null;
		    sku?: string | null;
		  };
		  type CertificateProduct = MissingCertificateProduct & {
		    hasCertificate?: boolean;
		    filename?: string | null;
		    bytes?: number | null;
		    updatedAt?: string | null;
		  };
		  const [missingCertificates, setMissingCertificates] = useState<
		    MissingCertificateProduct[]
		  >([]);
		  const [missingCertificatesLoading, setMissingCertificatesLoading] =
		    useState(false);
		  const [missingCertificatesError, setMissingCertificatesError] = useState<
		    string | null
		  >(null);
		  const [certificateUploadsVisible, setCertificateUploadsVisible] =
		    useState(false);
		  const [certificateProducts, setCertificateProducts] = useState<
		    CertificateProduct[]
		  >([]);
		  const [certificateProductsLoading, setCertificateProductsLoading] =
		    useState(false);
		  const [certificateProductsError, setCertificateProductsError] = useState<
		    string | null
		  >(null);
		  const [missingCertificatesSelectedId, setMissingCertificatesSelectedId] =
		    useState<string>("");
	  const [missingCertificatesSelectedFile, setMissingCertificatesSelectedFile] =
	    useState<File | null>(null);
	  const [missingCertificatesUploading, setMissingCertificatesUploading] =
	    useState(false);
	  const [missingCertificatesInfoLoading, setMissingCertificatesInfoLoading] =
	    useState(false);
	  const [missingCertificatesInfoError, setMissingCertificatesInfoError] =
	    useState<string | null>(null);
	  const [missingCertificatesInfo, setMissingCertificatesInfo] = useState<{
	    exists: boolean;
	    filename: string | null;
	    mimeType: string | null;
	    bytes: number | null;
	    updatedAt: string | null;
	  } | null>(null);
		  const [missingCertificatesDeleting, setMissingCertificatesDeleting] =
		    useState(false);
		  const missingCertificatesInFlightRef = useRef(false);
		  const missingCertificatesLastFetchedAtRef = useRef<number>(0);
		  const certificateProductsInFlightRef = useRef(false);
		  const certificateProductsLastFetchedAtRef = useRef<number>(0);

	  const fetchMissingCertificates = useCallback(
		    async (options?: { force?: boolean }) => {
		      if (!user || !isAdmin(user.role) || postLoginHold) {
		        setMissingCertificates([]);
		        setMissingCertificatesLoading(false);
		        setMissingCertificatesError(null);
		        setCertificateUploadsVisible(false);
		        setCertificateProducts([]);
		        setCertificateProductsLoading(false);
		        setCertificateProductsError(null);
		        setMissingCertificatesSelectedId("");
		        setMissingCertificatesSelectedFile(null);
		        return;
		      }
	      const now = Date.now();
	      const ttlMs = 60_000;
	      if (!options?.force && now - missingCertificatesLastFetchedAtRef.current < ttlMs) {
	        return;
	      }
	      if (missingCertificatesInFlightRef.current) {
	        return;
	      }
	      missingCertificatesInFlightRef.current = true;
	      missingCertificatesLastFetchedAtRef.current = now;
	      setMissingCertificatesLoading(true);
	      setMissingCertificatesError(null);
	      try {
	        const payload = (await wooAPI.listMissingCertificates()) as any;
	        const products = Array.isArray(payload?.products)
	          ? (payload.products as MissingCertificateProduct[])
	          : [];
	        setMissingCertificates(products);
	        setMissingCertificatesSelectedFile(null);
	        const normalizedIds = new Set(products.map((p) => String(p.wooProductId)));
	        setMissingCertificatesSelectedId((prev) => {
	          if (prev && normalizedIds.has(prev)) return prev;
	          return products[0] ? String(products[0].wooProductId) : "";
	        });
	      } catch (error) {
	        setMissingCertificates([]);
	        setMissingCertificatesError(
	          error instanceof Error
	            ? error.message
	            : "Unable to load missing certificates.",
	        );
	      } finally {
	        setMissingCertificatesLoading(false);
	        missingCertificatesInFlightRef.current = false;
	      }
	    },
	    [user?.id, user?.role, postLoginHold],
	  );

		  useEffect(() => {
		    if (!user || !isAdmin(user.role) || postLoginHold) {
		      return;
		    }
		    void fetchMissingCertificates();
		  }, [user?.id, user?.role, postLoginHold, fetchMissingCertificates]);

		  useEffect(() => {
		    if (!user || !isAdmin(user.role) || postLoginHold) {
		      return;
		    }
		    if (missingCertificatesError || missingCertificates.length > 0) {
		      setCertificateUploadsVisible(true);
		    }
		  }, [
		    user?.id,
		    user?.role,
		    postLoginHold,
		    missingCertificatesError,
		    missingCertificates.length,
		  ]);

		  const fetchCertificateProducts = useCallback(
		    async (options?: { force?: boolean }) => {
		      if (!user || !isAdmin(user.role) || postLoginHold) {
		        setCertificateProducts([]);
		        setCertificateProductsLoading(false);
		        setCertificateProductsError(null);
		        return;
		      }
		      if (!certificateUploadsVisible) {
		        return;
		      }
		      const now = Date.now();
		      const ttlMs = 60_000;
		      if (
		        !options?.force &&
		        now - certificateProductsLastFetchedAtRef.current < ttlMs
		      ) {
		        return;
		      }
		      if (certificateProductsInFlightRef.current) {
		        return;
		      }
		      certificateProductsInFlightRef.current = true;
		      certificateProductsLastFetchedAtRef.current = now;
		      setCertificateProductsLoading(true);
		      setCertificateProductsError(null);
		      try {
		        const payload = (await wooAPI.listCertificateProducts()) as any;
		        const products = Array.isArray(payload?.products)
		          ? (payload.products as CertificateProduct[])
		          : [];
		        setCertificateProducts(products);
		        const normalizedIds = new Set(
		          products.map((p) => String(p.wooProductId)),
		        );
		        setMissingCertificatesSelectedId((prev) => {
		          if (prev && normalizedIds.has(prev)) return prev;
		          return products[0] ? String(products[0].wooProductId) : "";
		        });
		      } catch (error) {
		        setCertificateProducts([]);
		        setCertificateProductsError(
		          error instanceof Error ? error.message : "Unable to load products.",
		        );
		      } finally {
		        setCertificateProductsLoading(false);
		        certificateProductsInFlightRef.current = false;
		      }
		    },
		    [user?.id, user?.role, postLoginHold, certificateUploadsVisible],
		  );

		  useEffect(() => {
		    void fetchCertificateProducts();
		  }, [fetchCertificateProducts]);

		  const selectedCertificateInfoRequestIdRef = useRef(0);
		  const fetchSelectedCertificateInfo = useCallback(async () => {
	    if (!user || !isAdmin(user.role) || postLoginHold) {
	      setMissingCertificatesInfo(null);
	      setMissingCertificatesInfoLoading(false);
	      setMissingCertificatesInfoError(null);
	      return;
	    }
	    if (!missingCertificatesSelectedId) {
	      setMissingCertificatesInfo(null);
	      setMissingCertificatesInfoLoading(false);
	      setMissingCertificatesInfoError(null);
	      return;
	    }
	    const requestId = (selectedCertificateInfoRequestIdRef.current += 1);
	    setMissingCertificatesInfoLoading(true);
	    setMissingCertificatesInfoError(null);
	    try {
	      const payload = (await wooAPI.getCertificateOfAnalysisInfo(
	        missingCertificatesSelectedId,
	      )) as any;
	      if (requestId !== selectedCertificateInfoRequestIdRef.current) return;
	      setMissingCertificatesInfo({
	        exists: Boolean(payload?.exists),
	        filename:
	          typeof payload?.filename === "string" && payload.filename.trim().length > 0
	            ? payload.filename
	            : null,
	        mimeType:
	          typeof payload?.mimeType === "string" && payload.mimeType.trim().length > 0
	            ? payload.mimeType
	            : null,
	        bytes: typeof payload?.bytes === "number" ? payload.bytes : null,
	        updatedAt:
	          typeof payload?.updatedAt === "string" && payload.updatedAt.trim().length > 0
	            ? payload.updatedAt
	            : null,
	      });
	    } catch (error) {
	      if (requestId !== selectedCertificateInfoRequestIdRef.current) return;
	      setMissingCertificatesInfo(null);
	      setMissingCertificatesInfoError(
	        error instanceof Error
	          ? error.message
	          : "Unable to load current certificate.",
	      );
	    } finally {
	      if (requestId === selectedCertificateInfoRequestIdRef.current) {
	        setMissingCertificatesInfoLoading(false);
	      }
	    }
	  }, [user?.id, user?.role, postLoginHold, missingCertificatesSelectedId]);

	  useEffect(() => {
	    void fetchSelectedCertificateInfo();
	  }, [fetchSelectedCertificateInfo]);

		  const handleDeleteSelectedCertificate = useCallback(async () => {
		    if (!missingCertificatesSelectedId) {
		      toast.error("Select a product first.");
		      return;
		    }
		    setMissingCertificatesDeleting(true);
		    try {
		      const res = (await wooAPI.deleteCertificateOfAnalysis(
		        missingCertificatesSelectedId,
		      )) as any;
		      const didDelete = Boolean(res?.deleted);
		      toast.success(didDelete ? "Certificate deleted." : "No certificate to delete.");
		      setMissingCertificatesSelectedFile(null);
		      await fetchMissingCertificates({ force: true });
		      await fetchCertificateProducts({ force: true });
		    } catch (error) {
		      toast.error(
		        error instanceof Error ? error.message : "Unable to delete certificate.",
		      );
		    } finally {
		      setMissingCertificatesDeleting(false);
		    }
		  }, [
		    missingCertificatesSelectedId,
		    fetchMissingCertificates,
		    fetchCertificateProducts,
		  ]);

	  const handleUploadMissingCertificate = useCallback(async () => {
	    if (!missingCertificatesSelectedId) {
	      toast.error("Select a product first.");
	      return;
	    }
	    if (!missingCertificatesSelectedFile) {
	      toast.error("Choose a PNG file first.");
	      return;
	    }
	    const file = missingCertificatesSelectedFile;
	    const isPng =
	      file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
	    if (!isPng) {
	      toast.error("Certificate must be a PNG.");
	      return;
	    }
	    const maxBytes = 8 * 1024 * 1024;
	    if (file.size > maxBytes) {
	      toast.error("PNG is too large (max 8 MB).");
	      return;
	    }

		    setMissingCertificatesUploading(true);
		    try {
		      await wooAPI.uploadCertificateOfAnalysis(missingCertificatesSelectedId, {
		        file,
		        filename: file.name,
		      });
		      toast.success("Certificate uploaded.");
		      setMissingCertificatesSelectedFile(null);
		      await fetchMissingCertificates({ force: true });
		      await fetchCertificateProducts({ force: true });
		    } catch (error) {
          if ((error as any)?.status === 413) {
            toast.error("Upload rejected (413). Increase the API/proxy upload limit.");
          } else {
            toast.error(
              error instanceof Error ? error.message : "Unable to upload certificate.",
            );
          }
		    } finally {
		      setMissingCertificatesUploading(false);
		    }
		  }, [
		    missingCertificatesSelectedId,
		    missingCertificatesSelectedFile,
		    fetchMissingCertificates,
		    fetchCertificateProducts,
		  ]);
	  const referralRefreshInFlight = useRef(false);
	  const referralLastRefreshAtRef = useRef(0);
	  const [adminActionState, setAdminActionState] = useState<{
	    updatingReferral: string | null;
	    error: string | null;
  }>({
    updatingReferral: null,
    error: null,
  });
  const [creditingReferralId, setCreditingReferralId] = useState<string | null>(
    null,
  );
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const catalogProductsRef = useRef<Product[]>([]);
  const [catalogCategories, setCatalogCategories] = useState<string[]>([]);
  const [catalogTypes, setCatalogTypes] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRetryUntil, setCatalogRetryUntil] = useState<number | null>(null);
  const [catalogEmptyReady, setCatalogEmptyReady] = useState(false);
  const [catalogTransientIssue, setCatalogTransientIssue] = useState(false);
  const catalogFailureCountRef = useRef(0);
  const catalogEmptyResultRetryCountRef = useRef(0);
  const catalogEmptyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const catalogFetchInFlightRef = useRef(false);
  const backgroundVariantPrefetchTokenRef = useRef(0);
  const backgroundVariantPrefetchRunningRef = useRef(false);
  const backgroundVariantPrefetchSeedRef = useRef<string | null>(null);
  const leaderActivityLogRef = useRef<Map<string, number>>(new Map());

  const logLeaderActivity = useCallback(
    (leaderKey: string, label: string, intervalMs: number) => {
      const now = Date.now();
      const last = leaderActivityLogRef.current.get(leaderKey) ?? 0;
      if (now - last < 30_000) {
        return;
      }
      leaderActivityLogRef.current.set(leaderKey, now);
      console.debug("[Leader] Active", {
        leaderKey,
        label,
        intervalMs,
        tabId: getTabId(),
      });
    },
    [],
  );

  useEffect(() => {
    catalogProductsRef.current = catalogProducts;
  }, [catalogProducts]);

  useEffect(() => {
    if (!IMAGE_PREFETCH_ENABLED) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    if (!Array.isArray(catalogProducts) || catalogProducts.length === 0) {
      return;
    }
    if (!isPageVisible()) {
      return;
    }
    const leaderKey = "catalog-image-prefetch-seed";
    const leaderTtlMs = 20_000;
    if (!isTabLeader(leaderKey, leaderTtlMs)) {
      return;
    }

    for (const product of catalogProducts) {
      if (product.image) {
        enqueueImagePrefetch(product.image);
      }
      if (Array.isArray(product.images)) {
        for (const src of product.images) {
          if (src) enqueueImagePrefetch(src);
        }
      }
      if (Array.isArray(product.variants)) {
        for (const variant of product.variants) {
          if (variant?.image) {
            enqueueImagePrefetch(variant.image);
          }
        }
      }
    }

    runImagePrefetchQueue();
    return () => {
      releaseTabLeadership(leaderKey);
    };
  }, [catalogProducts, enqueueImagePrefetch, runImagePrefetchQueue]);

  useEffect(() => {
    if (!BACKGROUND_VARIANT_PREFETCH_ENABLED) {
      return;
    }
    if (!Array.isArray(catalogProducts) || catalogProducts.length === 0) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const leaderKey = "catalog-variant-prefetch-seed";
    const leaderTtlMs = 120_000;
    if (!isTabLeader(leaderKey, leaderTtlMs)) {
      return () => {
        releaseTabLeadership(leaderKey);
      };
    }

    const seed = catalogProducts.map((p) => p.id).join("|");
    if (backgroundVariantPrefetchSeedRef.current === seed) {
      releaseTabLeadership(leaderKey);
      return;
    }
    backgroundVariantPrefetchSeedRef.current = seed;

    backgroundVariantPrefetchTokenRef.current += 1;
    const token = backgroundVariantPrefetchTokenRef.current;
    backgroundVariantPrefetchRunningRef.current = true;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const run = async () => {
      await sleep(BACKGROUND_VARIANT_PREFETCH_START_DELAY_MS);
      if (backgroundVariantPrefetchTokenRef.current !== token) {
        return;
      }

      const candidates = catalogProducts.filter((product) => {
        const isVariable = (product.type ?? "").toLowerCase() === "variable";
        return isVariable && (!product.variants || product.variants.length === 0);
      });

      for (const product of candidates) {
        if (backgroundVariantPrefetchTokenRef.current !== token) {
          break;
        }
        try {
          // Load gently; don't block UI and don't spam Woo.
          // eslint-disable-next-line no-await-in-loop
          await ensureCatalogProductHasVariants(product);
        } catch {
          // ignore; on-demand selection can retry
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(BACKGROUND_VARIANT_PREFETCH_DELAY_MS);
      }
    };

    void run().finally(() => {
      if (backgroundVariantPrefetchTokenRef.current === token) {
        backgroundVariantPrefetchRunningRef.current = false;
      }
    });

    return () => {
      releaseTabLeadership(leaderKey);
      backgroundVariantPrefetchTokenRef.current += 1;
      backgroundVariantPrefetchRunningRef.current = false;
    };
  }, [catalogProducts, ensureCatalogProductHasVariants]);

  useEffect(() => {
    if (!BACKGROUND_VARIANT_PREFETCH_ENABLED) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const leaderKey = "catalog-variant-poll";
    const leaderTtlMs = Math.max(20_000, VARIANT_POLL_INTERVAL_MS * 2);
    const timer = window.setInterval(() => {
      if (!isPageVisible()) {
        return;
      }
      if (!isTabLeader(leaderKey, leaderTtlMs)) {
        return;
      }
      logLeaderActivity(leaderKey, "catalog-variant-poll", VARIANT_POLL_INTERVAL_MS);
      const products = catalogProductsRef.current;
      if (!Array.isArray(products) || products.length === 0) {
        return;
      }
      for (const product of products) {
        const isVariable = (product.type ?? "").toLowerCase() === "variable";
        if (!isVariable) continue;
        if (product.variants && product.variants.length > 0) continue;
        prefetchCatalogProductVariants(product);
      }
    }, VARIANT_POLL_INTERVAL_MS);
    return () => {
      releaseTabLeadership(leaderKey);
      window.clearInterval(timer);
    };
  }, [prefetchCatalogProductVariants]);

  useEffect(() => {
    if (!IMAGE_PREFETCH_ENABLED) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const leaderKey = "catalog-image-prefetch-queue";
    const leaderTtlMs = 10_000;
    const timer = window.setInterval(() => {
      if (!isPageVisible()) {
        return;
      }
      if (!isTabLeader(leaderKey, leaderTtlMs)) {
        return;
      }
      logLeaderActivity(leaderKey, "catalog-image-prefetch-queue", 1200);
      runImagePrefetchQueue();
    }, 1200);
    return () => {
      releaseTabLeadership(leaderKey);
      window.clearInterval(timer);
    };
  }, [runImagePrefetchQueue]);

  useEffect(() => {
    if (!IMAGE_PREFETCH_ENABLED) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const leaderKey = "catalog-image-loaded-check";
    const leaderTtlMs = 12_000;
    const timer = window.setInterval(() => {
      if (!isPageVisible()) {
        return;
      }
      if (!isTabLeader(leaderKey, leaderTtlMs)) {
        return;
      }
      logLeaderActivity(leaderKey, "catalog-image-loaded-check", 1750);
      setCatalogProducts((prev) => {
        if (!Array.isArray(prev) || prev.length === 0) {
          return prev;
        }
        let changed = false;
        const next = prev.map((product) => {
          if (product.image_loaded) {
            return product;
          }
          if (!product.image || product.image === WOO_PLACEHOLDER_IMAGE) {
            return product;
          }
          const state = imagePrefetchStateRef.current.get(product.image);
          if (state?.loaded) {
            changed = true;
            return { ...product, image_loaded: true };
          }
          return product;
        });
        return changed ? next : prev;
      });
    }, 1750);
    return () => {
      releaseTabLeadership(leaderKey);
      window.clearInterval(timer);
    };
  }, []);

  const refreshCatalogProductMedia = useCallback(
    async (product: Product, wooId: number) => {
      const isVariable = (product.type ?? "").toLowerCase() === "variable";
      if (isVariable) {
        await ensureCatalogProductHasVariants(product, { force: true });
        return;
      }
      const raw = await getProduct<WooProduct>(wooId, { force: true });
      if (!raw || typeof raw !== "object" || !("id" in raw)) {
        return;
      }
      const hydrated = hydrateWooProductCategoryNames(
        raw,
        wooCategoryNameByIdRef.current,
      );
      wooProductCacheRef.current.set(wooId, hydrated);
      const mapped = mapWooProductToProduct(hydrated, []);
      mapped.image_loaded =
        mapped.image !== WOO_PLACEHOLDER_IMAGE &&
        Boolean(imagePrefetchStateRef.current.get(mapped.image)?.loaded);
      setCatalogProducts((prev) =>
        prev.map((item) => (item.id === product.id ? mapped : item)),
      );
      setSelectedProduct((prev) => (prev?.id === product.id ? mapped : prev));
    },
    [ensureCatalogProductHasVariants],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const leaderKey = "catalog-media-repair";
    const leaderTtlMs = 25_000;
    const MAX_PER_TICK = 2;
    const timer = window.setInterval(() => {
      if (!isPageVisible()) return;
      if (!isTabLeader(leaderKey, leaderTtlMs)) return;
      logLeaderActivity(leaderKey, "catalog-media-repair", 6500);
      if (Date.now() < wooBackoffUntilRef.current) return;

      const now = Date.now();
      const products = catalogProductsRef.current;
      if (!Array.isArray(products) || products.length === 0) return;

      let started = 0;
      for (const product of products) {
        if (started >= MAX_PER_TICK) break;
        const wooId =
          typeof product.wooId === "number"
            ? product.wooId
            : Number.parseInt(String(product.id).replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(wooId)) continue;
        const numericWooId = Number(wooId);
        if (mediaRepairInFlightRef.current.has(numericWooId)) continue;
        const retry = mediaRepairRetryRef.current.get(numericWooId);
        if (retry && now < retry.nextAt) continue;

        const isVariable = (product.type ?? "").toLowerCase() === "variable";
        const hasVariantImages =
          Array.isArray(product.variants) &&
          product.variants.some(
            (variant) =>
              Boolean(variant?.image) && variant.image !== WOO_PLACEHOLDER_IMAGE,
          );
        const placeholderImage =
          !product.image || product.image === WOO_PLACEHOLDER_IMAGE;
        const needsVariants = isVariable && !hasVariantImages;

        let imageFailed = false;
        if (!product.image_loaded && product.image && product.image !== WOO_PLACEHOLDER_IMAGE) {
          const state = imagePrefetchStateRef.current.get(product.image);
          if (state && !state.loaded) {
            const ageMs = now - state.firstSeenAt;
            imageFailed = state.attempt >= 2 && ageMs > 25_000;
          }
        }

        const needsRepair = needsVariants || placeholderImage || imageFailed;
        if (!needsRepair) continue;

        mediaRepairInFlightRef.current.add(numericWooId);
        started += 1;
        void refreshCatalogProductMedia(product, numericWooId)
          .then(() => {
            const updated = catalogProductsRef.current.find(
              (p) => p.id === product.id,
            );
            const resolvedPlaceholder =
              updated?.image && updated.image !== WOO_PLACEHOLDER_IMAGE;
            if (resolvedPlaceholder || updated?.image_loaded) {
              mediaRepairRetryRef.current.delete(numericWooId);
            } else {
              const prev = mediaRepairRetryRef.current.get(numericWooId);
              const attempt = (prev?.attempt ?? 0) + 1;
              const delayMs = Math.min(10 * 60_000, 4000 * Math.pow(1.9, attempt - 1));
              mediaRepairRetryRef.current.set(numericWooId, {
                attempt,
                nextAt: Date.now() + delayMs,
              });
            }
          })
          .catch(() => {
            const prev = mediaRepairRetryRef.current.get(numericWooId);
            const attempt = (prev?.attempt ?? 0) + 1;
            const delayMs = Math.min(10 * 60_000, 4000 * Math.pow(1.9, attempt - 1));
            mediaRepairRetryRef.current.set(numericWooId, {
              attempt,
              nextAt: Date.now() + delayMs,
            });
          })
          .finally(() => {
            mediaRepairInFlightRef.current.delete(numericWooId);
          });
      }
    }, 6500);
    return () => {
      releaseTabLeadership(leaderKey);
      window.clearInterval(timer);
    };
  }, [refreshCatalogProductMedia]);
  const [peptideNews, setPeptideNews] = useState<PeptideNewsItem[]>([]);
  const [peptideNewsLoading, setPeptideNewsLoading] = useState(false);
  const [peptideNewsError, setPeptideNewsError] = useState<string | null>(null);
  const [peptideNewsUpdatedAt, setPeptideNewsUpdatedAt] = useState<Date | null>(
    null,
  );
  const newsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const beginNewsLoading = useCallback(() => {
    if (newsLoadingTimeoutRef.current) {
      clearTimeout(newsLoadingTimeoutRef.current);
      newsLoadingTimeoutRef.current = null;
    }
    setPeptideNewsLoading(true);
  }, []);
  const settleNewsLoading = useCallback((startedAt: number) => {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, MIN_NEWS_LOADING_MS - elapsed);
    if (newsLoadingTimeoutRef.current) {
      clearTimeout(newsLoadingTimeoutRef.current);
    }
    newsLoadingTimeoutRef.current = window.setTimeout(() => {
      setPeptideNewsLoading(false);
      newsLoadingTimeoutRef.current = null;
    }, remaining);
  }, []);
  const [isReferralSectionExpanded, setIsReferralSectionExpanded] =
    useState(false);
  const [quoteOfTheDay, setQuoteOfTheDay] = useState<{
    text: string;
    author: string;
  } | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const welcomeShownRef = useRef(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [referralSearchTerm, setReferralSearchTerm] = useState("");
  const [referralSortOrder, setReferralSortOrder] = useState<"desc" | "asc">(
    "desc",
  );
  const [isDesktopLandingLayout, setIsDesktopLandingLayout] = useState<boolean>(
    () => {
      if (typeof window === "undefined") return false;
      return window.innerWidth >= 1024;
    },
  );

  const isContactFormEntry = useCallback(
    (referral: ReferralRecord | null | undefined) => {
      if (!referral) {
        return false;
      }
      const status = (referral.status || "").toLowerCase();
      const id = String(referral.id || "");
      return status === "contact_form" || id.startsWith("contact_form:");
    },
    [],
  );

  const isManualEntry = useCallback((referral?: ReferralRecord | null) => {
    if (!referral) {
      return false;
    }
    const id = String(referral.id || "");
    return id.startsWith("manual:");
  }, []);

  const isLeadStatus = useCallback((status?: string | null) => {
    const normalized = (status || "").toLowerCase();
    if (!normalized) {
      return false;
    }
    return REFERRAL_LEAD_STATUS_KEYS.has(normalized);
  }, []);

  const filteredDoctorReferrals = useMemo(() => {
    const normalizedQuery = referralSearchTerm.trim().toLowerCase();
    const sorted = [...doctorReferrals].sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return referralSortOrder === "desc" ? bTime - aTime : aTime - bTime;
    });

    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter((referral) => {
      const haystack = [
        referral.referredContactName ?? "",
        referral.referredContactEmail ?? "",
        referral.referredContactPhone ?? "",
        referral.status ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [doctorReferrals, referralSearchTerm, referralSortOrder]);

  const salesRepStatusOptions = useMemo(() => {
    if (!salesRepDashboard) {
      return [] as string[];
    }
    if (
      Array.isArray(salesRepDashboard.statuses) &&
      salesRepDashboard.statuses.length > 0
    ) {
      return Array.from(
        new Set(
          salesRepDashboard.statuses.map((status) => (status || "").trim()),
        ),
      ).filter(Boolean);
    }
    return Array.from(
      new Set(
        normalizedReferrals
          .map((referral) => (referral.status || "").trim())
          .filter(Boolean),
      ),
    );
  }, [salesRepDashboard, normalizedReferrals]);

	  const leadStatusOptions = useMemo(() => {
	    const defaults = REFERRAL_STATUS_FLOW_SELECT.map((stage) => stage.key);
	    const dynamic = salesRepStatusOptions
	      .map((status) => status.toLowerCase())
	      .filter(
	        (status) => status !== "nuture" && (status === "pending" || isLeadStatus(status)),
	      );
	    return Array.from(new Set([...defaults, ...dynamic]));
	  }, [salesRepStatusOptions, isLeadStatus]);

	  const [accountProspectProspects, setAccountProspectProspects] = useState<
	    Record<string, any>
	  >({});
	  const accountProspectFetchInFlightRef = useRef<Set<string>>(new Set());

  const contactFormEntries = useMemo(() => {
    return normalizedReferrals.filter(isContactFormEntry);
  }, [normalizedReferrals, isContactFormEntry]);

  const contactFormQueue = useMemo(() => {
    return contactFormEntries.filter(
      (entry) => !isLeadStatus(entry.status) && !hasLeadPlacedOrder(entry),
    );
  }, [contactFormEntries, hasLeadPlacedOrder, isLeadStatus]);

	  const contactFormPipeline = useMemo(() => {
	    return contactFormEntries.filter((entry) => {
	      if (entry?.creditIssuedAt) {
	        return false;
	      }
	      if (!isLeadStatus(entry.status)) {
	        return false;
	      }
	      if (isCurrentUserLead(entry)) {
	        return false;
	      }
	      if (entry.referredContactEligibleForCredit === true) {
	        return false;
	      }
	      const status = sanitizeReferralStatus(entry.status);
	      const hasOrders = hasLeadPlacedOrder(entry);
	      if (hasOrders && status !== "converted") {
	        return false;
	      }
	      return true;
	    });
	  }, [contactFormEntries, hasLeadPlacedOrder, isCurrentUserLead, isLeadStatus]);

  const creditedDoctorLedgerEntries = useMemo(() => {
    const ledger = doctorSummary?.ledger ?? [];
    const map = new Map<string, CreditLedgerEntry>();
    ledger.forEach((entry) => {
      if (entry.direction === "credit" && entry.referralId) {
        map.set(entry.referralId, entry);
      }
    });
    return map;
  }, [doctorSummary]);

	  const referralRecords = useMemo(() => {
	    return normalizedReferrals.filter(
	      (referral) =>
	        !isContactFormEntry(referral) &&
	        !isManualEntry(referral) &&
	        (!hasLeadPlacedOrder(referral) ||
	          sanitizeReferralStatus(referral.status) === "converted"),
	    );
	  }, [hasLeadPlacedOrder, isContactFormEntry, isManualEntry, normalizedReferrals]);

  const manualProspectEntries = useMemo(() => {
    return normalizedReferrals.filter((referral) => isManualEntry(referral));
  }, [normalizedReferrals, isManualEntry]);

  const referralLeadEntries = useMemo(() => {
    return referralRecords.filter((referral) => isLeadStatus(referral.status));
  }, [referralRecords, isLeadStatus]);

	  const activeReferralEntries = useMemo(() => {
	    return referralLeadEntries.filter((referral) => {
	      const status = sanitizeReferralStatus(referral.status);
	      const hasOrders = hasLeadPlacedOrder(referral);
	      if (hasOrders && status !== "converted") {
	        return false;
	      }
	      if (isCurrentUserLead(referral)) {
	        return false;
	      }
	      return !referral.creditIssuedAt;
	    });
	  }, [hasLeadPlacedOrder, isCurrentUserLead, referralLeadEntries]);

	  const historicReferralEntries = useMemo(() => {
	    return referralLeadEntries.filter((referral) => {
	      return Boolean(referral.creditIssuedAt);
	    });
	  }, [referralLeadEntries]);

  const referralQueue = useMemo(() => {
    return referralRecords.filter((referral) => !isLeadStatus(referral.status));
  }, [referralRecords, isLeadStatus]);

	  const activeProspectFilterOptions = useMemo(() => {
	    const keys = new Set<string>();
	    contactFormPipeline.forEach((entry) => keys.add(sanitizeReferralStatus(entry.status)));
	    referralLeadEntries.forEach((entry) => keys.add(sanitizeReferralStatus(entry.status)));
	    manualProspectEntries.forEach((entry) => keys.add(sanitizeReferralStatus(entry.status)));
	    keys.delete("nuture");
	    return ["all", ...Array.from(keys)];
	  }, [contactFormPipeline, manualProspectEntries, referralLeadEntries]);

		  const [activeProspectFilter, setActiveProspectFilter] = useState<string>("all");
	  const activeProspectSortOrderRef = useRef<Map<string, number>>(new Map());
	  const activeProspectSortOrderCounterRef = useRef(0);

	  const accountProspectEntries = useMemo(() => {
	    const dashboardAny = salesRepDashboard as any;
	    const rawAccounts = [
      ...(Array.isArray(dashboardAny?.users) ? dashboardAny.users : []),
      ...(Array.isArray(dashboardAny?.accounts) ? dashboardAny.accounts : []),
      ...(Array.isArray(dashboardAny?.doctors) ? dashboardAny.doctors : []),
    ];
    if (rawAccounts.length === 0) return [];

    const existingKeys = new Set<string>();
    const addKey = (value?: string | null) => {
      if (!value) return;
      existingKeys.add(value.toLowerCase());
    };
    activeReferralEntries.forEach((ref) => {
      addKey(ref.referredContactEmail || undefined);
      addKey(ref.referredContactPhone ? `phone:${ref.referredContactPhone}` : undefined);
      addKey(ref.referredContactAccountId ? `acct:${ref.referredContactAccountId}` : undefined);
      addKey(ref.id ? `id:${ref.id}` : undefined);
    });
    contactFormPipeline.forEach((ref) => {
      addKey(ref.referredContactEmail || undefined);
      addKey(ref.referredContactPhone ? `phone:${ref.referredContactPhone}` : undefined);
      addKey(ref.id ? `id:${ref.id}` : undefined);
    });

    const nowIso = new Date().toISOString();
    const seenAccounts = new Map<string, any>();

    rawAccounts.forEach((acct: any) => {
      const id =
        acct.id ||
        acct.userId ||
        acct.doctorId ||
        acct.accountId ||
        acct.account_id ||
        acct.email ||
        acct.username ||
        acct.contactEmail ||
        Math.random().toString(16).slice(2);
      const key = String(id);
      if (!seenAccounts.has(key)) {
        seenAccounts.set(key, acct);
      }
    });

    const syntheticEntries = Array.from(seenAccounts.values())
      .map((acct: any, idx: number) => {
        const emailLower = (acct.email || acct.userEmail || acct.doctorEmail || acct.contactEmail || "").toLowerCase();
        if (emailLower && user?.email && emailLower === user.email.toLowerCase()) {
          return null;
        }
        const accountId =
          acct.id ||
          acct.userId ||
          acct.doctorId ||
          acct.accountId ||
          acct.account_id ||
          null;
        const ordersCount = coerceNumber(acct.totalOrders) ?? 0;
        if (ordersCount > 0) {
          return null;
        }

        const name = toTitleCase(
          acct.name ||
            [acct.firstName, acct.lastName].filter(Boolean).join(" ").trim() ||
            acct.doctorName ||
            acct.contactName ||
            acct.username ||
            acct.email ||
            "Account",
        );
        const email =
          acct.email ||
          acct.userEmail ||
          acct.doctorEmail ||
          acct.contactEmail ||
          null;
        const phone =
          acct.phone ||
          acct.phoneNumber ||
          acct.phone_number ||
          acct.contactPhone ||
          null;
	        const created =
	          acct.createdAt ||
	          acct.created_at ||
	          acct.dateCreated ||
          acct.date_created ||
          acct.updatedAt ||
          acct.updated_at ||
          nowIso;

        const dedupeKey =
          (email && email.toLowerCase()) ||
          (phone && `phone:${phone}`) ||
          (accountId && `acct:${accountId}`) ||
          `synthetic:${idx}`;
        if (existingKeys.has(dedupeKey.toLowerCase())) {
          return null;
        }

	        const hasOrdersByIdentity =
	          (email && orderIdentitySet.has(`email:${email.toLowerCase()}`)) ||
	          (accountId && orderIdentitySet.has(`id:${String(accountId)}`));
	        if (hasOrdersByIdentity) {
	          return null;
	        }

	        const doctorId = accountId ? String(accountId) : null;
	        const persistedProspect =
	          doctorId && Object.prototype.hasOwnProperty.call(accountProspectProspects, doctorId)
	            ? accountProspectProspects[doctorId]
	            : null;
	        const persistedStatus =
	          persistedProspect && typeof persistedProspect?.status === "string"
	            ? sanitizeReferralStatus(persistedProspect.status)
	            : null;

	        const record: ReferralRecord & { syntheticAccountProspect?: boolean } = {
	          id: `acct-prospect-${accountId || email || phone || idx}`,
	          referrerDoctorId: user?.id || user?.salesRepId || "rep",
	          salesRepId: user?.salesRepId || user?.id || null,
          referredContactName: name,
          referredContactEmail: email,
          referredContactPhone: phone,
          referralCodeId: null,
	          status: persistedStatus || "account_created",
	          createdAt: created,
	          updatedAt:
	            typeof persistedProspect?.updatedAt === "string" && persistedProspect.updatedAt
	              ? persistedProspect.updatedAt
	              : created,
	          convertedDoctorId: null,
	          convertedAt: null,
	          notes:
	            typeof persistedProspect?.notes === "string"
	              ? persistedProspect.notes
	              : acct.notes || null,
	          referrerDoctorName: null,
	          referrerDoctorEmail: null,
	          referrerDoctorPhone: null,
          creditIssuedAt: null,
          creditIssuedAmount: null,
          creditIssuedBy: null,
          referredContactHasAccount: true,
          referredContactAccountId: accountId ? String(accountId) : null,
          referredContactAccountName: name,
          referredContactAccountEmail: email,
          referredContactAccountCreatedAt: created,
          referredContactTotalOrders: acct.totalOrders || 0,
          referredContactEligibleForCredit: false,
          syntheticAccountProspect: true,
        };

	        return { kind: "referral" as const, record };
	      })
	      .filter(Boolean) as { kind: "referral"; record: ReferralRecord }[];

	    return syntheticEntries;
	  }, [
	    accountProspectProspects,
	    activeReferralEntries,
	    contactFormPipeline,
	    salesRepDashboard,
	    user?.id,
	    user?.salesRepId,
	  ]);

	  useEffect(() => {
	    if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
	      return;
	    }
	    const doctorIds = accountProspectEntries
	      .map((entry) => String((entry.record as any)?.referredContactAccountId || "").trim())
	      .filter(Boolean);
	    if (doctorIds.length === 0) {
	      return;
	    }
	    let canceled = false;
	    (async () => {
	      for (const doctorId of doctorIds) {
	        if (canceled) return;
	        if (Object.prototype.hasOwnProperty.call(accountProspectProspects, doctorId)) {
	          continue;
	        }
	        if (accountProspectFetchInFlightRef.current.has(doctorId)) {
	          continue;
	        }
	        accountProspectFetchInFlightRef.current.add(doctorId);
	        try {
	          const response = await referralAPI.getSalesProspect(doctorId);
	          const prospect = (response as any)?.prospect;
	          if (!canceled && prospect) {
	            setAccountProspectProspects((prev) => ({ ...prev, [doctorId]: prospect }));
	          }
	        } catch {
	          // ignore - prospects are optional for synthetic accounts
	        } finally {
	          accountProspectFetchInFlightRef.current.delete(doctorId);
	        }
	      }
	    })();
	    return () => {
	      canceled = true;
	    };
	  }, [accountProspectEntries, accountProspectProspects, user]);

  const combinedLeadEntries = useMemo(
    () =>
      [
        ...activeReferralEntries.map((record) => ({
          kind: "referral" as const,
          record,
        })),
        ...contactFormPipeline.map((record) => ({
          kind: "contact_form" as const,
          record,
        })),
        ...accountProspectEntries,
      ].sort((a, b) => {
        const aTime = a.record.updatedAt
          ? new Date(a.record.updatedAt).getTime()
          : a.record.createdAt
            ? new Date(a.record.createdAt).getTime()
            : 0;
        const bTime = b.record.updatedAt
          ? new Date(b.record.updatedAt).getTime()
          : b.record.createdAt
            ? new Date(b.record.createdAt).getTime()
            : 0;
        return bTime - aTime;
      }),
    [activeReferralEntries, contactFormPipeline, accountProspectEntries],
  );

  const historicProspectEntries = useMemo(() => {
    const referralHistoric = historicReferralEntries
      .map((record) => ({ kind: "referral" as const, record }))
      .sort((a, b) => {
        const aTime = a.record.creditIssuedAt
          ? new Date(a.record.creditIssuedAt).getTime()
          : a.record.updatedAt
            ? new Date(a.record.updatedAt).getTime()
            : 0;
        const bTime = b.record.creditIssuedAt
          ? new Date(b.record.creditIssuedAt).getTime()
          : b.record.updatedAt
            ? new Date(b.record.updatedAt).getTime()
            : 0;
        return bTime - aTime;
      });
    const contactHistoric = contactFormEntries
      .filter(
        (entry) =>
          (entry.status || "").toLowerCase() === "converted" &&
          (entry.referredContactEligibleForCredit === true ||
            hasLeadPlacedOrder(entry)),
      )
      .map((record) => ({ kind: "contact_form" as const, record }))
      .sort((a, b) => {
        const aTime = a.record.updatedAt
          ? new Date(a.record.updatedAt).getTime()
          : a.record.createdAt
            ? new Date(a.record.createdAt).getTime()
            : 0;
        const bTime = b.record.updatedAt
          ? new Date(b.record.updatedAt).getTime()
          : b.record.createdAt
            ? new Date(b.record.createdAt).getTime()
            : 0;
        return bTime - aTime;
      });
    return [...referralHistoric, ...contactHistoric].sort(
      (a, b) =>
        (b.record.creditIssuedAt
          ? new Date(b.record.creditIssuedAt).getTime()
          : b.record.updatedAt
            ? new Date(b.record.updatedAt).getTime()
            : b.record.createdAt
              ? new Date(b.record.createdAt).getTime()
              : 0) -
        (a.record.creditIssuedAt
          ? new Date(a.record.creditIssuedAt).getTime()
          : a.record.updatedAt
            ? new Date(a.record.updatedAt).getTime()
            : a.record.createdAt
              ? new Date(a.record.createdAt).getTime()
              : 0),
    );
  }, [contactFormEntries, hasLeadPlacedOrder, historicReferralEntries]);

			  const activeProspectEntries = useMemo(() => {
		    const getActiveProspectKey = (
		      entry: { kind: "referral" | "contact_form"; record: any },
		      index: number,
		    ) => {
		      const record = entry.record ?? {};
		      const id =
		        record.id ??
		        record.referralId ??
		        record.leadId ??
		        record.prospectId ??
		        null;
		      if (id) {
		        return `${entry.kind}:${String(id)}`;
		      }
		      const accountId =
		        record.referredContactAccountId ??
		        record.accountId ??
		        record.userId ??
		        record.doctorId ??
		        null;
		      const email =
		        record.referredContactEmail ?? record.email ?? record.userEmail ?? null;
		      const phone =
		        record.referredContactPhone ?? record.phone ?? record.phoneNumber ?? null;
		      const name =
		        record.referredContactName ?? record.name ?? record.doctorName ?? null;
		      const createdAt =
		        record.createdAt ??
		        record.created_at ??
		        record.dateCreated ??
		        record.date_created ??
		        null;
		      const composite = [accountId, email, phone, name, createdAt]
		        .filter(Boolean)
		        .join("|");
		      if (composite) {
		        return `${entry.kind}:${composite}`.toLowerCase();
		      }
		      return `${entry.kind}:idx:${index}`;
		    };

			    const combined = [
			      ...manualProspectEntries.map((record) => ({
			        kind: "referral" as const,
			        record,
			      })),
      ...activeReferralEntries.map((record) => ({
        kind: "referral" as const,
        record,
      })),
      ...contactFormPipeline.map((record) => ({
        kind: "contact_form" as const,
        record,
      })),
		      ...accountProspectEntries,
		    ];

				    const filtered = combined.filter(
				      (entry) => !shouldRemoveFromActiveProspects(entry.record),
				    );

		    const dedup = new Map<string, { kind: "referral" | "contact_form"; record: any }>();
		    filtered.forEach((entry, index) => {
		      const key = getActiveProspectKey(entry, index);
		      if (!dedup.has(key)) {
		        dedup.set(key, entry);
		      }
		    });

		    const stableOrder = activeProspectSortOrderRef.current;
		    let nextCounter = activeProspectSortOrderCounterRef.current;
		    Array.from(dedup.keys()).forEach((key) => {
		      if (!stableOrder.has(key)) {
		        stableOrder.set(key, nextCounter);
		        nextCounter += 1;
		      }
		    });
		    activeProspectSortOrderCounterRef.current = nextCounter;
	
	    const statusRank = new Map<string, number>([
	      ["nuture", 0],
	      ["converted", 1],
	      ["account_created", 2],
	      ["verified", 3],
	      ["verifying", 3],
	      ["contacted", 4],
	      ["contact_form", 5],
	      ["pending", 6],
	    ]);

	    const sortable = Array.from(dedup.entries()).map(([key, entry]) => ({
	      ...entry,
	      _sortKey: key,
	    }));
	    return sortable.sort((a, b) => {
	      const aStatus = sanitizeReferralStatus(a.record?.status);
	      const bStatus = sanitizeReferralStatus(b.record?.status);
	      const aRank = statusRank.get(aStatus) ?? Number.MAX_SAFE_INTEGER;
	      const bRank = statusRank.get(bStatus) ?? Number.MAX_SAFE_INTEGER;
	      if (aRank !== bRank) return aRank - bRank;

	      const aOrder =
	        stableOrder.get((a as any)._sortKey) ?? Number.MAX_SAFE_INTEGER;
	      const bOrder =
	        stableOrder.get((b as any)._sortKey) ?? Number.MAX_SAFE_INTEGER;
	      if (aOrder !== bOrder) return aOrder - bOrder;

	      const aId = a.record?.id ? String(a.record.id) : "";
	      const bId = b.record?.id ? String(b.record.id) : "";
	      return aId.localeCompare(bId);
	    });
			  }, [
			    accountProspectEntries,
			    activeReferralEntries,
			    contactFormPipeline,
		    manualProspectEntries,
		    hasLeadPlacedOrder,
		    shouldRemoveFromActiveProspects,
		  ]);

  const filteredActiveProspects = useMemo(() => {
    if (activeProspectFilter === "all") {
      return activeProspectEntries;
    }
    const key = activeProspectFilter.toLowerCase();
    return activeProspectEntries.filter(
      ({ record }) => sanitizeReferralStatus(record.status) === key,
    );
  }, [activeProspectEntries, activeProspectFilter]);

  const filteredSalesRepReferrals = useMemo(() => {
    return referralRecords.filter(
      (referral) => sanitizeReferralStatus(referral.status) === "pending",
    );
  }, [referralRecords]);

  // Default referrals collapsed; recollapse new items when list changes
  useEffect(() => {
    const next = new Set<string>();
    filteredSalesRepReferrals.forEach((ref) => {
      if (ref.id) {
        next.add(String(ref.id));
      }
    });
    setCollapsedReferralIds(next);
  }, [filteredSalesRepReferrals]);

		  const salesRepChartData = useMemo(() => {
		    const statusRank = new Map<string, number>();
		    SALES_REP_PIPELINE.forEach((stage, index) => {
		      stage.statuses.forEach((statusKey) => statusRank.set(statusKey, index));
		    });

        const chartReferrals: any[] = [
          ...normalizedReferrals,
          ...accountProspectEntries.map((entry) => entry.record),
        ];

			    const identityKeyForReferral = (referral: any, index: number): string => {
		      const accountId =
		        referral?.referredContactAccountId ||
		        referral?.convertedDoctorId ||
		        referral?.referredContactId ||
		        referral?.userId ||
		        referral?.doctorId ||
		        null;
		      if (accountId) {
		        return `acct:${String(accountId)}`;
		      }
		      const email =
		        typeof referral?.referredContactEmail === "string"
		          ? referral.referredContactEmail.trim().toLowerCase()
		          : "";
		      if (email) {
		        return `email:${email}`;
		      }
		      const phone =
		        typeof referral?.referredContactPhone === "string"
		          ? referral.referredContactPhone.trim()
		          : "";
		      if (phone) {
		        return `phone:${phone}`;
		      }
		      if (referral?.id != null) {
		        return `id:${String(referral.id)}`;
		      }
			      return `idx:${index}`;
			    };

			    const pipelineNameForReferral = (referral: any): string => {
			      const name =
			        referral?.referredContactName ||
			        referral?.referredContactEmail ||
			        referral?.referredContactPhone ||
			        referral?.referrerDoctorName ||
			        "Prospect";
			      return String(name).trim() || "Prospect";
			    };

			    const bestByIdentity = new Map<string, { status: string; name: string }>();
				    chartReferrals.forEach((referral, index) => {
				      const normalizedStatus = sanitizeReferralStatus(referral.status);
				      const status =
				        hasLeadPlacedOrder(referral) && normalizedStatus !== "converted"
				          ? "nuture"
				          : normalizedStatus;
				      const key = identityKeyForReferral(referral, index);
				      const name = pipelineNameForReferral(referral);
				      const existing = bestByIdentity.get(key);
				      if (!existing) {
			        bestByIdentity.set(key, { status, name });
			        return;
			      }
			      const nextRank = statusRank.get(status) ?? -1;
			      const prevRank = statusRank.get(existing.status) ?? -1;
			      if (nextRank > prevRank) {
			        bestByIdentity.set(key, { status, name });
			      }
			    });

			    const counts: Record<string, number> = {};
			    const namesByStatus: Record<string, Set<string>> = {};
			    bestByIdentity.forEach(({ status, name }) => {
			      counts[status] = (counts[status] || 0) + 1;
			      if (!namesByStatus[status]) {
			        namesByStatus[status] = new Set();
			      }
			      if (name) {
			        namesByStatus[status].add(name);
			      }
			    });

		    return SALES_REP_PIPELINE.map((stage) => ({
		      status: stage.key,
		      label: stage.label,
	      count: stage.statuses.reduce(
	        (total, statusKey) => total + (counts[statusKey] || 0),
	        0,
	      ),
		      names: (() => {
		        const nameSet = new Set<string>();
		        stage.statuses.forEach((statusKey) => {
		          const names = namesByStatus[statusKey];
		          if (!names) return;
		          names.forEach((value) => nameSet.add(value));
		        });
		        return Array.from(nameSet).sort((a, b) => a.localeCompare(b));
		      })(),
	    }));
		  }, [accountProspectEntries, hasLeadPlacedOrder, normalizedReferrals]);

  const handleReferralSortToggle = useCallback(() => {
    setReferralSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
  }, []);

  const renderContactFormStatusTracker = useCallback((status?: string) => {
    const normalizedStatus = (status || "contact_form").toLowerCase();
    const currentIndex = Math.max(
      0,
      CONTACT_FORM_STATUS_FLOW.findIndex(
        (stage) => stage.key === normalizedStatus,
      ),
    );

    return (
      <div className="flex flex-col gap-1 text-xs">
        {CONTACT_FORM_STATUS_FLOW.map((stage, index) => {
          const reached = index <= currentIndex;
          return (
            <div key={stage.key} className="flex items-center gap-2">
              <div
                className={`h-2.5 w-2.5 rounded-full ${reached ? "bg-emerald-500" : "bg-slate-300"}`}
              />
              <span
                className={
                  reached ? "text-emerald-600 font-semibold" : "text-slate-500"
                }
              >
                {stage.label}
              </span>
            </div>
          );
        })}
      </div>
    );
  }, []);

  const sortDirectionLabel =
    referralSortOrder === "desc" ? "Newest first" : "Oldest first";

  const salesRepDoctorsById = useMemo(() => {
    const lookup = new Map<string, string>();
    const referrals = salesRepDashboard?.referrals ?? [];
    for (const referral of referrals) {
      if (referral.referrerDoctorId) {
        lookup.set(
          referral.referrerDoctorId,
          referral.referrerDoctorName || "Doctor",
        );
      }
      if (referral.convertedDoctorId) {
        const convertedName =
          referral.referrerDoctorName ??
          referral.referredContactName ??
          "Converted doctor";
        lookup.set(referral.convertedDoctorId, convertedName);
      }
    }
    return lookup;
  }, [salesRepDashboard]);

  const salesRepDoctorIds = useMemo(
    () => new Set<string>(salesRepDoctorsById.keys()),
    [salesRepDoctorsById],
  );

  const fetchSalesTrackingOrders = useCallback(async (options?: { force?: boolean }) => {
    const role = userRole;
    const salesRepId = userSalesRepId || userId;
    const salesRepIdParam = isAdmin(role) ? undefined : salesRepId;
    const currentUserId = userId != null ? String(userId).trim() : "";
    const currentUserEmail =
      typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
    if (!role || (!isRep(role) && !isAdmin(role))) {
      setSalesTrackingOrders([]);
      setSalesTrackingDoctors(new Map());
      setSalesRepSalesSummary([]);
      setSalesTrackingError(null);
      setSalesRepSalesSummaryError(null);
      setSalesTrackingLoading(false);
      setSalesTrackingRefreshing(false);
      return;
    }
    if (postLoginHold) {
      return;
    }

    const now = Date.now();
    const cacheTtlMs = 25_000;
    const fetchKey = `${String(role || "").toLowerCase()}:${String(salesRepIdParam || "")}`;
    const isKeyChanged = salesTrackingFetchKeyRef.current !== fetchKey;
    const hasExistingOrders = salesTrackingOrdersRef.current.length > 0;
    if (isKeyChanged) {
      salesTrackingFetchKeyRef.current = fetchKey;
      salesTrackingLastFetchAtRef.current = 0;
    }

    const shouldForce = options?.force === true || isKeyChanged;
    const elapsedMs = now - salesTrackingLastFetchAtRef.current;
    if (!shouldForce && elapsedMs > 0 && elapsedMs < cacheTtlMs) {
      return;
    }
    if (salesTrackingInFlightRef.current) {
      return;
    }
    salesTrackingInFlightRef.current = true;
    salesTrackingLastFetchAtRef.current = now;

    const shouldShowInitialLoading = !hasExistingOrders || isKeyChanged;
    setSalesTrackingLoading(shouldShowInitialLoading);
    setSalesTrackingRefreshing(options?.force === true && !shouldShowInitialLoading);
    setSalesTrackingError(null);
    setSalesRepSalesSummaryError(null);

    try {
      console.log("[Sales Tracking] Fetch start", {
        role: role || null,
        salesRepId: salesRepId || null,
      });
      let orders: AccountOrderSummary[] = [];
	      const doctorLookup = new Map<
	        string,
	        {
	          name: string;
	          email?: string | null;
	          profileImageUrl?: string | null;
	          phone?: string | null;
	          salesRepId?: string | null;
	          salesRepName?: string | null;
	          salesRepEmail?: string | null;
	          leadType?: string | null;
	          leadTypeSource?: string | null;
	          leadTypeLockedAt?: string | null;
	          address1?: string | null;
          address2?: string | null;
          city?: string | null;
          state?: string | null;
          postalCode?: string | null;
          country?: string | null;
        }
      >();

      const response = await ordersAPI.getForSalesRep({
        salesRepId: salesRepIdParam || undefined,
        scope: isAdmin(role) ? "all" : "mine",
      });
      if (
        response &&
        typeof response === "object" &&
        !Array.isArray(response)
      ) {
        const respObj = response as any;
        if (Array.isArray(respObj.orders)) {
          orders = respObj.orders as AccountOrderSummary[];
        }
        const doctors = Array.isArray(respObj.doctors)
          ? respObj.doctors
          : Array.isArray(respObj.users)
            ? respObj.users
            : [];
	        doctors.forEach((doc: any) => {
	          const id = doc.id || doc.doctorId || doc.userId || doc.accountId || doc.account_id;
	          if (!id) return;
	          doctorLookup.set(String(id), {
	            name:
	              doc.name ||
	              [doc.firstName, doc.lastName].filter(Boolean).join(" ").trim() ||
	              doc.email ||
	              "Doctor",
	            email: doc.email || doc.doctorEmail || doc.userEmail || null,
	            profileImageUrl:
	              doc.profileImageUrl || doc.profile_image_url || null,
	            phone:
	              doc.phone ||
	              doc.phoneNumber ||
	              doc.phone_number ||
	              doc.contactPhone ||
	              null,
	            salesRepId:
	              doc.salesRepId ||
	              doc.sales_rep_id ||
	              doc.doctorSalesRepId ||
	              doc.doctor_sales_rep_id ||
	              null,
	            salesRepName:
	              doc.salesRepName ||
	              doc.sales_rep_name ||
	              doc.doctorSalesRepName ||
	              doc.doctor_sales_rep_name ||
	              null,
	            salesRepEmail:
	              doc.salesRepEmail ||
	              doc.sales_rep_email ||
	              doc.doctorSalesRepEmail ||
	              doc.doctor_sales_rep_email ||
	              null,
	            leadType: doc.leadType || doc.lead_type || null,
	            leadTypeSource: doc.leadTypeSource || doc.lead_type_source || null,
	            leadTypeLockedAt: doc.leadTypeLockedAt || doc.lead_type_locked_at || null,
	            address1: doc.address1 || doc.address_1 || null,
            address2: doc.address2 || doc.address_2 || null,
            city: doc.city || null,
            state: doc.state || null,
            postalCode: doc.postalCode || doc.postcode || doc.zip || null,
            country: doc.country || null,
          });
        });
      } else if (Array.isArray(response)) {
        orders = response as AccountOrderSummary[];
      }

      // Normalize orders using the same logic as the doctor's orders tab so dates and shipping ETAs are consistent
      const originalByKey = new Map<string, any>();
      const orderKey = (order: any, idx: number) =>
        String(
          order.id ||
            order.wooOrderId ||
            order.number ||
            order.cancellationId ||
            order.wooOrderNumber ||
            `idx-${idx}`,
        );
      orders.forEach((order: any, idx: number) => {
        const key = orderKey(order, idx);
        originalByKey.set(key, order);
      });
      const normalizeDateField = (value: any): string | null => {
        if (typeof value === "string" && value.trim().length > 0) {
          const d = new Date(value);
          return Number.isNaN(d.getTime()) ? null : d.toISOString();
        }
        if (value instanceof Date) {
          return Number.isNaN(value.getTime()) ? null : value.toISOString();
        }
        return null;
      };

      // Normalize using Woo order summaries only (same shape doctor tab uses)
      const existingByKey = new Map<string, AccountOrderSummary>();
      const addExistingKeys = (order: AccountOrderSummary, idx = 0) => {
        const keys = [
          order.id,
          (order as any).wooOrderId,
          (order as any).woo_order_id,
          order.number,
          (order as any).wooOrderNumber,
          (order as any).cancellationId,
          (order as any).cancellation_id,
          `idx-${idx}`,
        ]
          .filter(Boolean)
          .map((k) => String(k));
        keys.forEach((k) => existingByKey.set(k, order));
      };
      salesTrackingOrdersRef.current.forEach((o, idx) => addExistingKeys(o, idx));

      const normalizedOrders = normalizeAccountOrdersResponse(
        { woo: orders },
        { includeCanceled: true },
      )
        .map((order, idx) => {
          const key = orderKey(order, idx);
          const original = originalByKey.get(key) || {};
          const doctorId =
            resolveOrderDoctorId(original as any) ||
            resolveOrderDoctorId(order) ||
            (original as any).doctor_id ||
            (original as any).doctorId ||
            (order as any).doctor_id ||
            (order as any).doctorId ||
            null;
          const doctorInfo = doctorId ? doctorLookup.get(doctorId) : null;
          const createdAt =
            normalizeDateField(order.createdAt) ||
            normalizeDateField((order as any).dateCreated) ||
            normalizeDateField((order as any).date_created) ||
            normalizeDateField((order as any).dateCreatedGmt) ||
            normalizeDateField((order as any).date_created_gmt) ||
            null;
          const updatedAt =
            normalizeDateField(order.updatedAt) ||
            normalizeDateField((order as any).dateModified) ||
            normalizeDateField((order as any).date_modified) ||
            normalizeDateField((order as any).dateModifiedGmt) ||
            normalizeDateField((order as any).date_modified_gmt) ||
            createdAt;
          const estimatedArrival =
            normalizeDateField(order?.shippingEstimate?.estimatedArrivalDate) ||
            normalizeDateField(
              (order as any)?.shippingEstimate?.deliveryDateGuaranteed,
            ) ||
            normalizeDateField(
              (order as any)?.shippingEstimate?.estimated_delivery_date,
            ) ||
            normalizeDateField((order as any)?.shipping?.estimatedArrivalDate) ||
            normalizeDateField(
              (order as any)?.shipping?.estimated_delivery_date,
            ) ||
            null;
          const rawShippingEstimate =
            order.shippingEstimate || (order as any).shippingEstimate || null;
          const shippingEstimateBase =
            rawShippingEstimate && typeof rawShippingEstimate === "object"
              ? { ...(rawShippingEstimate as any) }
              : {};
          const normalizedShippingEstimate = {
            ...shippingEstimateBase,
            estimatedArrivalDate: estimatedArrival,
          };
          const hasShippingEstimateData =
            Boolean(estimatedArrival) ||
            Object.values(normalizedShippingEstimate).some(
              (value) => value !== null && value !== undefined && String(value).length > 0,
            );
          const shippingEstimate = hasShippingEstimateData
            ? normalizedShippingEstimate
            : null;
          const coerceShippingEstimate = (value: any) => {
            if (!value || typeof value !== "object") return null;
            const values = Object.values(value as any);
            const hasData = values.some(
              (v) => v !== null && v !== undefined && String(v).length > 0,
            );
            return hasData ? value : null;
          };

          const existing = existingByKey.get(key);
          const merged =
            existing && existing !== order
              ? {
                  ...existing,
                  ...order,
                  shippingEstimate:
                    shippingEstimate ?? (existing as any).shippingEstimate ?? null,
                  createdAt: createdAt || (existing as any).createdAt || null,
                  updatedAt: updatedAt || (existing as any).updatedAt || null,
                  lineItems:
                    (order as any).lineItems?.length
                      ? (order as any).lineItems
                      : (existing as any).lineItems,
                }
              : order;

          return {
            ...merged,
            createdAt: merged.createdAt || createdAt,
            updatedAt: merged.updatedAt || updatedAt,
            shippingEstimate:
              coerceShippingEstimate((merged as any).shippingEstimate) ??
              shippingEstimate ??
              null,
            doctorId,
            doctorEmail:
              doctorInfo?.email ||
              (original as any)?.doctorEmail ||
              (original as any)?.doctor_email ||
              (order as any)?.doctorEmail ||
              (order as any)?.doctor_email ||
              (order as any)?.billing?.email ||
              (order as any)?.billing_email ||
              null,
            doctorName:
              doctorInfo?.name ||
              (original as any)?.doctorName ||
              (original as any)?.billing_name ||
              (order as any)?.doctorName ||
              (order as any)?.billing?.firstName ||
              (order as any)?.billing?.first_name ||
              (order as any)?.billing_name ||
              (order as any)?.billing?.lastName ||
              (order as any)?.billing?.last_name ||
              "Doctor",
            doctorProfileImageUrl:
              doctorInfo?.profileImageUrl ||
              (original as any)?.doctorProfileImageUrl ||
              (order as any)?.doctorProfileImageUrl ||
              null,
          };
        })
        .filter((order) => {
          if (!currentUserId && !currentUserEmail) return true;
          const candidateId =
            resolveOrderDoctorId(order) ||
            (order as any)?.doctorId ||
            (order as any)?.doctor_id ||
            (order as any)?.userId ||
            (order as any)?.user_id ||
            null;
          if (
            currentUserId &&
            candidateId != null &&
            String(candidateId).trim() === currentUserId
          ) {
            return false;
          }
          if (currentUserEmail) {
            const candidateEmails = [
              (order as any)?.userEmail,
              (order as any)?.user_email,
              (order as any)?.doctorEmail,
              (order as any)?.doctor_email,
              (order as any)?.email,
              (order as any)?.billing?.email,
              (order as any)?.billing_email,
            ]
              .filter((value) => typeof value === "string")
              .map((value) => String(value).trim().toLowerCase())
              .filter(Boolean);
            if (candidateEmails.includes(currentUserEmail)) {
              return false;
            }
          }
          return true;
        })
        .sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bTime - aTime;
        });

      const buildSignature = (order: AccountOrderSummary) => {
        const key = String(order.id || order.number || "");
        const createdAt =
          order.createdAt ||
          (order as any).dateCreated ||
          (order as any).date_created ||
          (order as any).date_created_gmt ||
          "";
        const updatedAt = order.updatedAt || (order as any).dateModified || "";
        const eta =
          order?.shippingEstimate?.estimatedArrivalDate ||
          (order as any)?.shippingEstimate?.deliveryDateGuaranteed ||
          (order as any)?.shippingEstimate?.estimated_delivery_date ||
          "";
        const shipStatus =
          (order as any)?.shippingEstimate?.status ||
          (order as any)?.shipping?.status ||
          "";
        return [
          key,
          String(order.number || ""),
          String(order.status || ""),
          String(order.total || ""),
          String(createdAt || ""),
          String(updatedAt || ""),
          String(eta || ""),
          String(shipStatus || ""),
        ].join("|");
      };

      const prevSig = salesTrackingOrderSignatureRef.current;
      const nextSig = new Map<string, string>();
      const changedIds = new Set<string>();
      for (const order of normalizedOrders) {
        const key = String(order.id || order.number || "");
        if (!key) continue;
        const sig = buildSignature(order);
        nextSig.set(key, sig);
        if (prevSig.get(key) !== sig) {
          changedIds.add(key);
        }
      }
      if (prevSig.size !== nextSig.size) {
        // Handle removals without needing per-id diff.
        changedIds.add("__list_changed__");
      }
      salesTrackingOrderSignatureRef.current = nextSig;

      const shouldUpdateOrders =
        shouldShowInitialLoading ||
        changedIds.size > 0 ||
        salesTrackingOrdersRef.current.length !== normalizedOrders.length;

      setSalesTrackingDoctors(doctorLookup);
      if (shouldUpdateOrders) {
        setSalesTrackingOrders(normalizedOrders);
      }

      if (!shouldShowInitialLoading && changedIds.size > 0) {
        const idsToShimmer = new Set(
          [...changedIds].filter((id) => id !== "__list_changed__"),
        );
        if (idsToShimmer.size > 0) {
          setSalesOrderRefreshingIds(idsToShimmer);
          if (salesOrderRefreshingClearHandleRef.current) {
            window.clearTimeout(salesOrderRefreshingClearHandleRef.current);
          }
          salesOrderRefreshingClearHandleRef.current = window.setTimeout(() => {
            setSalesOrderRefreshingIds(new Set());
            salesOrderRefreshingClearHandleRef.current = null;
          }, 650);
        }
      }

      const newlySeenDoctorIds: string[] = [];
      normalizedOrders.forEach((order) => {
        const docId = resolveOrderDoctorId(order) || order.userId || order.id;
        if (!docId) return;
        const idStr = String(docId);
        if (!knownSalesDoctorIdsRef.current.has(idStr)) {
          knownSalesDoctorIdsRef.current.add(idStr);
          newlySeenDoctorIds.push(idStr);
        }
      });

      if (!hasInitializedSalesCollapseRef.current) {
        const collapsedIds = new Set<string>();
        knownSalesDoctorIdsRef.current.forEach((id) => collapsedIds.add(id));
        setCollapsedSalesDoctorIds(collapsedIds);
        hasInitializedSalesCollapseRef.current = true;
      } else if (newlySeenDoctorIds.length > 0) {
        const next = new Set(collapsedSalesDoctorIds);
        newlySeenDoctorIds.forEach((id) => next.add(id));
        setCollapsedSalesDoctorIds(next);
      }
      if (shouldUpdateOrders) {
        setSalesTrackingLastUpdated(Date.now());
      }
      console.log("[Sales Tracking] Orders loaded", {
        count: normalizedOrders.length,
        doctors: doctorLookup.size,
        sample:
          normalizedOrders[0] && {
            id: normalizedOrders[0].id,
            number: normalizedOrders[0].number,
            createdAt: normalizedOrders[0].createdAt,
            updatedAt: normalizedOrders[0].updatedAt,
            shippingEstimate: normalizedOrders[0].shippingEstimate,
            arrival: normalizedOrders[0].shippingEstimate?.estimatedArrivalDate,
          },
      });
      void enrichMissingOrderDetails(normalizedOrders, {
        onlyIds:
          shouldShowInitialLoading || options?.force === true ? undefined : changedIds,
        force: options?.force === true,
      });
    } catch (error: any) {
      const message =
        typeof error?.message === "string"
          ? error.message
          : "Unable to load sales tracking data at the moment.";
      console.error("[Sales Tracking] Unable to fetch orders", error);
      setSalesTrackingError(message);
    } finally {
      setSalesTrackingLoading(false);
      setSalesTrackingRefreshing(false);
      salesTrackingInFlightRef.current = false;
    }
	  }, [
	    userId,
	    userRole,
	    userSalesRepId,
	    user?.email,
	    postLoginHold,
	    resolveOrderDoctorId,
	    enrichMissingOrderDetails,
	    refreshSalesBySalesRepSummary,
	  ]);

  const refreshSalesRepOrdersForHeader = useCallback(async () => {
    await fetchSalesTrackingOrders({ force: true });
  }, [fetchSalesTrackingOrders]);

  useEffect(() => {
    if (postLoginHold || !userRole || (!isRep(userRole) && !isAdmin(userRole))) {
      return;
    }
    fetchSalesTrackingOrders();
    const leaderKey = "sales-tracking-poll";
    const pollIntervalMs = 25000;
    const leaderTtlMs = Math.max(45_000, pollIntervalMs * 2);
    const pollHandle = window.setInterval(() => {
      if (!isPageVisible()) {
        return;
      }
      if (!isTabLeader(leaderKey, leaderTtlMs)) {
        return;
      }
      void fetchSalesTrackingOrders();
    }, pollIntervalMs);
    return () => {
      releaseTabLeadership(leaderKey);
      window.clearInterval(pollHandle);
    };
  }, [fetchSalesTrackingOrders, userRole, postLoginHold]);

  const salesTrackingSummary = useMemo(() => {
    if (salesTrackingOrders.length === 0) {
      return null;
    }
    const activeOrders = salesTrackingOrders.filter((order) => {
      return shouldCountRevenueForStatus(order.status);
    });
    const revenue = activeOrders.reduce(
      (sum, order) => sum + (coerceNumber(order.total) ?? 0),
      0,
    );
    return {
      totalOrders: activeOrders.length,
      totalRevenue: revenue,
      latestOrder: activeOrders[0] || salesTrackingOrders[0],
    };
	  }, [salesTrackingOrders]);

	  const referralIdLookupForDoctorNotes = useMemo(() => {
	    const map = new Map<string, { referralId: string; updatedAtMs: number }>();
	    const referrals = (salesRepDashboard?.referrals ?? []) as any[];
	    referrals.forEach((ref) => {
	      if (!ref?.id) return;
	      const referralId = String(ref.id);
	      const updatedAtMs = ref.updatedAt ? new Date(ref.updatedAt).getTime() : 0;
	      const add = (key?: string | null) => {
	        if (!key) return;
	        const normalized = String(key).trim().toLowerCase();
	        if (!normalized) return;
	        const existing = map.get(normalized);
	        if (!existing || updatedAtMs > existing.updatedAtMs) {
	          map.set(normalized, { referralId, updatedAtMs });
	        }
	      };
	      add(ref.referredContactAccountId ? `acct:${ref.referredContactAccountId}` : null);
	      add(ref.convertedDoctorId ? `acct:${ref.convertedDoctorId}` : null);
	      add(ref.referredContactEmail ? `email:${String(ref.referredContactEmail).toLowerCase()}` : null);
	      add(ref.referredContactAccountEmail ? `email:${String(ref.referredContactAccountEmail).toLowerCase()}` : null);
	    });
	    return map;
	  }, [salesRepDashboard?.referrals]);

	  const resolveReferralIdForDoctorNotes = useCallback(
	    (doctorId?: string | null, doctorEmail?: string | null): string | null => {
	      if (doctorId) {
	        const hit = referralIdLookupForDoctorNotes.get(`acct:${String(doctorId).toLowerCase()}`);
	        if (hit) return hit.referralId;
	      }
	      if (doctorEmail) {
	        const hit = referralIdLookupForDoctorNotes.get(`email:${String(doctorEmail).toLowerCase()}`);
	        if (hit) return hit.referralId;
	      }
	      return null;
	    },
	    [referralIdLookupForDoctorNotes],
	  );

	  const salesTrackingOrdersByDoctor = useMemo(() => {
	    const buckets = new Map<
	      string,
	      {
	        doctorId: string;
	        doctorName: string;
	        doctorEmail?: string | null;
	        doctorAvatar?: string | null;
	        doctorPhone?: string | null;
	        ownerSalesRepId?: string | null;
	        ownerSalesRepName?: string | null;
	        ownerSalesRepEmail?: string | null;
	        leadType?: string | null;
	        leadTypeSource?: string | null;
	        leadTypeLockedAt?: string | null;
	        doctorAddress?: string | null;
	        orders: AccountOrderSummary[];
        total: number;
      }
    >();
    for (const order of salesTrackingOrders) {
      const doctorId =
        resolveOrderDoctorId(order) || order.userId || `anon:${order.id}`;
      const doctorInfo = doctorId ? salesTrackingDoctors.get(doctorId) : null;
      const doctorName =
        doctorInfo?.name ||
        salesRepDoctorsById.get(doctorId) ||
        order.doctorName ||
        "Doctor";
      const doctorEmail = doctorInfo?.email || order.doctorEmail || null;
      const doctorAvatar =
        doctorInfo?.profileImageUrl ||
        (order as any).doctorProfileImageUrl ||
        null;
      const leadType = doctorInfo?.leadType || null;
      const leadTypeSource = doctorInfo?.leadTypeSource || null;
      const leadTypeLockedAt = doctorInfo?.leadTypeLockedAt || null;
      const doctorAddress = (() => {
        const parts = [
          doctorInfo?.address1,
          doctorInfo?.address2,
          [doctorInfo?.city, doctorInfo?.state, doctorInfo?.postalCode]
            .filter(Boolean)
            .join(", "),
          doctorInfo?.country,
        ].filter((p) => typeof p === "string" && p.trim().length > 0);
        return parts.length > 0 ? parts.join("\n") : null;
      })();
	      const doctorPhone = doctorInfo?.phone || null;
      const doctorNameFromOrder =
        doctorName ||
        [order?.billing?.firstName, order?.billing?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        (order as any)?.billing_name ||
        "Doctor";
	      const doctorEmailFromOrder =
	        doctorEmail ||
	        (order as any)?.billing?.email ||
	        (order as any)?.billing_email ||
	        null;
	      const ownerSalesRepId =
	        doctorInfo?.salesRepId ||
	        (order as any)?.doctorSalesRepId ||
	        (order as any)?.doctor_sales_rep_id ||
	        (order as any)?.salesRepId ||
	        (order as any)?.sales_rep_id ||
	        (order as any)?.salesRep?.id ||
	        null;
	      const ownerSalesRepName =
	        doctorInfo?.salesRepName ||
	        (order as any)?.doctorSalesRepName ||
	        (order as any)?.doctor_sales_rep_name ||
	        (order as any)?.salesRepName ||
	        (order as any)?.sales_rep_name ||
	        (order as any)?.salesRep?.name ||
	        null;
	      const ownerSalesRepEmail =
	        doctorInfo?.salesRepEmail ||
	        (order as any)?.doctorSalesRepEmail ||
	        (order as any)?.doctor_sales_rep_email ||
	        (order as any)?.salesRepEmail ||
	        (order as any)?.sales_rep_email ||
	        (order as any)?.salesRep?.email ||
	        null;
	      const bucket =
	        buckets.get(doctorId) ||
	        (() => {
	          const created = {
	            doctorId,
            doctorName: doctorNameFromOrder,
            doctorEmail: doctorEmailFromOrder,
            doctorAvatar,
	            doctorPhone,
	            ownerSalesRepId: ownerSalesRepId
	              ? String(ownerSalesRepId)
	              : null,
	            ownerSalesRepName:
	              typeof ownerSalesRepName === "string" && ownerSalesRepName.trim().length > 0
	                ? ownerSalesRepName.trim()
	                : null,
	            ownerSalesRepEmail:
	              typeof ownerSalesRepEmail === "string" && ownerSalesRepEmail.trim().length > 0
	                ? ownerSalesRepEmail.trim()
	                : null,
	            leadType,
	            leadTypeSource,
	            leadTypeLockedAt,
	            doctorAddress,
            orders: [] as AccountOrderSummary[],
            total: 0,
          };
          buckets.set(doctorId, created);
          return created;
        })();
	      if (ownerSalesRepId && !bucket.ownerSalesRepId) {
	        bucket.ownerSalesRepId = String(ownerSalesRepId);
	      }
	      if (ownerSalesRepName && !bucket.ownerSalesRepName) {
	        bucket.ownerSalesRepName = String(ownerSalesRepName);
	      }
	      if (ownerSalesRepEmail && !bucket.ownerSalesRepEmail) {
	        bucket.ownerSalesRepEmail = String(ownerSalesRepEmail);
	      }
	      bucket.orders.push(order);
	      const status = order.status;
      if (shouldCountRevenueForStatus(status)) {
        bucket.total += coerceNumber(order.total) ?? 0;
      }
    }
    return Array.from(buckets.values()).sort((a, b) => b.total - a.total);
  }, [
    salesTrackingOrders,
    resolveOrderDoctorId,
    salesTrackingDoctors,
    salesRepDoctorsById,
  ]);

  const hasAuthToken = useCallback(() => {
    try {
      const sessionToken = sessionStorage.getItem("auth_token");
      if (sessionToken && sessionToken.trim().length > 0) {
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }, []);

  const refreshReferralData = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!user) {
        console.debug("[Referral] refreshReferralData skipped: no user");
        return;
      }

      if (referralPollingSuppressed) {
        console.debug(
          "[Referral] refreshReferralData suppressed due to prior auth error",
        );
        return;
      }

      const shouldShowLoading = options?.showLoading ?? true;
      const now = Date.now();
      if (!shouldShowLoading) {
        const last = referralLastRefreshAtRef.current;
        if (last > 0 && now - last < REFERRAL_BACKGROUND_MIN_INTERVAL_MS) {
          console.debug("[Referral] refreshReferralData throttled", {
            sinceMs: now - last,
            minIntervalMs: REFERRAL_BACKGROUND_MIN_INTERVAL_MS,
          });
          return;
        }
      }

      if (
        referralSummaryCooldownRef.current &&
        referralSummaryCooldownRef.current > Date.now()
      ) {
        console.debug("[Referral] refreshReferralData in cooldown");
        return;
      }

      if (!hasAuthToken()) {
        console.debug(
          "[Referral] refreshReferralData skipped: missing auth token",
        );
        setReferralPollingSuppressed(true);
        return;
      }

      if (referralRefreshInFlight.current) {
        if (shouldShowLoading) {
          setReferralDataLoading(true);
        }
        return;
      }

      referralRefreshInFlight.current = true;
      referralLastRefreshAtRef.current = now;

      if (shouldShowLoading) {
        setReferralDataLoading(true);
      }

      console.debug("[Referral] Refresh start", {
        role: user.role,
        userId: user.id,
      });

      try {
        setReferralDataError(null);
        if (isDoctorRole(user.role)) {
          const response = await referralAPI.getDoctorSummary();
          const referrals = Array.isArray(response?.referrals)
            ? response.referrals
            : [];
          const credits = response?.credits ?? {};

          const normalizedCredits: DoctorCreditSummary = {
            totalCredits: Number(credits.totalCredits ?? 0),
            availableCredits: Number(
              credits.availableCredits ??
                credits.totalCredits ??
                user?.referralCredits ??
                0,
            ),
            netCredits:
              typeof credits.netCredits === "number"
                ? Number(credits.netCredits)
                : undefined,
            firstOrderBonuses: Number(credits.firstOrderBonuses ?? 0),
            ledger: Array.isArray(credits.ledger) ? credits.ledger : [],
          };

          setDoctorSummary({ ...normalizedCredits });
          const normalizedReferrals = referrals.map((referral) => ({
            ...referral,
          }));
          setDoctorReferrals(normalizedReferrals);
          setUser((previous) => {
            if (!previous) {
              return previous;
            }
            const nextCredits = normalizedCredits.availableCredits;
            const nextTotalReferrals = normalizedReferrals.length;
            const unchanged =
              Number(previous.referralCredits ?? 0) === nextCredits &&
              Number(previous.totalReferrals ?? 0) === nextTotalReferrals;
            if (unchanged) {
              return previous;
            }
            return {
              ...previous,
              referralCredits: nextCredits,
              totalReferrals: nextTotalReferrals,
            };
          });
          console.debug("[Referral] Doctor summary loaded", {
            referrals: normalizedReferrals.length,
            credits: normalizedCredits,
          });
        } else if (isRep(user.role) || isAdmin(user.role)) {
          const dashboard = await referralAPI.getSalesRepDashboard({
            salesRepId: user.salesRepId || user.id,
            scope: isAdmin(user.role) ? "mine" : "mine",
          });
          setSalesRepDashboard(dashboard);
          console.debug("[Referral] Sales rep dashboard loaded", {
            referrals: dashboard?.referrals?.length ?? 0,
            statuses: dashboard?.statuses ?? null,
          });
        } else {
          console.debug("[Referral] Refresh skipped for role", {
            role: user.role,
          });
        }
      } catch (error: any) {
        const status = typeof error?.status === "number" ? error.status : null;
        const message =
          typeof error?.message === "string" ? error.message : "UNKNOWN_ERROR";
        console.warn("[Referral] Failed to load data", {
          status,
          message,
          error,
        });
        if (status === 401 || status === 403) {
          setReferralPollingSuppressed(true);
          referralSummaryCooldownRef.current = Date.now() + 5 * 60 * 1000; // 5 minutes
        }
        setReferralDataError(
          <>
            There is an issue in loading your referral data. Please refresh the
            page or contact{" "}
            <a
              className="text-[rgb(95,179,249)] underline"
              href="mailto:support@peppro.net"
            >
              support@peppro.net
            </a>
            .
          </>,
        );
      } finally {
        console.debug("[Referral] Refresh complete", { role: user.role });
        referralRefreshInFlight.current = false;
        if (shouldShowLoading) {
          setReferralDataLoading(false);
        }
      }
    },
    [user, setUser, referralPollingSuppressed, hasAuthToken],
  );

  const tracedRefreshReferralData = useCallback(
    async (trigger: string, options?: { showLoading?: boolean }) => {
      const userSnapshot = user
        ? { id: user.id, role: user.role }
        : { id: null, role: null };
      const showLoading = options?.showLoading ?? true;
      console.debug("[Referral] refreshReferralData invoke", {
        trigger,
        showLoading,
        user: userSnapshot,
        suppressed: referralPollingSuppressed,
        postLoginHold,
        ts: Date.now(),
        stack:
          typeof Error !== "undefined"
            ? new Error("refreshReferralData stack").stack
            : undefined,
      });
      return refreshReferralData(options);
    },
    [user, referralPollingSuppressed, postLoginHold, refreshReferralData],
  );

  const handleManualProspectSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!manualProspectForm.name.trim()) {
        toast.error("Name is required.");
        return;
      }
      try {
        setManualProspectSubmitting(true);
	        await referralAPI.createManualProspect({
	          name: manualProspectForm.name.trim(),
	          email: manualProspectForm.email.trim() || undefined,
	          phone: manualProspectForm.phone.trim() || undefined,
	          notes: normalizeNotesValue(manualProspectForm.notes) || undefined,
	          status: manualProspectForm.status,
	          hasAccount: false,
	        });
        toast.success("Prospect added successfully.");
        closeManualProspectModal();
        await tracedRefreshReferralData("manual-prospect-submit", {
          showLoading: false,
        });
      } catch (error: any) {
        console.error("[Referral] Manual prospect create failed", error);
        const message =
          typeof error?.message === "string"
            ? error.message
            : "Unable to add prospect right now.";
        toast.error(message);
      } finally {
        setManualProspectSubmitting(false);
      }
    },
	    [
	      manualProspectForm,
	      closeManualProspectModal,
	      normalizeNotesValue,
	      tracedRefreshReferralData,
	    ],
	  );

	  const promoteSyntheticAccountProspect = useCallback(
	    async (record: any, nextStatus: string) => {
	      if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
	        return;
	      }

	      const doctorId = String(record?.referredContactAccountId || "").trim();
	      if (!doctorId) {
	        toast.error("Unable to update this account prospect.");
	        return;
	      }

	      try {
	        setAdminActionState((prev) => ({
	          ...prev,
	          updatingReferral: String(record?.id || ""),
	          error: null,
	        }));

	        const response = await referralAPI.upsertSalesProspect(doctorId, {
	          status: nextStatus,
	        });
	        const prospect = (response as any)?.prospect;
	        if (prospect) {
	          setAccountProspectProspects((prev) => ({ ...prev, [doctorId]: prospect }));
	        }

	        toast.success("Prospect updated.");
	        await tracedRefreshReferralData("synthetic-account-promote", {
	          showLoading: false,
	        });
	      } catch (error: any) {
        console.error("[Referral] Synthetic account promote failed", error);
        const message =
          typeof error?.message === "string" && error.message
            ? error.message
            : "Unable to update prospect right now.";
        setAdminActionState((prev) => ({ ...prev, error: message }));
	        toast.error(message);
	      } finally {
	        setAdminActionState((prev) => ({ ...prev, updatingReferral: null }));
	      }
	    },
	    [setAccountProspectProspects, tracedRefreshReferralData, user],
	  );

	  const [resellerPermitBusyByProspectId, setResellerPermitBusyByProspectId] =
	    useState<Record<string, boolean>>({});

	  const patchSalesRepDashboardReferral = useCallback(
	    (referralId: string, patch: Record<string, any>) => {
	      setSalesRepDashboard((prev: any) => {
	        if (!prev) return prev;
	        const referrals = Array.isArray(prev.referrals) ? prev.referrals : [];
	        const nextReferrals = referrals.map((item: any) => {
	          if (String(item?.id || "") !== String(referralId)) {
	            return item;
	          }
	          return { ...item, ...patch };
	        });
	        return { ...prev, referrals: nextReferrals };
	      });
	    },
	    [],
	  );

	  const updateResellerPermitExempt = useCallback(
	    async (prospectId: string, exempt: boolean) => {
	      if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
	        return;
	      }
	      setResellerPermitBusyByProspectId((prev) => ({
	        ...prev,
	        [prospectId]: true,
	      }));
	      try {
	        const response = await referralAPI.upsertSalesProspect(prospectId, {
	          resellerPermitExempt: exempt,
	        });
	        const prospect = (response as any)?.prospect;
	        patchSalesRepDashboardReferral(prospectId, {
	          resellerPermitExempt: exempt,
	          ...(prospect && typeof prospect === "object" ? prospect : {}),
	        });
	      } catch (error: any) {
	        console.warn("[Prospects] Update reseller permit exempt failed", error);
	        toast.error(
	          typeof error?.message === "string" && error.message
	            ? error.message
	            : "Unable to update permit status right now.",
	        );
	      } finally {
	        setResellerPermitBusyByProspectId((prev) => ({
	          ...prev,
	          [prospectId]: false,
	        }));
	      }
	    },
	    [patchSalesRepDashboardReferral, user],
	  );

			  const uploadResellerPermit = useCallback(
			    async (prospectId: string, file: File) => {
			      if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
			        return;
		      }
	      setResellerPermitBusyByProspectId((prev) => ({
	        ...prev,
	        [prospectId]: true,
	      }));
	      try {
	        const response = await referralAPI.uploadResellerPermit(prospectId, file);
	        const prospect = (response as any)?.prospect;
	        patchSalesRepDashboardReferral(prospectId, {
	          ...(prospect && typeof prospect === "object" ? prospect : {}),
	          resellerPermitFileName: file.name,
	        });
	      } catch (error: any) {
	        console.warn("[Prospects] Upload reseller permit failed", error);
	        toast.error(
	          typeof error?.message === "string" && error.message
	            ? error.message
	            : "Unable to upload permit right now.",
	        );
	      } finally {
	        setResellerPermitBusyByProspectId((prev) => ({
	          ...prev,
	          [prospectId]: false,
	        }));
	      }
	    },
			    [patchSalesRepDashboardReferral, user],
			  );

			  const deleteResellerPermit = useCallback(
			    async (prospectId: string) => {
			      if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
			        return;
			      }
			      if (!window.confirm("Delete this reseller permit file?")) {
			        return;
			      }
			      setResellerPermitBusyByProspectId((prev) => ({
			        ...prev,
			        [prospectId]: true,
			      }));
			      try {
			        const response = await referralAPI.deleteResellerPermit(prospectId);
			        const prospect = (response as any)?.prospect;
			        patchSalesRepDashboardReferral(prospectId, {
			          ...(prospect && typeof prospect === "object" ? prospect : {}),
			          resellerPermitFileName: null,
			          resellerPermitFilePath: null,
			          resellerPermitUploadedAt: null,
			        });
			      } catch (error: any) {
			        console.warn("[Prospects] Delete reseller permit failed", error);
			        toast.error(
			          typeof error?.message === "string" && error.message
			            ? error.message
			            : "Unable to delete permit right now.",
			        );
			      } finally {
			        setResellerPermitBusyByProspectId((prev) => ({
			          ...prev,
			          [prospectId]: false,
			        }));
			      }
			    },
			    [patchSalesRepDashboardReferral, user],
			  );

			  const viewResellerPermit = useCallback(
			    async (prospectId: string, fallbackName?: string) => {
			      if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
			        return;
			      }
		      setResellerPermitBusyByProspectId((prev) => ({
		        ...prev,
		        [prospectId]: true,
		      }));
		      try {
		        const result = await referralAPI.downloadResellerPermit(prospectId);
		        const objectUrl = URL.createObjectURL(result.blob);
		        const opened = window.open(objectUrl, "_blank", "noopener,noreferrer");
		        if (!opened) {
		          const anchor = document.createElement("a");
		          anchor.href = objectUrl;
		          anchor.download =
		            result.filename || fallbackName || "reseller_permit";
		          document.body.appendChild(anchor);
		          anchor.click();
		          anchor.remove();
		        }
		        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
		      } catch (error: any) {
		        console.warn("[Prospects] Download reseller permit failed", error);
		        toast.error(
		          typeof error?.message === "string" && error.message
		            ? error.message
		            : "Unable to download permit right now.",
		        );
		      } finally {
		        setResellerPermitBusyByProspectId((prev) => ({
		          ...prev,
		          [prospectId]: false,
		        }));
		      }
		    },
		    [user],
		  );

  const handleDeleteDoctorReferral = useCallback(
    async (referralId: string) => {
      if (!window.confirm("Delete this referral? This cannot be undone.")) {
        return;
      }
      try {
        setDoctorDeletingReferralId(referralId);
        await referralAPI.deleteDoctorReferral(referralId);
        setDoctorReferrals((prev) =>
          prev.filter((referral) => referral.id !== referralId),
        );
        toast.success("Referral deleted.");
      } catch (error: any) {
        console.error("[Referral] Doctor referral delete failed", error);
        toast.error(
          typeof error?.message === "string"
            ? error.message
            : "Unable to delete referral right now.",
        );
      } finally {
        setDoctorDeletingReferralId(null);
      }
    },
    [],
  );

  const handleReferralCredit = useCallback(
    async (referral: ReferralRecord) => {
      const doctorId = referral.referrerDoctorId;
      const doctorName = referral.referrerDoctorName || "User";
      if (!doctorId) {
        toast.error(
          "Unable to credit this referral because the referrer is missing.",
        );
        return;
      }
      if (!window.confirm("Are you sure?")) {
        return;
      }
      try {
        setCreditingReferralId(referral.id);
        await referralAPI.addManualCredit({
          doctorId,
          amount: 50,
          reason: `Manual credit for referral ${referral.id}`,
          referralId: referral.id,
        });
        toast.success(`Credited ${doctorName} $50`);
        await tracedRefreshReferralData("manual-credit", {
          showLoading: true,
        });
      } catch (error: any) {
        console.error("[Referral] Manual credit failed", error);
        const message =
          typeof error?.message === "string"
            ? error.message
            : "Unable to issue credit right now.";
        toast.error(message);
      } finally {
        setCreditingReferralId(null);
      }
    },
    [tracedRefreshReferralData],
  );

  const formatDate = useCallback((value?: string | null) => {
    if (!value) {
      return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, []);

  const formatDateTime = useCallback((value?: string | null) => {
    if (!value) {
      return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }, []);

  const formatCurrency = useCallback(
    (amount?: number | null, currency = "USD") => {
      if (amount === null || amount === undefined || Number.isNaN(amount)) {
        return "—";
      }
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
        }).format(amount);
      } catch {
        return `$${amount.toFixed(2)}`;
      }
    },
    [],
  );

  const checkoutButtonRef = useCallback((node: HTMLButtonElement | null) => {
    if (checkoutButtonObserverRef.current) {
      checkoutButtonObserverRef.current.disconnect();
      checkoutButtonObserverRef.current = null;
    }

    if (!node || typeof IntersectionObserver === "undefined") {
      setIsCheckoutButtonVisible(false);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsCheckoutButtonVisible(entry.isIntersecting);
      },
      {
        rootMargin: "-10% 0px 0px 0px",
      },
    );

    observer.observe(node);
    checkoutButtonObserverRef.current = observer;
  }, []);

  // Always start with a clean auth slate on fresh loads
  useEffect(() => {
    authAPI.logout();
  }, []);

  // Variation cache is loaded lazily when a variable product is opened/needed.

  useEffect(() => {
    let cancelled = false;
    const warmApi = async () => {
      const start =
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      try {
        const healthy = await checkServerHealth();
        if (!cancelled) {
          const end =
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
              ? performance.now()
              : Date.now();
          console.debug("[Auth] API warm-up complete", {
            healthy,
            durationMs: Math.round(end - start),
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[Auth] API warm-up failed", error);
        }
      }
    };
    warmApi();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

		    const scheduleRetry = (
		      background = false,
		      delayMs: number = CATALOG_RETRY_DELAY_MS,
		    ) => {
		      if (catalogRetryTimeoutRef.current) {
		        window.clearTimeout(catalogRetryTimeoutRef.current);
		      }
          if (!background) {
            setCatalogRetryUntil(Date.now() + delayMs);
            setCatalogTransientIssue(true);
          }
	        if (CATALOG_DEBUG) {
	          console.info("[Catalog] Retry scheduled", { background, delayMs });
	        }
		      catalogRetryTimeoutRef.current = window.setTimeout(() => {
		        void loadCatalog(background);
		      }, delayMs);
		    };

			    const loadCatalog = async (background = false) => {
			      if (cancelled || catalogFetchInFlightRef.current) {
			        return;
			      }

		      catalogFetchInFlightRef.current = true;
		      catalogRetryTimeoutRef.current = null;
          if (!background) {
            setCatalogRetryUntil(null);
            setCatalogEmptyReady(false);
            catalogEmptyResultRetryCountRef.current = 0;
          }
		      if (!background) {
		        setCatalogLoading(true);
		      }
		      setCatalogError(null);
          if (!background) {
            // Keep the UI calm during cold-start retries; only show an error after repeated failures.
            setCatalogTransientIssue(false);
          }
	        const startedAt = Date.now();
		        if (CATALOG_DEBUG) {
		          console.info("[Catalog] Load started", {
		            background,
              build: FRONTEND_BUILD_ID,
	            apiBase: (import.meta.env.VITE_API_URL as string | undefined) || "",
	            wooProxy:
	              (import.meta.env.VITE_WOO_PROXY_URL as string | undefined) || "",
	          });
	        }
			      try {
            ensureVariationCacheReady();

		            const fetchAllPublishedProducts = async (): Promise<WooProduct[]> => {
		              const perPage = 100;
		              const maxPages = 25;
		              const items: WooProduct[] = [];
	              const fetchPage = async (page: number) => {
	                const pageStartedAt = Date.now();
	                const batch = await listProducts<WooProduct[]>({
	                  per_page: perPage,
	                  page,
	                  status: "publish",
	                });
	                if (CATALOG_DEBUG) {
	                  console.info("[Catalog] Products page loaded", {
	                    page,
	                    count: Array.isArray(batch) ? batch.length : 0,
	                    durationMs: Date.now() - pageStartedAt,
	                  });
	                }
	                return batch;
	              };

	              for (let page = 1; page <= maxPages; page += CATALOG_PAGE_CONCURRENCY) {
	                const pages = Array.from(
	                  { length: CATALOG_PAGE_CONCURRENCY },
	                  (_, idx) => page + idx,
	                ).filter((p) => p <= maxPages);

	                // eslint-disable-next-line no-await-in-loop
	                const batches = await Promise.all(
	                  pages.map((p) => fetchPage(p)),
	                );

	                let reachedEnd = false;
	                for (let idx = 0; idx < batches.length; idx += 1) {
	                  const batch = batches[idx];
	                  const currentPage = pages[idx];
	                  if (!Array.isArray(batch) || batch.length === 0) {
	                    if (CATALOG_DEBUG) {
	                      console.info("[Catalog] Products page empty", {
	                        page: currentPage,
	                      });
	                    }
	                    reachedEnd = true;
	                    break;
	                  }
	                  items.push(...batch);
	                  if (batch.length < perPage) {
	                    reachedEnd = true;
	                    break;
	                  }
	                }
	                if (reachedEnd) {
	                  break;
	                }
	              }
		              if (CATALOG_DEBUG && items.length === 0) {
		                console.warn("[Catalog] No Woo products returned");
		              }
		              return items;
		            };

            const [wooProducts, wooCategories] = await Promise.all([
              fetchAllPublishedProducts(),
              listCategories<WooCategory[]>({ per_page: 100 }),
            ]);

            if (cancelled) {
              return;
            }

            if (CATALOG_DEBUG) {
              console.info("[Catalog] Woo base payload loaded", {
                products: Array.isArray(wooProducts) ? wooProducts.length : 0,
                categories: Array.isArray(wooCategories) ? wooCategories.length : 0,
                durationMs: Date.now() - startedAt,
              });
            }

            const categoryNamesFromApi = Array.isArray(wooCategories)
              ? wooCategories
                  .map((category) => category?.name?.trim())
                  .filter(
                    (name): name is string =>
                      Boolean(name) &&
                      !name.toLowerCase().includes("subscription"),
                  )
              : [];
            const categoryNameById = new Map<number, string>();
            if (Array.isArray(wooCategories)) {
              for (const category of wooCategories) {
                const id =
                  typeof category?.id === "number"
                    ? category.id
                    : Number.parseInt(String((category as any)?.id ?? ""), 10);
                if (!Number.isFinite(id)) continue;
                const name =
                  typeof category?.name === "string" ? category.name.trim() : "";
                if (!name) continue;
                categoryNameById.set(Number(id), name);
              }
            }
            wooCategoryNameByIdRef.current = categoryNameById;
            if (categoryNamesFromApi.length > 0) {
              setCatalogCategories(categoryNamesFromApi);
              if (CATALOG_DEBUG) {
                console.info("[Catalog] Categories set from API", {
                  categories: categoryNamesFromApi,
                });
              }
            } else if (CATALOG_DEBUG) {
              console.info("[Catalog] Categories empty after filter", {
                rawCategories: Array.isArray(wooCategories)
                  ? wooCategories.map((category) => category?.name)
                  : [],
              });
            }

	        wooProductCacheRef.current = new Map<number, WooProduct>(
	          (wooProducts ?? [])
	            .filter((item): item is WooProduct =>
	              Boolean(item && typeof item === "object" && "id" in item),
	            )
	            .map((item) => {
	              const hydrated = hydrateWooProductCategoryNames(
	                item,
	                wooCategoryNameByIdRef.current,
	              );
	              const id =
	                typeof hydrated.id === "number"
	                  ? hydrated.id
	                  : Number.parseInt(String(hydrated.id).replace(/[^\d]/g, ""), 10);
	              if (!Number.isFinite(id)) {
	                return null;
	              }
	              return [id, hydrated] as const;
	            })
	            .filter((entry): entry is readonly [number, WooProduct] =>
	              Boolean(entry),
	            ),
	        );

        const applyCatalogState = (products: Product[]) => {
          if (!products || products.length === 0) {
            return false;
          }
          if (CATALOG_DEBUG) {
            console.info("[Catalog] Applying catalog state", {
              products: products.length,
            });
          }
          setCatalogProducts(products);
          const categoriesFromProducts = Array.from(
            new Set(
              products
                .map((product) => product.category)
                .filter(
                  (category): category is string =>
                    Boolean(category) &&
                    !category.toLowerCase().includes("subscription"),
                ),
            ),
          );
          const nextCategoriesBase =
            categoryNamesFromApi.length > 0 ? categoryNamesFromApi : categoriesFromProducts;
          const nextCategories = Array.from(
            new Set([...nextCategoriesBase, ...categoriesFromProducts]),
          );
          if (nextCategories.length > 0) {
            setCatalogCategories(nextCategories);
          }
          const typesFromProducts = Array.from(
            new Set(products.map((product) => product.type).filter(Boolean)),
          ) as string[];
          if (typesFromProducts.length > 0) {
            setCatalogTypes(typesFromProducts);
          }
          return true;
        };

          let mapFailures = 0;
          const sampleMapFailures: Array<{
            id?: unknown;
            name?: unknown;
            message?: string;
          }> = [];

		        const baseProducts = (wooProducts ?? [])
		          .filter((item): item is WooProduct =>
		            Boolean(item && typeof item === "object" && "id" in item),
		          )
		          .map((item) => {
		            try {
		              const hydrated = hydrateWooProductCategoryNames(
		                item,
		                wooCategoryNameByIdRef.current,
		              );
		              return mapWooProductToProduct(
		                hydrated,
		                [],
		              );
		            } catch (error) {
                mapFailures += 1;
                if (sampleMapFailures.length < 5) {
                  sampleMapFailures.push({
                    id: (item as any)?.id,
                    name: (item as any)?.name,
                    message:
                      typeof (error as any)?.message === "string"
                        ? (error as any).message
                        : undefined,
                  });
                }
	              console.warn(
	                "[Catalog] Failed to map Woo product",
	                (item as any)?.id,
	                error,
	              );
	              return null;
	            }
	          })
	          .filter((product): product is Product => Boolean(product && product.name));

	        if (CATALOG_DEBUG) {
	          console.info("[Catalog] Base products mapped", {
	            count: baseProducts.length,
              mapFailures,
              sampleMapFailures,
	          });
	        }

          if (Array.isArray(wooProducts) && wooProducts.length > 0 && baseProducts.length === 0) {
            const mappingError =
              mapFailures > 0
                ? `Catalog mapping failed for ${mapFailures} products.`
                : "Catalog mapping produced 0 products.";
            setCatalogError(mappingError);
            console.error("[Catalog] Mapping resulted in empty catalog", {
              mappingError,
              wooCount: wooProducts.length,
              mapFailures,
              sampleMapFailures,
            });
          }

		        const hadBaseProducts = applyCatalogState(baseProducts);
            if (CATALOG_DEBUG) {
              console.info("[Catalog] Catalog state applied", {
                products: baseProducts.length,
                categories: catalogCategories.length || categoryNamesFromApi.length,
                durationMs: Date.now() - startedAt,
              });
            }
            if (!background) {
              // If Woo returns an empty catalog during cold-start, retry quickly a few times
              // before allowing the UI to render "No products found".
              if (!hadBaseProducts && baseProducts.length === 0 && catalogProducts.length === 0) {
                if (catalogEmptyResultRetryCountRef.current < CATALOG_EMPTY_RESULT_RETRY_MAX) {
                  catalogEmptyResultRetryCountRef.current += 1;
                  const delayMs = Math.max(
                    CATALOG_EMPTY_RESULT_RETRY_DELAY_MS,
                    CATALOG_RETRY_FAST_DELAY_MS,
                  );
                  setCatalogTransientIssue(true);
                  scheduleRetry(false, delayMs);
                  return;
                }
              }

              setCatalogLoading(false);
              if (hadBaseProducts) {
                catalogFailureCountRef.current = 0;
                setCatalogTransientIssue(false);
              }
            }
	        if (CATALOG_DEBUG) {
	          console.info("[Catalog] Load complete (state)", {
	            products: baseProducts.length,
	            categories: catalogCategories.length,
	            loading: false,
	          });
	        }
	      } catch (error) {
			        if (!cancelled) {
	              const message =
	                typeof (error as any)?.message === "string" &&
	                (error as any).message.trim().length > 0
	                  ? (error as any).message
	                  : "Catalog fetch failed";
                const status =
                  typeof (error as any)?.status === "number"
                    ? (error as any).status
                    : null;
                const errorName =
                  typeof (error as any)?.name === "string" ? (error as any).name : "";
                const shouldBackoff =
                  status === 429 ||
                  status === 500 ||
                  status === 502 ||
                  status === 503 ||
                  status === 504 ||
                  message === "Failed to fetch" ||
                  message === "Load failed" ||
                  errorName === "TypeError";
                if (shouldBackoff) {
                  wooBackoffAttemptRef.current += 1;
                  const attempt = Math.min(8, wooBackoffAttemptRef.current);
                  const delayMs = Math.min(
                    5 * 60 * 1000,
                    2000 * Math.pow(2, attempt - 1),
                  );
                  wooBackoffUntilRef.current = Date.now() + delayMs;
                }
                if (!background) {
                  catalogFailureCountRef.current += 1;
                  // Retry quickly on the first failure; back off on subsequent failures.
                  const fastRetry =
                    catalogFailureCountRef.current === 1
                      ? CATALOG_RETRY_FAST_DELAY_MS
                      : CATALOG_RETRY_DELAY_MS;
                  const retryDelayMs = Math.max(
                    fastRetry,
                    Math.max(0, wooBackoffUntilRef.current - Date.now()),
                  );
                  // Only surface a scary error state after multiple consecutive failures.
                  if (catalogFailureCountRef.current >= 2) {
                    setCatalogError(message);
                  } else {
                    setCatalogTransientIssue(true);
                  }
                  scheduleRetry(false, retryDelayMs);
                  return;
                }
			          console.error("[Catalog] Catalog fetch failed", { message, error });
		          scheduleRetry(background);
		        }
		      } finally {
	        if (CATALOG_DEBUG) {
	          console.info("[Catalog] Load finished", {
	            background,
	            durationMs: Date.now() - startedAt,
	          });
	        }
		        catalogFetchInFlightRef.current = false;
		      }
		    };

	    void loadCatalog(false);

	    const leaderKey = "catalog-background-poll";
	    const leaderTtlMs = Math.max(45_000, CATALOG_POLL_INTERVAL_MS * 2);
	    const intervalId = window.setInterval(() => {
	      if (!isPageVisible()) {
	        return;
	      }
      if (!isTabLeader(leaderKey, leaderTtlMs)) {
        return;
      }
      logLeaderActivity(leaderKey, "catalog-background-poll", CATALOG_POLL_INTERVAL_MS);
      void loadCatalog(true);
    }, CATALOG_POLL_INTERVAL_MS);

	    return () => {
	      cancelled = true;
	      releaseTabLeadership(leaderKey);
	      if (catalogRetryTimeoutRef.current) {
	        window.clearTimeout(catalogRetryTimeoutRef.current);
	      }
	      window.clearInterval(intervalId);
	    };
	  }, [ensureVariationCacheReady, persistVariationCache]);

  useEffect(() => {
    if (catalogEmptyTimerRef.current) {
      window.clearTimeout(catalogEmptyTimerRef.current);
      catalogEmptyTimerRef.current = null;
    }
    if (catalogLoading) {
      setCatalogEmptyReady(false);
      return;
    }
    // Only apply the grace period when the *base* catalog is empty (initial load / retry).
    if (catalogProducts.length > 0) {
      setCatalogEmptyReady(false);
      return;
    }
    if (catalogRetryUntil && Date.now() < catalogRetryUntil) {
      setCatalogEmptyReady(false);
      return;
    }
    catalogEmptyTimerRef.current = window.setTimeout(() => {
      setCatalogEmptyReady(true);
      catalogEmptyTimerRef.current = null;
    }, CATALOG_EMPTY_STATE_GRACE_MS);
    return () => {
      if (catalogEmptyTimerRef.current) {
        window.clearTimeout(catalogEmptyTimerRef.current);
        catalogEmptyTimerRef.current = null;
      }
    };
  }, [catalogLoading, catalogProducts.length, catalogRetryUntil]);

  useEffect(() => {
    if (!user) {
      setPeptideNews([]);
      setPeptideNewsError(null);
      setPeptideNewsUpdatedAt(null);
      return;
    }

    let cancelled = false;
    const loadPeptideNews = async () => {
      beginNewsLoading();
      setPeptideNewsError(null);
      const startedAt = Date.now();

      try {
        const data = await newsAPI.getPeptideHeadlines();
        if (cancelled) {
          return;
        }

        const items = Array.isArray(data?.items)
          ? data.items
              .map((item: any) => ({
                title: typeof item?.title === "string" ? item.title.trim() : "",
                url: typeof item?.url === "string" ? item.url.trim() : "",
                summary:
                  typeof item?.summary === "string" && item.summary.trim()
                    ? item.summary.trim()
                    : undefined,
                image:
                  typeof item?.imageUrl === "string" && item.imageUrl.trim()
                    ? item.imageUrl.trim()
                    : undefined,
                date:
                  typeof item?.date === "string" && item.date.trim()
                    ? item.date.trim()
                    : undefined,
              }))
              .filter((item) => item.title && item.url)
          : [];

        if (items.length === 0) {
          setPeptideNews([]);
          setPeptideNewsError("No headlines available right now.");
          setPeptideNewsUpdatedAt(new Date());
          return;
        }
        setPeptideNews(items.slice(0, 6));
        setPeptideNewsUpdatedAt(new Date());
      } catch (error) {
        if (!cancelled) {
          console.warn("[News] Failed to load peptide headlines", error);
          setPeptideNewsError("Unable to load peptide news at the moment.");
          setPeptideNews([]);
        }
      } finally {
        if (!cancelled) {
          settleNewsLoading(startedAt);
        }
      }
    };

    loadPeptideNews();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Prepare welcome animation only on fresh sign-in
  useEffect(() => {
    if (!user) {
      setShowWelcome(false);
      setShowQuote(false);
      setQuoteOfTheDay(null);
      setQuoteLoading(false);
      welcomeShownRef.current = false;
      return;
    }

    // Avoid replaying the welcome animation when simply returning
    // to the info screen or when the user object is updated.
    if (welcomeShownRef.current) {
      return;
    }

    welcomeShownRef.current = true;
    setShowWelcome(false);
    setShowQuote(false);
    setQuoteOfTheDay(null);
    setQuoteLoading(true);
    const timer = window.setTimeout(() => setShowWelcome(true), 250);
    return () => window.clearTimeout(timer);
  }, [user]);

  // Load quote only after welcome animation completes
  useEffect(() => {
    if (!user || !showWelcome || infoFocusActive || showQuote) {
      return;
    }

    let cancelled = false;
    const loadQuote = async () => {
      try {
        const quote = await quotesAPI.getQuoteOfTheDay();
        if (!cancelled) {
          setQuoteOfTheDay(quote);
        }
      } catch (error) {
        console.warn("[Quotes] Failed to load quote of the day", error);
        if (!cancelled) {
          setQuoteOfTheDay({
            text: "Excellence is not a skill, it's an attitude.",
            author: "Ralph Marston",
          });
        }
      } finally {
        if (!cancelled) {
          setQuoteLoading(false);
          setShowQuote(true);
        }
      }
    };

    loadQuote();
    return () => {
      cancelled = true;
    };
  }, [user, showWelcome, infoFocusActive, showQuote]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleResize = () => {
      setIsDesktopLandingLayout(window.innerWidth >= 1024);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!CATALOG_DEBUG) {
      return;
    }
    console.info("[CatalogState] Snapshot", {
      loading: catalogLoading,
      error: catalogError,
      products: catalogProducts.length,
      categories: catalogCategories.length,
      types: catalogTypes.length,
      filters,
      searchQuery: searchQuery.trim(),
    });
  }, [
    catalogLoading,
    catalogError,
    catalogProducts,
    catalogCategories,
    catalogTypes,
    filters,
    searchQuery,
  ]);

  useEffect(() => {
    setFilters((prev) => {
      const nextCategories = prev.categories.filter((category) =>
        catalogCategories.includes(category),
      );
      if (
        nextCategories.length === prev.categories.length &&
        prev.types.length === 0
      ) {
        return prev;
      }
      return {
        ...prev,
        categories: nextCategories,
        types: [],
      };
    });
  }, [catalogCategories]);

  useEffect(() => {
	    if (!user) {
	      setDoctorSummary(null);
	      setDoctorReferrals([]);
	      setSalesRepDashboard(null);
	      setAdminActionState({ updatingReferral: null, error: null });
	      setReferralPollingSuppressed(false);
	      return;
	    }

    setReferralPollingSuppressed(false);

    if (postLoginHold) {
      return;
    }

    let cancelled = false;

    (async () => {
      if (!cancelled) {
        await tracedRefreshReferralData("user-change-initial-load", {
          showLoading: true,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, postLoginHold, refreshReferralData]);

  // Set body classes to control background per view
  useEffect(() => {
    if (typeof document === "undefined") return;
    const isNonLoginView = Boolean(user) && !postLoginHold;
    const isLoginView = !user;
    document.body.classList.toggle("non-login-bg", isNonLoginView);
    document.body.classList.toggle("login-view", isLoginView);
    return () => {
      document.body.classList.remove("non-login-bg");
      document.body.classList.remove("login-view");
    };
  }, [user, postLoginHold]);

  useEffect(() => {
    if (
      !user ||
      (!isRep(user.role) && !isAdmin(user.role)) ||
      postLoginHold ||
      referralPollingSuppressed
    ) {
      return undefined;
    }
    const intervalMs = Math.max(REFERRAL_BACKGROUND_MIN_INTERVAL_MS, 45000);
    const intervalId = window.setInterval(() => {
      tracedRefreshReferralData("sales-rep-auto-refresh", { showLoading: false });
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    user?.id,
    user?.role,
    postLoginHold,
    referralPollingSuppressed,
    tracedRefreshReferralData,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    if (
      !user ||
      (!isDoctorRole(user.role) && !isRep(user.role) && !isAdmin(user.role)) ||
      postLoginHold ||
      referralPollingSuppressed
    ) {
      return undefined;
    }

    let cancelled = false;

    const refreshIfActive = () => {
      if (!cancelled) {
        tracedRefreshReferralData("visibility/focus", { showLoading: false });
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        tracedRefreshReferralData("visibilitychange:visible", {
          showLoading: false,
        });
      }
    };

    const handleFocus = () => {
      tracedRefreshReferralData("window:focus", { showLoading: false });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [
    user?.id,
    user?.role,
    postLoginHold,
    referralPollingSuppressed,
    tracedRefreshReferralData,
  ]);

  useEffect(
    () => () => {
      if (checkoutButtonObserverRef.current) {
        checkoutButtonObserverRef.current.disconnect();
        checkoutButtonObserverRef.current = null;
      }
    },
    [],
  );

  // Add springy scroll effect to sidebar - DISABLED to allow normal scrolling
  // useEffect(() => {
  //   let lastScrollY = window.scrollY;
  //   let ticking = false;

  //   const handleScroll = () => {
  //     if (!ticking) {
  //       window.requestAnimationFrame(() => {
  //         const sidebar = document.querySelector('.filter-sidebar-container > *') as HTMLElement;
  //         if (sidebar && window.innerWidth >= 1024) {
  //           const currentScrollY = window.scrollY;
  //           const scrollDelta = currentScrollY - lastScrollY;
  //           const maxOffset = 40;
  //           const offset = Math.max(-maxOffset, Math.min(maxOffset, scrollDelta * 0.8));

  //           sidebar.style.transform = `translateY(${-offset}px)`;

  //           setTimeout(() => {
  //             sidebar.style.transform = 'translateY(0)';
  //           }, 150);

  //           lastScrollY = currentScrollY;
  //         }
  //         ticking = false;
  //       });
  //       ticking = true;
  //     }
  //   };

  //   window.addEventListener('scroll', handleScroll, { passive: true });
  //   return () => window.removeEventListener('scroll', handleScroll);
  // }, []);

  useEffect(() => {
    const closeAllDialogs = () => {
      setProductDetailOpen(false);
      setSelectedProduct(null);
      setCheckoutOpen(false);
    };
    window.addEventListener("peppro:close-dialogs", closeAllDialogs);
    return () =>
      window.removeEventListener("peppro:close-dialogs", closeAllDialogs);
  }, []);

  const loginWithRetry = async (
    email: string,
    password: string,
    attempt = 0,
    context?: "checkout" | null,
  ): Promise<AuthActionResult> => {
    const loginContextAtStart = context ?? loginContext;
    const startedAt = Date.now();
    console.debug("[Auth] Login attempt", { email, attempt });
    try {
      const user = await authAPI.login(email, password);
      applyLoginSuccessState(user);
      if (loginContextAtStart !== "checkout") {
        void storePasswordCredential(email, password, user.name || email);
      }
      console.debug("[Auth] Login success", {
        userId: user.id,
        visits: user.visits,
      });
      return { status: "success" };
    } catch (error: any) {
      console.warn("[Auth] Login failed", { email, error });
      const message = error.message || "LOGIN_ERROR";
      const errorCode = typeof error?.code === "string" ? error.code : null;

      if (message === "EMAIL_NOT_FOUND") {
        return { status: "email_not_found" };
      }

      if (message === "INVALID_PASSWORD") {
        return { status: "invalid_password" };
      }

      if (message === "SALES_REP_ACCOUNT_REQUIRED") {
        return { status: "sales_rep_signup_required", message };
      }

      const statusCode =
        typeof error?.status === "number" ? error.status : null;
      const normalizedMessage =
        typeof message === "string" ? message.toUpperCase() : "";
      const isNetworkError =
        message === "Failed to fetch" ||
        normalizedMessage.includes("LOAD FAILED") ||
        normalizedMessage.includes("NETWORKERROR") ||
        normalizedMessage.includes("NETWORK_ERROR");
      const isServerError = statusCode !== null && statusCode >= 500;
      const isTimeout = errorCode === "TIMEOUT" || normalizedMessage.includes("TIMED OUT");
      const elapsedMs = Date.now() - startedAt;

      if (isTimeout || isNetworkError) {
        return { status: "error", message: "NETWORK_UNAVAILABLE" };
      }

      if (attempt === 0 && isServerError && statusCode !== null && [502, 503, 504].includes(statusCode) && elapsedMs < 4000) {
        console.warn(
          "[Auth] Transient login failure detected, retrying immediately after health ping",
          {
            email,
            statusCode,
            message,
          },
        );
        // Fire-and-forget a health ping to wake cold starts, but don't block the retry.
        void checkServerHealth().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
        return loginWithRetry(email, password, attempt + 1, loginContextAtStart);
      }

      if (
        message === "Invalid credentials" ||
        message === "INVALID_CREDENTIALS"
      ) {
        try {
          const result = await authAPI.checkEmail(email);
          return result.exists
            ? { status: "invalid_password" }
            : { status: "email_not_found" };
        } catch (lookupError: any) {
          return { status: "email_not_found" };
        }
      }

      if (message === "EMAIL_REQUIRED") {
        return { status: "error", message };
      }

      return { status: "error", message };
    }
  };

  // Login function connected to backend
  const resetLandingNpiState = useCallback(() => {
    landingNpiCheckIdRef.current += 1;
    setLandingNpiStatus("idle");
    setLandingNpiMessage("");
    landingNpiRecordRef.current = null;
  }, []);

  const handleLandingNpiInputChange = useCallback((rawValue: string) => {
    const digits = (rawValue || "").replace(/[^0-9]/g, "").slice(0, 10);
    if (digits.length < 10) {
      console.debug("[NPI] Waiting for 10 digits before verification", {
        digits,
      });
      landingNpiCheckIdRef.current += 1;
      setLandingNpiStatus("idle");
      setLandingNpiMessage("");
      landingNpiRecordRef.current = null;
      return;
    }

    const checkId = Date.now();
    landingNpiCheckIdRef.current = checkId;
    console.debug("[NPI] Verifying against CMS registry", {
      npiNumber: digits,
      checkId,
    });
    setLandingNpiStatus("checking");
    setLandingNpiMessage("");

    authAPI
      .verifyNpi(digits)
      .then((record: any) => {
        if (landingNpiCheckIdRef.current !== checkId) {
          return;
        }
        console.debug("[NPI] Verified successfully", { npiNumber: digits });
        const derivedName = (() => {
          if (record?.name && typeof record.name === "string") {
            return record.name.trim();
          }
          const basic = record?.raw?.basic;
          if (basic) {
            const parts = [basic.first_name, basic.middle_name, basic.last_name]
              .map((part: string | undefined) => part?.trim())
              .filter(Boolean);
            if (parts.length) {
              return parts.join(" ");
            }
          }
          return null;
        })();
        const resolvedRecord = record ?? {};
        landingNpiRecordRef.current = {
          ...resolvedRecord,
          name:
            derivedName ??
            (typeof resolvedRecord.name === "string"
              ? resolvedRecord.name
              : null),
          verifiedNpiNumber: digits,
        };
        setLandingNpiStatus("verified");
        setLandingNpiMessage("NPI verified with the CMS registry.");
      })
      .catch((error: any) => {
        if (landingNpiCheckIdRef.current !== checkId) {
          return;
        }
        console.warn("[NPI] Verification failed", { npiNumber: digits, error });
        const message = describeNpiErrorMessage(error?.message);
        setLandingNpiStatus("rejected");
        setLandingNpiMessage(message);
        landingNpiRecordRef.current = null;
      });
  }, []);

  const updateLandingAuthMode = useCallback(
    (mode: "login" | "signup" | "forgot" | "reset") => {
      setLandingAuthMode((previous) => {
        if (previous === mode) {
          return previous;
        }
        if (mode !== "reset") {
          clearResetRoute();
          setResetPasswordToken(null);
          setResetPasswordValue("");
          setResetPasswordConfirmValue("");
          setResetPasswordSuccess("");
          setResetPasswordError("");
        }
        if (mode === "signup") {
          resetLandingNpiState();
        } else {
          setLandingSignupError("");
        }
        if (mode === "login") {
          setLandingLoginError("");
          setShowLandingLoginPassword(false);
          setShowLandingSignupPassword(false);
          setShowLandingSignupConfirm(false);
          setPasswordResetRequestError("");
          setPasswordResetRequestSuccess(false);
          setPasswordResetEmail("");
        }
        if (mode === "forgot") {
          setLandingLoginError("");
          setPasswordResetRequestError("");
          setPasswordResetRequestSuccess(false);
          const fallbackEmail =
            landingLoginEmailRef.current?.value?.trim() || "";
          setPasswordResetEmail((current) => current || fallbackEmail);
        }
        if (mode === "reset") {
          setLandingLoginError("");
          setPasswordResetRequestError("");
          setPasswordResetRequestSuccess(false);
          setResetPasswordError("");
          setResetPasswordSuccess("");
          setResetPasswordToken(
            (current) => current ?? readResetTokenFromLocation(),
          );
        }
        return mode;
      });
    },
    [clearResetRoute, resetLandingNpiState],
  );

  const handleLogin = (
    email: string,
    password: string,
  ): Promise<AuthActionResult> => {
    return loginWithRetry(email, password, 0);
  };

  // Create account function connected to backend
  const handleCreateAccount = async (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    code: string;
    npiNumber: string;
  }): Promise<AuthActionResult> => {
    console.debug("[Auth] Create account attempt", { email: details.email });
    try {
      const password = (details.password || "").trim();
      const confirmPassword = (details.confirmPassword || "").trim();

      if (!password) {
        return { status: "error", message: "PASSWORD_REQUIRED" };
      }

      if (password !== confirmPassword) {
        return { status: "password_mismatch" };
      }

      const normalizedCode = (details.code || "").trim().toUpperCase();

      if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(normalizedCode)) {
        return { status: "invalid_referral_code" };
      }

      const normalizedNpi = (details.npiNumber || "").replace(/\D/g, "");
      if (normalizedNpi && !/^\d{10}$/.test(normalizedNpi)) {
        return { status: "invalid_npi" };
      }

      if (normalizedNpi) {
        const verifiedRecord = landingNpiRecordRef.current;
        if (
          !verifiedRecord ||
          verifiedRecord.verifiedNpiNumber !== normalizedNpi
        ) {
          return {
            status: "error",
            message: "Please verify your NPI before continuing.",
          };
        }
        if (
          verifiedRecord.name &&
          !namesRoughlyMatch(details.name, verifiedRecord.name)
        ) {
          return {
            status: "error",
            message:
              "Ensure your name is exactly as stated on your NPI registry.",
          };
        }
      }

      const user = await authAPI.register({
        name: details.name,
        email: details.email,
        password,
        code: normalizedCode,
        npiNumber: normalizedNpi || undefined,
      });
      setUser(user);
      setPostLoginHold(true);
      setIsReturningUser(false);
      // toast.success(`Welcome to PepPro, ${user.name}!`);
      console.debug("[Auth] Create account success", { userId: user.id });
      setLoginContext(null);
      setShowLandingLoginPassword(false);
      setShowLandingSignupPassword(false);
      setShowLandingSignupConfirm(false);
      return { status: "success" };
    } catch (error: any) {
      const status = error?.status ?? "unknown";
      const detailsPayload = error?.details ?? null;
      console.warn("[Auth] Create account failed", {
        email: details.email,
        status,
        message: error?.message,
        details: detailsPayload,
      });
      const message =
        typeof error?.message === "string" && error.message.trim()
          ? error.message.trim()
          : "REGISTER_ERROR";
      if (message === "EMAIL_EXISTS" || message === "User already exists") {
        return { status: "email_exists" };
      }
      if (message === "INVALID_REFERRAL_CODE") {
        return { status: "invalid_referral_code" };
      }
      if (message === "REFERRAL_CODE_NOT_FOUND") {
        return { status: "referral_code_not_found" };
      }
      if (message === "REFERRAL_CODE_UNAVAILABLE") {
        return { status: "referral_code_unavailable" };
      }
      if (message === "SALES_REP_EMAIL_MISMATCH") {
        return { status: "sales_rep_email_mismatch" };
      }
      if (message === "NAME_EMAIL_REQUIRED") {
        return { status: "name_email_required" };
      }
      if (message === "PASSWORD_REQUIRED") {
        return { status: "error", message };
      }
      if (message === "NPI_INVALID") {
        return { status: "invalid_npi" };
      }
      if (message === "NPI_NOT_FOUND") {
        return { status: "npi_not_found" };
      }
      if (message === "NPI_NAME_MISMATCH") {
        return {
          status: "error",
          message:
            "Ensure your name is exactly as stated on your NPI registry.",
        };
      }
      if (message === "NPI_ALREADY_REGISTERED") {
        return { status: "npi_already_registered" };
      }
      if (message === "NPI_LOOKUP_FAILED") {
        return { status: "npi_verification_failed", message };
      }
      return { status: "error", message };
    }
  };

  const handlePasswordResetRequestSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (passwordResetRequestPending) {
      return;
    }
    const email = passwordResetEmail.trim();
    if (!email) {
      setPasswordResetRequestError(
        "Please enter the email associated with your account.",
      );
      return;
    }
    setPasswordResetRequestPending(true);
    setPasswordResetRequestError("");
    setPasswordResetRequestSuccess(false);
    try {
      await passwordResetAPI.request(email);
      setPasswordResetRequestSuccess(true);
    } catch (error: any) {
      const status = typeof error?.status === "number" ? error.status : null;
      const message =
        status && status >= 500
          ? "Password reset service is temporarily unavailable. Please try again in a few minutes."
          : typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Unable to send reset instructions. Please try again.";
      setPasswordResetRequestError(message);
      console.warn("[Auth] Password reset request failed", { status, error });
    } finally {
      setPasswordResetRequestPending(false);
    }
  };

  const handlePasswordResetSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (resetPasswordPending) {
      return;
    }
    setResetPasswordError("");
    setResetPasswordSuccess("");
    const password = resetPasswordValue.trim();
    const confirmPassword = resetPasswordConfirmValue.trim();
    if (!resetPasswordToken) {
      setResetPasswordError(
        "This reset link is invalid or has expired. Please request a new one.",
      );
      return;
    }
    if (!password) {
      setResetPasswordError("Please enter a new password.");
      return;
    }
    if (password !== confirmPassword) {
      setResetPasswordError(
        "Passwords do not match. Please confirm your new password.",
      );
      return;
    }
    setResetPasswordPending(true);
    try {
      await passwordResetAPI.reset(resetPasswordToken, password);
      setResetPasswordSuccess(
        "Your password has been updated. You can now sign in with your new credentials.",
      );
      setResetPasswordValue("");
      setResetPasswordConfirmValue("");
      setPasswordResetToken(null);
      clearResetRoute();
    } catch (error: any) {
      const status = typeof error?.status === "number" ? error.status : null;
      const message =
        status && status >= 500
          ? "We could not verify your reset link because the service is unavailable. Please try again shortly."
          : typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Unable to reset your password. Please request a new link.";
      setResetPasswordError(message);
      console.warn("[Auth] Password reset finalize failed", { status, error });
    } finally {
      setResetPasswordPending(false);
    }
  };

	  const handleLogout = useCallback(() => {
	    console.debug("[Auth] Logout");
	    authAPI.logout();
	    setUser(null);
	    setAccountModalRequest(null);
	    setLoginContext(null);
	    setPostLoginHold(false);
	    setIsReturningUser(false);
	    setCheckoutOpen(false);
	    setShouldReopenCheckout(false);
    setShouldAnimateInfoFocus(false);
    setDoctorSummary(null);
    setDoctorReferrals([]);
    setSalesRepDashboard(null);
    setReferralStatusMessage(null);
    setReferralDataError(null);
    setAdminActionState({ updatingReferral: null, error: null });
    // toast.success('Logged out successfully');
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleForcedLogout = (event?: Event) => {
      const detail = (event as any)?.detail || {};
      const reason =
        typeof detail?.reason === "string" ? detail.reason : "";
      const authCode =
        typeof detail?.authCode === "string" ? detail.authCode : "";

      const forcedByOtherLogin =
        reason === "another_tab_login" ||
        reason === "credentials_used_elsewhere" ||
        authCode === "TOKEN_REVOKED";

      if (forcedByOtherLogin) {
        toast.error(
          "Another login with your credentials has forced your logout. If this wasn't you, reset your password.",
        );
      }

      handleLogout();
    };
    window.addEventListener(
      "peppro:force-logout",
      handleForcedLogout as EventListener,
    );
    return () => {
      window.removeEventListener(
        "peppro:force-logout",
        handleForcedLogout as EventListener,
      );
    };
  }, [handleLogout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!user?.id) {
      setIsIdle(false);
      return;
    }

    const idleThresholdMs = 10_000;
    const idleLogoutMs = 60 * 60 * 1000;
    const sessionMaxMs = 24 * 60 * 60 * 1000;
    const sessionStartedAtKey = "peppro_session_started_at_v1";
    let sessionStartedAt = Date.now();
    try {
      const raw = window.sessionStorage.getItem(sessionStartedAtKey);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        sessionStartedAt = parsed;
      } else {
        window.sessionStorage.setItem(sessionStartedAtKey, String(sessionStartedAt));
      }
    } catch {
      // ignore
    }

    lastActivityAtRef.current = Date.now();
    idleLogoutFiredRef.current = false;
    sessionLogoutFiredRef.current = false;
    setIsIdle(false);

	    const markActivity = () => {
	      lastActivityAtRef.current = Date.now();
	      idleLogoutFiredRef.current = false;
	      setIsIdle(false);
	      const now = Date.now();
	      const throttleMs = 15_000;
	      if (now - lastPresenceInteractionPingAtRef.current < throttleMs) {
	        return;
	      }
	      lastPresenceInteractionPingAtRef.current = now;
	      try {
	        void settingsAPI
	          .pingPresence({ kind: "interaction", isIdle: false })
	          .catch(() => undefined);
	      } catch {
	        // ignore
	      }
	    };

    const checkIdle = () => {
      const sessionAgeMs = Date.now() - sessionStartedAt;
      if (sessionAgeMs >= sessionMaxMs) {
        if (!sessionLogoutFiredRef.current) {
          sessionLogoutFiredRef.current = true;
          toast.info("Session expired. Please sign in again.");
          handleLogout();
        }
        return;
      }
      const idleForMs = Date.now() - lastActivityAtRef.current;
      if (idleForMs >= idleLogoutMs) {
        if (!idleLogoutFiredRef.current) {
          idleLogoutFiredRef.current = true;
          handleLogout();
        }
        return;
      }
      const nextIsIdle = idleForMs >= idleThresholdMs;
      if (isIdleRef.current !== nextIsIdle) {
        isIdleRef.current = nextIsIdle;
        setIsIdle(nextIsIdle);
        if (nextIsIdle) {
          try {
            void settingsAPI
              .pingPresence({ kind: "heartbeat", isIdle: true })
              .catch(() => undefined);
          } catch {
            // ignore
          }
        }
        return;
      }
      setIsIdle(nextIsIdle);
    };

    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "wheel",
      "touchstart",
      "touchmove",
      "focus",
    ];
    events.forEach((evt) => window.addEventListener(evt, markActivity, { passive: true }));
    // `scroll` doesn't bubble, and many scroll containers won't trigger `window` scroll events.
    // Capture scroll events on the document so scrolling anywhere counts as activity.
    document.addEventListener("scroll", markActivity, { passive: true, capture: true });
    const interval = window.setInterval(checkIdle, 1_000);
    window.setTimeout(checkIdle, 200);

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, markActivity));
      document.removeEventListener("scroll", markActivity, true);
      window.clearInterval(interval);
    };
	  }, [user?.id, handleLogout]);

		  useEffect(() => {
		    if (typeof window === "undefined") return;
		    if (!user?.id || postLoginHold) {
		      lastPresenceHeartbeatPingAtRef.current = 0;
		      lastPresenceInteractionPingAtRef.current = 0;
		      return;
		    }

		    let cancelled = false;
		    const heartbeatMs = 30_000;

		    const sendHeartbeat = () => {
		      if (cancelled) return;
		      if (!isOnline() || !isPageVisible()) return;
		      const now = Date.now();
		      const throttleMs = Math.max(10_000, Math.floor(heartbeatMs * 0.75));
		      if (now - lastPresenceHeartbeatPingAtRef.current < throttleMs) return;
		      lastPresenceHeartbeatPingAtRef.current = now;
		      try {
		        void settingsAPI
		          .pingPresence({
		            kind: "heartbeat",
		            isIdle: isIdleRef.current,
		          })
		          .catch(() => undefined);
		      } catch {
		        // ignore
		      }
		    };

		    // Ping immediately, then keep-alive. Also ping on visibility/connection changes
		    // to reduce false-offline blips when a tab resumes after being backgrounded.
		    sendHeartbeat();
		    const jitterMs = Math.floor(Math.random() * 1500);
		    const id = window.setInterval(sendHeartbeat, heartbeatMs);
		    const warmupId = window.setTimeout(sendHeartbeat, 1000 + jitterMs);
		    const onlineId = window.setTimeout(sendHeartbeat, 2500 + jitterMs);

		    const handleVisibility = () => {
		      if (!isPageVisible()) return;
		      sendHeartbeat();
		    };
		    const handleOnline = () => sendHeartbeat();
		    document.addEventListener("visibilitychange", handleVisibility);
		    window.addEventListener("online", handleOnline);
		    window.addEventListener("focus", handleOnline);

		    return () => {
		      cancelled = true;
		      window.clearInterval(id);
		      window.clearTimeout(warmupId);
		      window.clearTimeout(onlineId);
		      document.removeEventListener("visibilitychange", handleVisibility);
		      window.removeEventListener("online", handleOnline);
		      window.removeEventListener("focus", handleOnline);
		    };
		  }, [user?.id, postLoginHold]);

	  useEffect(() => {
	    if (typeof window === "undefined") return;
	    if (!user) return;

    let cancelled = false;
    const intervalMs = 5_000;

    const checkSession = async () => {
      if (cancelled) return;
      if (!isOnline() || !isPageVisible()) return;
      try {
        const current = await authAPI.getCurrentUser();
        if (!current && !cancelled) {
          handleLogout();
        }
      } catch {
        // Ignore transient network/server failures; keep the user signed in.
      }
    };

    const interval = window.setInterval(() => {
      void checkSession();
    }, intervalMs);

    // Run one check shortly after mount so stale sessions resolve quickly.
    window.setTimeout(() => void checkSession(), 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user?.id, handleLogout]);

  const buildCartItemId = (productId: string, variantId?: string | null) =>
    variantId ? `${productId}::${variantId}` : productId;

  const handleAddToCart = (
    productId: string,
    quantity = 1,
    note?: string,
    variantId?: string | null,
  ) => {
    console.debug("[Cart] Add to cart requested", {
      productId,
      quantity,
      note,
      variantId,
    });
    const product = catalogProducts.find((item) => item.id === productId);
    if (!product) return;

    if (variantId === "__peppro_needs_variant__") {
      variantId = null;
    }

    const isVariable = (product.type ?? "").toLowerCase() === "variable";
    if (isVariable && (!product.variants || product.variants.length === 0)) {
      console.debug("[Cart] Variant required, opening product details", {
        productId,
      });
      setSelectedProduct(product);
      setProductDetailOpen(true);
      void ensureCatalogProductHasVariants(product);
      return;
    }

    const quantityToAdd = Math.max(1, Math.floor(quantity));
    let resolvedVariant: ProductVariant | null = null;

    if (product.variants?.length) {
      resolvedVariant = variantId
        ? (product.variants.find((variant) => variant.id === variantId) ?? null)
        : (product.variants.find((variant) => variant.inStock) ??
          product.variants[0] ??
          null);

      if (!resolvedVariant) {
        console.warn(
          "[Cart] Variant selection required, opening product details",
          { productId, variantId },
        );
        setSelectedProduct(product);
        setProductDetailOpen(true);
        void ensureCatalogProductHasVariants(product);
        return;
      }
    }

    const cartItemId = buildCartItemId(productId, resolvedVariant?.id ?? null);

    setCartItems((prev) => {
      const existingItem = prev.find((item) => item.id === cartItemId);
      if (existingItem) {
        return prev.map((item) =>
          item.id === cartItemId
            ? {
                ...item,
                quantity: item.quantity + quantityToAdd,
                note: note ?? item.note,
              }
            : item,
        );
      }
      return [
        ...prev,
        {
          id: cartItemId,
          product,
          quantity: quantityToAdd,
          note,
          variant: resolvedVariant,
        },
      ];
    });

    console.debug("[Cart] Add to cart success", {
      productId,
      variantId: resolvedVariant?.id,
      quantity: quantityToAdd,
    });
  };

  const handleBuyOrderAgain = (order: AccountOrderSummary) => {
    if (!order?.lineItems || order.lineItems.length === 0) {
      console.debug("[Cart] Buy again ignored, no line items", {
        orderId: order?.id,
      });
      return;
    }

    void (async () => {
      const nextCart: CartItem[] = [];
    const addOrMergeCartItem = (
      product: Product,
      variant: ProductVariant | null,
      quantity: number,
    ) => {
      const cartItemId = buildCartItemId(product.id, variant?.id ?? null);
      const existing = nextCart.find((item) => item.id === cartItemId);
      if (existing) {
        existing.quantity += quantity;
        return;
      }
      nextCart.push({
        id: cartItemId,
        product,
        quantity,
        variant: variant ?? undefined,
      });
    };

    for (const line of order.lineItems) {
      const qty = Math.max(1, Math.floor(line.quantity ?? 1));
      const sku = (line.sku ?? "").trim();
      const rawName = (line.name ?? "").trim();
      const normalizedName = rawName.toLowerCase();
      let matchedProduct: Product | undefined;
      let matchedVariant: ProductVariant | null = null;

      const wooProductId = Number(line.productId ?? NaN);
      const wooVariationId = Number(line.variantId ?? NaN);

      if (Number.isFinite(wooProductId)) {
        matchedProduct =
          catalogProducts.find((product) => product.wooId === wooProductId) ??
          catalogProducts.find((product) => product.id === `woo-${wooProductId}`);

        if (matchedProduct) {
          matchedProduct = await ensureCatalogProductHasVariants(matchedProduct);
          if (Number.isFinite(wooVariationId) && matchedProduct.variants?.length) {
            matchedVariant =
              matchedProduct.variants.find(
                (variant) => variant.wooId === wooVariationId,
              ) ?? null;
          }
          if (!matchedVariant && sku && matchedProduct.variants?.length) {
            matchedVariant =
              matchedProduct.variants.find(
                (variant) => (variant.sku || "").trim() === sku,
              ) ?? null;
          }
        }
      }

      if (!matchedProduct && sku) {
        matchedProduct = catalogProducts.find(
          (product) => (product.sku || "").trim() === sku,
        );
      }

      if (!matchedProduct && sku) {
        for (const product of catalogProducts) {
          if (!product.variants?.length) continue;
          const variant =
            product.variants.find((v) => (v.sku || "").trim() === sku) ?? null;
          if (variant) {
            matchedProduct = product;
            matchedVariant = variant;
            break;
          }
        }
      }

      // Fallback: match based on name, handling patterns like
      // "Product Name — 40mg" where base name matches product and
      // trailing segment matches variant label/attributes.
      if (!matchedProduct && normalizedName) {
        let baseNameRaw = rawName;
        let variantLabelRaw: string | null = null;
        const separatorMatch = rawName.match(/\s[–—-]\s/);
        if (separatorMatch && typeof separatorMatch.index === "number") {
          const idx = separatorMatch.index;
          baseNameRaw = rawName.slice(0, idx).trim();
          variantLabelRaw = rawName
            .slice(idx + separatorMatch[0].length)
            .trim();
        }
        const baseName = baseNameRaw.toLowerCase();
        const variantLabel = variantLabelRaw
          ? variantLabelRaw.toLowerCase()
          : null;

        // Exact match on full name first.
        matchedProduct = catalogProducts.find(
          (product) => product.name.trim().toLowerCase() === normalizedName,
        );

        // Then exact match on base name.
        if (!matchedProduct && baseName) {
          matchedProduct = catalogProducts.find(
            (product) => product.name.trim().toLowerCase() === baseName,
          );
        }

        // Finally, prefix match on base name (to tolerate minor differences).
        if (!matchedProduct && baseName) {
          matchedProduct = catalogProducts.find((product) =>
            product.name.trim().toLowerCase().startsWith(baseName),
          );
        }

        if (matchedProduct && (matchedProduct.type ?? "").toLowerCase() === "variable") {
          matchedProduct = await ensureCatalogProductHasVariants(matchedProduct);
        }

        if (matchedProduct && variantLabel && matchedProduct.variants?.length) {
          const variants = matchedProduct.variants;
          const normalizedLabel = variantLabel;
          // 1) Exact label match.
          matchedVariant =
            variants.find(
              (v) => v.label.trim().toLowerCase() === normalizedLabel,
            ) ??
            // 2) Label contains the variant text.
            variants.find((v) =>
              v.label.trim().toLowerCase().includes(normalizedLabel),
            ) ??
            // 3) Any attribute value matches/contains the variant text.
            variants.find((v) =>
              (v.attributes ?? []).some(
                (attr) =>
                  attr.value.trim().toLowerCase() === normalizedLabel ||
                  attr.value.trim().toLowerCase().includes(normalizedLabel),
              ),
            ) ??
            null;
        }
      }

      // If we still don't have a product match, skip this line.
      if (!matchedProduct) {
        console.debug("[Cart] Buy again line skipped, no product match", {
          sku,
          name: line.name,
        });
        continue;
      }

      if ((matchedProduct.type ?? "").toLowerCase() === "variable") {
        matchedProduct = await ensureCatalogProductHasVariants(matchedProduct);
      }

      // If product has variants but none matched, fall back to a sensible default.
      if (
        !matchedVariant &&
        matchedProduct.variants?.length
      ) {
        matchedVariant =
          matchedProduct.variants.find((variant) => variant.inStock) ??
          matchedProduct.variants[0] ??
          null;
      }

      addOrMergeCartItem(matchedProduct, matchedVariant, qty);
    }

    if (nextCart.length === 0) {
      console.debug("[Cart] Buy again produced empty cart", {
        orderId: order.id,
      });
      return;
    }

    console.debug("[Cart] Buy again cart rebuilt", {
      orderId: order.id,
      items: nextCart.length,
    });
    setCartItems(nextCart);
    setCheckoutOpen(true);
    toast.info("Order loaded into a new cart.");
    })();
  };

  const handleRefreshNews = async () => {
    beginNewsLoading();
    setPeptideNewsError(null);
    const startedAt = Date.now();

    try {
      const data = await newsAPI.getPeptideHeadlines();
      const items = Array.isArray(data?.items)
        ? data.items
            .map((item: any) => ({
              title: typeof item?.title === "string" ? item.title.trim() : "",
              url: typeof item?.url === "string" ? item.url.trim() : "",
              summary:
                typeof item?.summary === "string" && item.summary.trim()
                  ? item.summary.trim()
                  : undefined,
              image:
                typeof item?.imageUrl === "string" && item.imageUrl.trim()
                  ? item.imageUrl.trim()
                  : undefined,
              date:
                typeof item?.date === "string" && item.date.trim()
                  ? item.date.trim()
                  : undefined,
            }))
            .filter((item) => item.title && item.url)
        : [];

      if (items.length === 0) {
        setPeptideNews([]);
        setPeptideNewsError("No headlines available right now.");
        setPeptideNewsUpdatedAt(new Date());
        return;
      }
      setPeptideNews(items.slice(0, 6));
      setPeptideNewsUpdatedAt(new Date());
    } catch (error) {
      console.warn("[News] Failed to refresh peptide headlines", error);
      setPeptideNewsError("Unable to load peptide news at the moment.");
      setPeptideNews([]);
    } finally {
      settleNewsLoading(startedAt);
    }
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleCheckout = async (options?: {
    shippingAddress: any;
    shippingRate: any;
    shippingTotal: number;
    expectedShipmentWindow?: string | null;
    physicianCertificationAccepted?: boolean;
    taxTotal?: number | null;
    paymentMethod?: string | null;
  }) => {
    console.debug("[Checkout] Attempt", {
      items: cartItems.length,
      shipping: options,
    });
    if (cartItems.length === 0) {
      // toast.error('Your cart is empty');
      return;
    }

    const items = cartItems.map(({ id, product, quantity, note, variant }, index) => {
      const resolvedProductId = product.wooId ?? product.id;
      const resolvedVariantId = variant?.wooId ?? variant?.id ?? null;
      const resolvedSku = (variant?.sku || product.sku || "").trim() || null;
      const unitPrice = computeUnitPrice(product, variant ?? null, quantity, {
        pricingMode: checkoutPricingMode,
      });
      const unitWeightOz = variant?.weightOz ?? product.weightOz ?? null;
      const dimensions = variant?.dimensions || product.dimensions || undefined;
      return {
        cartItemId: id,
        productId: resolvedProductId,
        variantId: resolvedVariantId,
        sku: resolvedSku,
        name: variant ? `${product.name} — ${variant.label}` : product.name,
        price: unitPrice,
        quantity,
        note: note ?? null,
        position: index + 1,
        weightOz: unitWeightOz,
        lengthIn: dimensions?.lengthIn ?? null,
        widthIn: dimensions?.widthIn ?? null,
        heightIn: dimensions?.heightIn ?? null,
      };
    });

	    const itemTotal = items.reduce(
	      (sum, item) => sum + item.price * item.quantity,
	      0,
	    );
	    const taxTotal =
	      typeof options?.taxTotal === "number" && options.taxTotal >= 0
	        ? options.taxTotal
	        : 0;
	    const shippingTotal =
	      typeof options?.shippingTotal === "number" && options.shippingTotal >= 0
	        ? options.shippingTotal
	        : 0;
	    const total = Math.round(
	      (itemTotal + shippingTotal + taxTotal + Number.EPSILON) * 100,
	    ) / 100;

	    try {
	      const response = await ordersAPI.create(
	        items,
	        total,
	        undefined,
	        {
	          address: options?.shippingAddress,
	          estimate: options?.shippingRate,
	          shippingTotal: options?.shippingTotal ?? null,
	        },
	        options?.expectedShipmentWindow ?? null,
	        {
	          physicianCertification:
	            options?.physicianCertificationAccepted === true,
	        },
	        taxTotal,
	        options?.paymentMethod ?? null,
	        checkoutPricingMode,
	      );
	      try {
	        const created = response?.order as any;
	        const pepproOrderId = created?.id ? String(created.id).trim() : null;
	        const wooResp = (response as any)?.integrations?.wooCommerce?.response || null;
	        const wooOrderIdRaw =
	          wooResp?.id ||
	          created?.wooOrderId ||
	          created?.woo_order_id ||
	          null;
	        const wooOrderNumberRaw =
	          wooResp?.number ||
	          wooResp?.id ||
	          created?.wooOrderNumber ||
	          created?.woo_order_number ||
	          created?.wooOrderId ||
	          created?.woo_order_id ||
	          null;
	        const wooOrderId = wooOrderIdRaw ? String(wooOrderIdRaw).trim() : null;
	        const wooOrderNumber = wooOrderNumberRaw ? String(wooOrderNumberRaw).trim() : null;
	        postCheckoutOrderRef.current = {
	          pepproOrderId,
	          wooOrderId,
	          wooOrderNumber,
	          createdAtMs: Date.now(),
	        };

	        if (created && typeof created === "object") {
	          if (!created.wooOrderId && wooOrderId) created.wooOrderId = wooOrderId;
	          if (!created.wooOrderNumber && wooOrderNumber) created.wooOrderNumber = wooOrderNumber;
	        }
		      } catch {
		        postCheckoutOrderRef.current = { pepproOrderId: null, wooOrderId: null, wooOrderNumber: null, createdAtMs: Date.now() };
		      }

	        try {
	          const created = response?.order as any;
	          const meta = postCheckoutOrderRef.current;
	          const wooId = meta?.wooOrderId || null;
	          const wooNumber = meta?.wooOrderNumber || null;
	          const createdAt =
	            created?.createdAt ||
	            created?.created_at ||
            new Date().toISOString();
          const lineItemsRaw = Array.isArray(created?.items) ? created.items : [];
          const lineItems = lineItemsRaw.map((item: any, index: number) => {
            const quantity =
              typeof item?.quantity === "number"
                ? item.quantity
                : Number(item?.quantity) || 0;
            const rawTotal =
              typeof item?.total === "number" ? item.total : Number(item?.total);
            const rawUnitPrice =
              typeof item?.price === "number" ? item.price : Number(item?.price);
            const normalizedTotal =
              Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : null;
            const normalizedUnitPrice =
              Number.isFinite(rawUnitPrice) && rawUnitPrice > 0 ? rawUnitPrice : null;
            let unitPrice =
              normalizedUnitPrice ??
              (normalizedTotal && quantity > 0 ? normalizedTotal / quantity : null);
            let lineTotal =
              normalizedTotal ??
              (typeof unitPrice === "number" && Number.isFinite(unitPrice)
                ? unitPrice * quantity
                : null);

            if (
              quantity > 1 &&
              typeof normalizedTotal === "number" &&
              typeof normalizedUnitPrice === "number" &&
              Math.abs(normalizedTotal - normalizedUnitPrice) < 0.01
            ) {
              unitPrice = normalizedUnitPrice;
              lineTotal = normalizedUnitPrice * quantity;
            }

            return {
              id: String(item?.id || `${created?.id || "order"}-${index}`),
              name: item?.name ?? null,
              quantity,
              total: typeof lineTotal === "number" ? lineTotal : null,
              subtotal: typeof lineTotal === "number" ? lineTotal : null,
              price: typeof unitPrice === "number" ? unitPrice : null,
              sku: item?.sku ?? item?.variantSku ?? null,
              productId: item?.productId ?? null,
              variantId: item?.variantId ?? null,
              image: null,
            };
          });
	          if (!wooId && !wooNumber) {
	            postCheckoutOptimisticOrderRef.current = null;
	            throw new Error("checkout_woo_id_missing");
	          }
	          const optimisticOrder: AccountOrderSummary = {
	            id: wooId ? String(wooId) : String(wooNumber),
	            number: wooNumber ? String(wooNumber) : null,
	            status: String(created?.status || "on-hold"),
	            currency: "usd",
	            total:
	              typeof created?.grandTotal === "number"
	                ? created.grandTotal
                : Number(created?.grandTotal) || Number(created?.total) || null,
            createdAt: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
            updatedAt: null,
            source: "peppro",
            lineItems,
            integrations: created?.integrations ?? null,
            paymentMethod: null,
            paymentDetails: null,
            integrationDetails: created?.integrationDetails ?? null,
            shippingAddress: created?.shippingAddress ?? null,
            billingAddress: created?.billingAddress ?? null,
            shippingEstimate: created?.shippingEstimate ?? null,
            shippingTotal:
              typeof created?.shippingTotal === "number"
                ? created.shippingTotal
                : Number(created?.shippingTotal) || null,
            taxTotal:
              typeof created?.taxTotal === "number"
                ? created.taxTotal
                : Number(created?.taxTotal) || null,
            physicianCertified: Boolean(
              created?.physicianCertificationAccepted ??
                created?.physicianCertified ??
                false,
            ),
	            wooOrderNumber: wooNumber ? String(wooNumber) : null,
	            wooOrderId: wooId ? String(wooId) : null,
	            expectedShipmentWindow: created?.expectedShipmentWindow ?? null,
	          };

          postCheckoutOptimisticOrderRef.current = optimisticOrder;
          setAccountOrders((prev) => {
            const optimisticNumber = optimisticOrder.number
              ? String(optimisticOrder.number).trim()
              : "";
            const optimisticId = String(optimisticOrder.id || "").trim();
            const exists = prev.some((order) => {
              const orderNumber = order.number ? String(order.number).trim() : "";
              const orderId = order.id ? String(order.id).trim() : "";
              return (
                (optimisticNumber && orderNumber && orderNumber === optimisticNumber) ||
                (optimisticId && orderId && orderId === optimisticId)
              );
            });
            if (exists) return prev;
            return [optimisticOrder, ...prev];
          });
        } catch {
          // ignore optimistic order failures
        }

	      await loadAccountOrders().catch(() => undefined);
	      return response;
	    } catch (error: any) {
      console.error("[Checkout] Failed", { error });
      const message =
        error?.message === "Request failed"
          ? "Unable to complete purchase. Please try again."
          : (error?.message ??
            "Unable to complete purchase. Please try again.");
      throw new Error(message);
    }
  };

  const handleRequireLogin = () => {
    console.debug("[Checkout] Require login triggered");
    setCheckoutOpen(false);
    setLoginPromptToken((token) => token + 1);
    setShouldReopenCheckout(true);
    setLoginContext("checkout");
    updateLandingAuthMode("login");
    QueueMicrotask(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  };

  const handleAdvanceFromWelcome = () => {
    console.debug("[Intro] Advance from welcome", { shouldReopenCheckout });
    setPostLoginHold(false);
    if (shouldReopenCheckout) {
      setCheckoutOpen(true);
      setShouldReopenCheckout(false);
    }
  };

  const handleUpdateCartItemQuantity = (
    cartItemId: string,
    quantity: number,
  ) => {
    console.debug("[Cart] Update quantity", { cartItemId, quantity });
    const normalized = Math.max(1, Math.floor(quantity || 1));
    setCartItems((prev) =>
      prev.map((item) =>
        item.id === cartItemId ? { ...item, quantity: normalized } : item,
      ),
    );
  };

  const handleRemoveCartItem = (cartItemId: string) => {
    console.debug("[Cart] Remove item", { cartItemId });
    setCartItems((prev) => prev.filter((item) => item.id !== cartItemId));
    // toast.success('Item removed from cart');
  };

  const submitReferralWithRetry = async (
    payload: {
      contactName: string;
      contactEmail?: string;
      contactPhone?: string;
      notes?: string;
    },
    attempt = 0,
  ): Promise<void> => {
    try {
      await referralAPI.submitDoctorReferral(payload);
    } catch (error: any) {
      const statusCode =
        typeof error?.status === "number" ? error.status : null;
      const message = typeof error?.message === "string" ? error.message : "";
      const normalizedMessage = message.toUpperCase();
      const isNetworkError =
        message === "Failed to fetch" ||
        normalizedMessage.includes("NETWORKERROR") ||
        normalizedMessage.includes("NETWORK_ERROR");
      const isServerError = statusCode !== null && statusCode >= 500;

      if (attempt === 0 && (isNetworkError || isServerError)) {
        console.warn(
          "[Referral] Transient submission failure detected, warming API then retrying",
          {
            statusCode,
            message,
          },
        );
        try {
          await Promise.race([
            checkServerHealth(),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        } catch {
          // ignore health check failures and continue to retry once
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        await submitReferralWithRetry(payload, attempt + 1);
        return;
      }

      throw error;
    }
  };

  const handleSubmitReferral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user || !isDoctorRole(user.role)) {
      return;
    }

    if (!referralForm.contactName.trim()) {
      setReferralStatusMessage({
        type: "error",
        message: "Please provide the doctor’s name before submitting.",
      });
      return;
    }

    try {
      setReferralSubmitting(true);
      setReferralStatusMessage(null);
	      await submitReferralWithRetry({
	        contactName: referralForm.contactName.trim(),
	        contactEmail: referralForm.contactEmail.trim() || undefined,
	        contactPhone: referralForm.contactPhone.trim() || undefined,
	        notes: normalizeNotesValue(referralForm.notes) || undefined,
	      });
      setReferralStatusMessage({
        type: "success",
        message: "Referral sent to your representative.",
      });
      setReferralForm({
        contactName: "",
        contactEmail: "",
        contactPhone: "",
        notes: "",
      });
      setReferralSearchTerm("");
      await tracedRefreshReferralData("doctor-referral-submit", {
        showLoading: true,
      });
    } catch (error: any) {
      console.warn("[Referral] Submission failed", error);
      setReferralStatusMessage({
        type: "error",
        message: "Unable to submit referral. Please try again.",
      });
    } finally {
      setReferralSubmitting(false);
    }
  };

  const handleUpdateReferralStatus = async (
    referralId: string,
    nextStatus: string,
  ) => {
    if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
      return;
    }

    try {
      setAdminActionState((prev) => ({
        ...prev,
        updatingReferral: referralId,
        error: null,
      }));
      const response = await referralAPI.updateReferral(referralId, {
        status: nextStatus,
      });
      setSalesRepDashboard((prev) => {
        if (!prev) {
          return prev;
        }
        const updatedReferral = response?.referral;
        const statuses =
          (response?.statuses as string[] | undefined) ?? prev.statuses;
        if (!updatedReferral) {
          return { ...prev, statuses };
        }
        const updatedReferrals = prev.referrals.map((item) =>
          item.id === updatedReferral.id ? updatedReferral : item,
        );
        return {
          ...prev,
          referrals: updatedReferrals,
          statuses,
        };
      });
      await tracedRefreshReferralData("referral-status-update", {
        showLoading: true,
      });
    } catch (error: any) {
      console.warn("[Referral] Update referral status failed", error);
      setAdminActionState((prev) => ({
        ...prev,
        error:
          typeof error?.message === "string" && error.message
            ? error.message
            : "Unable to update referral status. Please try again.",
      }));
    } finally {
      setAdminActionState((prev) => ({ ...prev, updatingReferral: null }));
    }
  };

  const handleDeleteManualProspect = useCallback(
    async (referralId: string) => {
      if (
        !window.confirm(
          "Delete this manual prospect? This will remove them permanently.",
        )
      ) {
        return;
      }
      try {
        setAdminActionState((prev) => ({
          ...prev,
          updatingReferral: referralId,
          error: null,
        }));
        await referralAPI.deleteManualProspect(referralId);
        toast.success("Manual prospect deleted.");
        await tracedRefreshReferralData("manual-prospect-delete", {
          showLoading: false,
        });
      } catch (error: any) {
        console.error("[Referral] Manual prospect delete failed", error);
        const message =
          typeof error?.message === "string" && error.message
            ? error.message
            : "Unable to delete manual prospect right now.";
        setAdminActionState((prev) => ({ ...prev, error: message }));
        toast.error(message);
      } finally {
        setAdminActionState((prev) => ({
          ...prev,
          updatingReferral: null,
        }));
      }
    },
    [tracedRefreshReferralData],
  );

  const renderDoctorDashboard = () => {
    if (!user || !isDoctorRole(user.role)) {
      return null;
    }

    const lifetimeCredits = doctorSummary?.totalCredits ?? 0;
    const availableCreditsDisplay =
      doctorSummary?.availableCredits ?? Number(user.referralCredits ?? 0);
    const firstOrderBonuses = doctorSummary?.firstOrderBonuses ?? 0;
    const totalReferrals = user.totalReferrals ?? doctorReferrals.length ?? 0;
    const ledgerEntries = doctorSummary?.ledger ?? [];
    const processedCredits = (() => {
      if (!ledgerEntries.length) {
        return [] as Array<typeof ledgerEntries[number] & { isUsed?: boolean }>;
      }
      const credits = ledgerEntries
        .filter(
          (entry) =>
            (entry.direction || "credit").toLowerCase() === "credit" &&
            Number(entry.amount) > 0,
        )
        .map((entry) => ({
          entry,
          remaining: Number(entry.amount) || 0,
          isUsed: false,
        }));
      if (!credits.length) {
        return [] as Array<typeof ledgerEntries[number] & { isUsed?: boolean }>;
      }
      const chronologicalCredits = credits
        .slice()
        .sort(
          (a, b) =>
            new Date(a.entry.issuedAt).getTime() -
            new Date(b.entry.issuedAt).getTime(),
        );
      const debitEntries = ledgerEntries
        .filter(
          (entry) =>
            (entry.direction || "").toLowerCase() === "debit" &&
            Number(entry.amount) > 0,
        )
        .sort(
          (a, b) =>
            new Date(a.issuedAt).getTime() - new Date(b.issuedAt).getTime(),
        );
      debitEntries.forEach((debit) => {
        let toConsume = Math.abs(Number(debit.amount) || 0);
        if (toConsume <= 0) {
          return;
        }
        for (const credit of chronologicalCredits) {
          if (credit.remaining <= 0) {
            continue;
          }
          const consume = Math.min(credit.remaining, toConsume);
          credit.remaining -= consume;
          toConsume -= consume;
          if (credit.remaining <= 1e-9) {
            credit.isUsed = true;
          }
          if (toConsume <= 1e-9) {
            break;
          }
        }
      });
      return credits.map(({ entry, isUsed }) => ({
        ...entry,
        isUsed,
      }));
    })();
    const recentLedger = processedCredits
      .slice()
      .sort(
        (a, b) =>
          new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime(),
      )
      .slice(0, 5);

    const renderReferralHubTrigger = (expanded: boolean) => {
      const baseTriggerClasses =
        "group glass-card referral-pill squircle-xl flex w-full items-center justify-between gap-4 pr-5 py-4 text-left transition-all";
      const triggerClasses = expanded
        ? `${baseTriggerClasses} shadow-md`
        : `${baseTriggerClasses} shadow-[0_18px_48px_-28px_rgba(95,179,249,0.8)] hover:shadow-[0_20px_52px_-24px_rgba(95,179,249,0.85)]`;

      return (
        <button
          type="button"
          className={triggerClasses}
          onClick={() => setIsReferralSectionExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? "Collapse Referral Rewards Hub"
              : "Expand Referral Rewards Hub"
          }
	          style={{
	            borderWidth: "2px",
	            borderColor: "var(--brand-glass-border-2)",
	            paddingLeft: "1rem",
	            borderRadius: "var(--squircle-xl)",
	          }}
	        >
          <div className="flex items-center gap-6 flex-shrink-0 pl-4 ml-2">
	            <div
	              className={`flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-all duration-300 group-hover:bg-slate-200 ${
	                expanded ? "shadow-inner" : ""
	              }`}
		            >
		              <ChevronRight
		                className="h-4 w-4"
		                style={{
		                  transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
		                  transition: "transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
		                  transformOrigin: "center",
		                }}
		              />
            </div>
            <div className="hidden sm:block">
              <p className="text-sm font-semibold text-slate-700">
                Referral Rewards Hub
              </p>
              <p className="text-xs text-slate-500">
                Invite doctors & track credited referrals
              </p>
            </div>
          </div>

          <div className="flex flex-1 items-center justify-end gap-2">
            <svg
              className="w-5 h-5 text-slate-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
              />
            </svg>
            <p className="text-lg font-medium text-slate-700">
              Refer your colleagues
            </p>
          </div>
        </button>
      );
    };

    const renderExpandedContent = () => (
      <div
        className="overflow-hidden transition-all duration-500 ease-in-out"
        style={{
          maxHeight: isReferralSectionExpanded ? "5000px" : "0",
          opacity: isReferralSectionExpanded ? 1 : 0,
        }}
      >
        <div
          className="px-4 sm:px-8 lg:px-16 pb-8 space-y-8 squircle-xl"
          style={{ padding: "1rem 1rem 1rem" }}
        >
          {referralDataError && (
            <div className="px-4 py-3 text-sm text-red-700">
              <div className="flex items-center justify-center gap-2">
                <svg
                  className="w-4 h-4 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
	                <span>{referralDataError}</span>
		                  </div>
			                  </div>
	          )}

          <div className="glass squircle-lg p-4 sm:p-6 lg:p-8 mx-0 sm:mx-5 shadow-sm space-y-6">
            <form
              className="glass-strong squircle-md p-3 sm:p-5 space-y-3 w-full"
              onSubmit={handleSubmitReferral}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="referral-contact-name"
                  >
                    Colleague Name *
                  </label>
                  <input
                    id="referral-contact-name"
                    type="text"
                    required
                    value={referralForm.contactName}
                    onChange={(event) =>
                      setReferralForm((prev) => ({
                        ...prev,
                        contactName: event.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="referral-contact-email"
                  >
                    Email
                  </label>
                  <input
                    id="referral-contact-email"
                    type="email"
                    value={referralForm.contactEmail}
                    onChange={(event) =>
                      setReferralForm((prev) => ({
                        ...prev,
                        contactEmail: event.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="referral-contact-phone"
                  >
                    Phone
                  </label>
                  <input
                    id="referral-contact-phone"
                    type="tel"
                    value={referralForm.contactPhone}
                    onChange={(event) =>
                      setReferralForm((prev) => ({
                        ...prev,
                        contactPhone: event.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="referral-notes"
                  >
                    Notes
                  </label>
                  <textarea
                    id="referral-notes"
                    value={referralForm.notes}
                    onChange={(event) =>
                      setReferralForm((prev) => ({
                        ...prev,
                        notes: event.target.value,
                      }))
                    }
                    className="w-full min-h-[70px] rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
              <div className="pt-1 flex w-full justify-end">
                <div className="inline-flex flex-col items-start gap-3 text-left sm:flex-nowrap sm:flex-row sm:items-center sm:justify-end sm:text-right">
                  <p className="text-sm text-slate-600 max-w-[28ch] sm:max-w-[26ch]">
                    Your representative will credit you $50 each time
                    your new referee has completed their first checkout.
                  </p>
                  <Button
                    type="submit"
                    disabled={referralSubmitting}
                    className="glass-brand squircle-sm transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                  >
                    {referralSubmitting ? "Submitting…" : "Submit Referral"}
                  </Button>
                  {referralStatusMessage && (
                    <span
                      className={`text-sm ${referralStatusMessage.type === "success" ? "text-emerald-600" : "text-red-600"}`}
                    >
                      {referralStatusMessage.message}
                    </span>
                  )}
                </div>
              </div>
            </form>
          </div>

          <div className="mt-8 grid gap-6 md:grid-cols-2 w-full max-w-none px-1 sm:px-5">
            <div className="glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-8 shadow-xl space-y-6 w-full max-w-none">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-10 w-10 items-center justify-center squircle-sm bg-emerald-100">
                    <svg
                      className="w-5 h-5 text-emerald-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Your Referrals
                  </h3>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                      Total Referrals
                    </p>
                    <p className="text-lg font-bold text-emerald-600">
                      {totalReferrals}
                    </p>
                  </div>
                  {referralDataLoading && (
                    <span className="text-xs text-slate-500 flex items-center gap-1">
                      <svg
                        className="animate-spin h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Loading…
                    </span>
                  )}
                </div>
              </div>
              {doctorReferrals.length === 0 ? (
                <div className="text-center py-8 glass-strong squircle-md">
                  <div className="flex justify-center mb-3">
                    <div className="flex h-12 w-12 items-center justify-center squircle-sm bg-slate-100">
                      <svg
                        className="w-6 h-6 text-slate-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                        />
                      </svg>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600">No referrals yet</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Submit your first referral above to get started
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="referral-toolbar">
                    <div className="referral-toolbar__search">
                      <input
                        type="search"
                        value={referralSearchTerm}
                        onChange={(event) =>
                          setReferralSearchTerm(event.target.value)
                        }
                        placeholder="Search by name or email"
                        aria-label="Search referrals"
                        className="referral-search-input"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleReferralSortToggle}
                      aria-pressed={referralSortOrder === "desc"}
                      className="referral-sort-toggle"
                    >
                      <ArrowUpDown className="h-4 w-4 mr-2" />
                      {sortDirectionLabel}
                    </Button>
                  </div>
                  <div className="referrals-table-scroll">
                    <div className="referrals-table-container glass-card squircle-xl">
                      {filteredDoctorReferrals.length === 0 ? (
                        <div className="referrals-empty-state">
                          <p className="text-sm text-slate-600">
                            No referrals match your search.
                          </p>
                          <p className="text-xs text-slate-500 mt-1">
                            Try adjusting your filters or search terms.
                          </p>
                        </div>
                      ) : (
                        <div
                          className="referrals-table"
                          role="table"
                          aria-label="Your referrals"
                        >
                          <div className="referrals-table__header" role="row">
                            <span role="columnheader">Colleague</span>
                            <span role="columnheader">Submitted</span>
                            <span role="columnheader">Status</span>
                            <span role="columnheader">Actions</span>
                          </div>
                          <div
                            className="referrals-table__body"
                            role="rowgroup"
                          >
                            {filteredDoctorReferrals.map((referral) => {
                              const creditedEntry =
                                creditedDoctorLedgerEntries.get(referral.id);
                              const rawStatusLabel = humanizeReferralStatus(
                                referral.status ?? "pending",
                              );
                              const referralStatusLabel = creditedEntry
                                ? "Credited"
                                : rawStatusLabel;
                              const awaitingCredit =
                                !creditedEntry &&
                                rawStatusLabel === "Converted";
                              const isPendingStatus =
                                sanitizeReferralStatus(referral.status) ===
                                "pending";
                              return (
                                <div
                                  key={referral.id}
                                  className="referrals-table__row"
                                  role="row"
                                >
                                  <div
                                    className="referrals-table__cell"
                                    role="cell"
                                    data-label="Colleague"
                                  >
                                    <div className="referral-contact">
                                      <span className="referral-contact__name">
                                        {referral.referredContactName}
                                      </span>
                                      {(referral.referredContactEmail ||
                                        referral.referredContactPhone) && (
                                        <span className="referral-contact__meta">
                                          {referral.referredContactEmail ||
                                            referral.referredContactPhone}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div
                                    className="referrals-table__cell referrals-table__cell--date"
                                    role="cell"
                                    data-label="Submitted"
                                  >
                                    <span className="referral-date">
                                      {formatDate(referral.createdAt)}
                                    </span>
                                    <span className="referral-date-updated">
                                      Updated{" "}
                                      {formatDateTime(
                                        referral.updatedAt ??
                                          referral.createdAt,
                                      )}
                                    </span>
                                  </div>
                                  <div
                                    className="referrals-table__cell"
                                    role="cell"
                                    data-label="Status"
                                  >
                                    <div className="flex flex-col items-start">
                                      <span className="referral-status-badge">
                                        {referralStatusLabel}
                                      </span>
                                      {awaitingCredit && (
                                        <span className="text-xs text-amber-600 font-medium mt-1">
                                          Awaiting credit
                                        </span>
                                      )}
                                      {referral.notes && (
                                        <p className="text-xs text-slate-500 mt-2 max-w-[220px]">
                                          {referral.notes}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  <div
                                  className="referrals-table__cell referrals-table__cell--actions"
                                  role="cell"
                                  data-label="Actions"
                                >
                                    {isPendingStatus ? (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() =>
                                          handleDeleteDoctorReferral(referral.id)
                                        }
                                        disabled={
                                          doctorDeletingReferralId === referral.id
                                        }
                                      >
                                        {doctorDeletingReferralId === referral.id
                                          ? "Deleting…"
                                          : "Delete"}
                                      </Button>
                                    ) : (
                                      <span className="text-xs text-slate-500">
                                        Cannot delete after the Pending status.
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-8 shadow-xl min-w-0 space-y-6 w-full max-w-none">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-10 w-10 items-center justify-center squircle-sm bg-amber-100">
                    <svg
                      className="w-5 h-5 text-amber-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Your Credits
                  </h3>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-4 text-right">
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                      Total Credits
                    </p>
                    <p className="text-lg font-bold text-emerald-600">
                      ${lifetimeCredits.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                      Available Credits
                    </p>
                    <p className="text-lg font-bold text-[rgb(95,179,249)]">
                      ${availableCreditsDisplay.toFixed(2)}
                    </p>
                  </div>
                  {recentLedger.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                      <svg
                        className="w-4 h-4"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {recentLedger.length} recent
                    </span>
                  )}
                </div>
              </div>

              {recentLedger.length === 0 ? (
                <div className="text-center py-8 glass-strong squircle-md">
                  <div className="flex justify-center mb-3">
                    <div className="flex h-12 w-12 items-center justify-center squircle-sm bg-slate-100">
                      <svg
                        className="w-6 h-6 text-slate-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                        />
                      </svg>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600">
                    No credit activity yet
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Credits appear after your referrals place their first order
                  </p>
                </div>
              ) : (
                <ul className="space-y-4">
                  {recentLedger.map((entry) => {
                    const metadata = (entry.metadata || {}) as Record<
                      string,
                      unknown
                    >;
                    const referralContactName =
                      typeof metadata.referralContactName === "string"
                        ? (metadata.referralContactName as string)
                        : null;
                    const entryDescription = referralContactName
                      ? `Credited for ${referralContactName}`
                      : entry.description || "Credit applied";
                    const isUsed = Boolean((entry as any).isUsed);
                    const amountClasses = isUsed
                      ? "text-lg font-bold text-slate-500 line-through decoration-slate-400"
                      : "text-lg font-bold text-emerald-600";
                    const descriptionClasses = isUsed
                      ? "text-sm text-slate-500 leading-relaxed"
                      : "text-sm text-slate-600 leading-relaxed";
                    return (
                      <li
                        key={entry.id}
                        className={`group relative glass-strong squircle-md px-6 py-6 shadow-sm transition-all hover:shadow-md ${
                          isUsed ? "bg-slate-50/90 text-slate-500" : ""
                        }`}
                      >
                        <div className="relative flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 mb-1">
                              <span className={amountClasses}>
                                ${entry.amount.toFixed(2)}
                              </span>
                            </div>
                            <p className={descriptionClasses}>
                              {entryDescription}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            {isUsed && (
                              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                                Used
                              </span>
                            )}
                            <span className="text-xs font-medium text-slate-500 whitespace-nowrap">
                              {formatDate(entry.issuedAt)}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    );

    return (
      <section className="grid gap-6 mb-16 mt-0">
        <div
          className={`glass-card squircle-xl referral-pill-wrapper transition-all duration-500 ${
            isReferralSectionExpanded
              ? "pb-8 shadow-[0_30px_80px_-65px_rgba(95,179,249,0.8)]"
              : "shadow-[0_18px_48px_-28px_rgba(95,179,249,0.8)] hover:shadow-[0_20px_52px_-24px_rgba(95,179,249,0.85)]"
          }`}
	          style={{ borderRadius: "var(--squircle-xl)" }}
	        >
          {renderReferralHubTrigger(isReferralSectionExpanded)}
          {renderExpandedContent()}
        </div>
      </section>
    );
  };

	  const renderProductSection = () => {
	    const formattedSearch = searchQuery.trim();
	    const itemLabel =
      filteredProducts.length === 1
        ? "1 item"
        : `${filteredProducts.length} items`;
    const statusChips: {
      key: string;
      label: string;
      tone?: "info" | "warn" | "error";
    }[] = [{ key: "count", label: itemLabel }];
    const showFilters = true;

    if (formattedSearch.length > 0) {
      statusChips.push({
        key: "search",
        label: `Search • “${formattedSearch}”`,
      });
    }
	    if (catalogLoading) {
	      statusChips.push({ key: "loading", label: "loading-icon" });
	    }
	    const retryPending =
	      typeof catalogRetryUntil === "number" && Date.now() < catalogRetryUntil;
		    if (catalogError && !retryPending) {
		      statusChips.push({ key: "error", label: "Store sync issue" });
		    }
      if (!catalogError && catalogTransientIssue && !catalogLoading && retryPending) {
        statusChips.push({ key: "reconnecting", label: "Reconnecting…" });
      }
	    const showSkeletonGrid =
	      (catalogLoading ||
	        (catalogProducts.length === 0 && !catalogEmptyReady) ||
	        retryPending) &&
	      filteredProducts.length === 0;
	    const productSkeletons = Array.from({ length: 6 });

    return (
      <div
        className={`products-layout mt-24${showFilters ? "" : " products-layout--single"}`}
      >
        {/* Filters Sidebar */}
        {showFilters && (
          <div
            ref={filterSidebarRef}
            className="filter-sidebar-container lg:min-w-[18rem] lg:max-w-[24rem] xl:min-w-[20rem] xl:max-w-[26rem] lg:pl-4 xl:pl-6"
          >
            {visibleCatalogCategories.length > 0 ? (
              <CategoryFilter
                categories={visibleCatalogCategories}
                types={[]}
                filters={filters}
                onFiltersChange={setFilters}
                productCounts={productCounts}
                typeCounts={{}}
              />
            ) : (
	              <div
	                className='glass-card squircle-lg px-10 py-8 lg:px-16 lg:py-10 text-sm text-slate-700 text-center font-["Lexend",_var(--font-sans)]'
	                aria-live="polite"
	              >
	                <p className="mx-auto max-w-sm leading-relaxed">
	                  <span className="text-base text-slate-900 block mb-1">
	                    Fetching Products…
	                  </span>
	                  <span className="text-sm text-slate-800 block">
	                    No better time to take a few conscious breaths...
	                  </span>
	                </p>
	              </div>
	            )}
	          </div>
        )}

        {/* Products Grid */}
        <div className="w-full min-w-0 flex-1">
          <div className="flex flex-col gap-3 mb-6 lg:flex-row lg:flex-nowrap lg:items-center">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0 order-2 lg:order-1">
              <h2 className="mr-1">Products</h2>
              <div className="flex flex-wrap items-center gap-2">
                {statusChips.map((chip) => {
                  const isSpinner = chip.label === "loading-icon";
                  return (
                    <span
                      key={chip.key}
                      className={`filter-chip glass-card${chip.tone ? ` filter-chip--${chip.tone}` : ""}`}
                    >
	                      {isSpinner ? (
	                        <RefreshCw
	                          className="h-3 w-3.1 animate-spin text-[rgb(30,41,59)]"
	                          aria-hidden="true"
	                        />
	                      ) : (
	                        <span className="whitespace-nowrap">{chip.label}</span>
	                      )}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:gap-3 ml-auto min-w-[min(100%,220px)] justify-start order-1 lg:order-2 lg:justify-end">
              {totalCartItems > 0 && (
                <Button
                  variant="ghost"
                  onClick={() => setCheckoutOpen(true)}
                  ref={checkoutButtonRef}
                  className="squircle-sm glass-brand shadow-lg shadow-[rgba(95,179,249,0.4)] transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 px-5 py-2 min-w-[8.5rem] justify-center w-full sm:w-auto"
                >
                  <ShoppingCart className="w-4 h-4 mr-2" />
                  Checkout ({totalCartItems})
                </Button>
              )}
            </div>
          </div>

          {showSkeletonGrid ? (
            <div className="grid gap-6 w-full px-4 sm:px-6 lg:px-0 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
              {productSkeletons.map((_, index) => (
                <CatalogSkeletonCard key={`catalog-skeleton-${index}`} />
              ))}
            </div>
	          ) : filteredProducts.length > 0 ? (
	            <div className="grid gap-6 w-full px-4 sm:px-6 lg:px-0 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
		              {filteredProducts.map((product) => (
		                <LazyCatalogProductCard
		                  key={product.id}
		                  product={product}
		                  onEnsureVariants={ensureCatalogProductHasVariants}
		                  onAddToCart={(productId, variationId, qty) =>
		                    handleAddToCart(productId, qty, undefined, variationId)
		                  }
		                />
		              ))}
	            </div>
	          ) : (
	            <div className="catalog-loading-state py-12">
	              <div className="glass-card squircle-lg p-8 max-w-md text-center">
	                <h3 className="mb-2">
	                  {catalogLoading ||
	                  retryPending ||
	                  (catalogProducts.length === 0 && !catalogEmptyReady)
	                    ? "Fetching products…"
	                    : "No products found"}
	                </h3>
	                <p className="text-gray-600">
	                  {catalogLoading ||
	                  retryPending ||
	                  (catalogProducts.length === 0 && !catalogEmptyReady)
		                    ? retryPending
		                      ? "Reconnecting to store…"
		                      : "Please wait while we load the catalog."
		                    : "Try adjusting your filters or search terms."}
	                </p>
	              </div>
	            </div>
	          )}
	        </div>
	      </div>
    );
  };

		  const renderSalesRepDashboard = () => {
		    if (!user || (!isRep(user.role) && !isSalesLead(user.role) && !isAdmin(user.role))) {
		      return null;
		    }

    const referrals = normalizedReferrals;

    const totalReferrals = referrals.length;
    const activeStatuses = new Set(["pending", "contacted", "nuture"]);
	    const activeReferrals = referrals.filter((ref) =>
	      activeStatuses.has((ref.status || "").toLowerCase()),
	    ).length;
	    const convertedReferrals = referrals.filter(
	      (ref) => (ref.status || "").toLowerCase() === "converted",
	    ).length;
	    const hasChartData = salesRepChartData.some((item) => item.count > 0);
	    const adminDashboardPeriodLabel = (() => {
	      const start = salesRepPeriodStart ? formatDate(salesRepPeriodStart) : null;
	      const end = salesRepPeriodEnd ? formatDate(salesRepPeriodEnd) : null;
	      return start && end && start !== "—" && end !== "—"
	        ? `${start} to ${end}`
	        : "All time";
	    })();
	    const handleAdminDashboardPeriodSelect = (range?: DateRange) => {
	      setAdminDashboardPeriodRange(range);
	      if (range?.from && range?.to) {
	        setSalesRepPeriodStart(formatDateInputValue(range.from));
	        setSalesRepPeriodEnd(formatDateInputValue(range.to));
	      }
	    };
	    const adminDashboardRefreshing =
	      salesRepSalesSummaryLoading ||
	      adminTaxesByStateLoading ||
	      adminProductsCommissionLoading;
	
		    return (
		      <section className="glass-card squircle-xl p-4 sm:p-6 shadow-[0_30px_80px_-55px_rgba(95,179,249,0.6)] w-full sales-rep-dashboard">
		        <div className="flex flex-col gap-6">
		          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
		            <div>
		              <h2 className="text-xl font-semibold text-slate-900">
		                {isAdmin(user?.role)
		                  ? "Admin Dashboard"
		                  : isSalesLead(user?.role)
		                    ? "Sales Lead Dashboard"
		                    : "Sales Rep Dashboard"}
		              </h2>
              <p className="text-sm text-slate-600">
                {isAdmin(user?.role)
                  ? "Monitor PepPro business activities, sales reps, and keep track of your sales."
                  : "Develop your leads and sales."}
              </p>
	            </div>
	            {isAdmin(user?.role) && (
	              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
		                <a
		                  href="https://shop.peppro.net/wp-admin/"
		                  target="_blank"
		                  rel="noopener noreferrer"
		                  className="inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-900 transition-colors hover:border-[rgba(95,179,249,0.65)] hover:bg-white sm:w-auto"
		                  title="Open Woocommerce dashboard"
		                >
	                    <img
	                      src="/logos/woocommerce.svg"
	                      alt=""
	                      aria-hidden="true"
	                      className="h-5 w-5"
	                      loading="lazy"
	                      decoding="async"
	                    />
		                  <span>Woocommerce dashboard</span>
		                </a>
                  <a
                    href={shipStationDashboardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-900 transition-colors hover:border-[rgba(95,179,249,0.65)] hover:bg-white sm:w-auto"
                    title="Open ShipStation Dashboard"
                  >
                    <img
                      src="/logos/shipstation.svg"
                      alt=""
                      aria-hidden="true"
                      className="h-5 w-5"
                      loading="lazy"
                      decoding="async"
                    />
                    <span>ShipStation Dashboard</span>
                  </a>
	              </div>
		            )}
		          </div>

		          {(isRep(user?.role) || isSalesLead(user?.role)) && (
		            <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
		              <div className="flex flex-col gap-2">
		                <div>
		                  <h4 className="text-base font-semibold text-slate-900">Live clients</h4>
		                  <p className="text-sm text-slate-600">
		                    {isSalesLead(user?.role)
		                      ? "All doctors and sales reps (online, idle, and offline)."
		                      : "Your doctors (online, idle, and offline)."}
		                  </p>
		                </div>
	
	                {liveClientsError && (
	                  <div className="px-4 py-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md">
	                    {liveClientsError}
	                  </div>
	                )}
	
	                {liveClientsLoading ? (
	                  <div className="px-4 py-3 text-sm text-slate-500">
	                    Loading live clients…
	                  </div>
	                ) : (() => {
		                  const normalizedQuery = liveClientsSearch.trim().toLowerCase();
		                  const filtered = (liveClients || []).filter((entry: any) => {
		                    const simulated = (entry as any)?.isSimulated === true;
		                    const id = String((entry as any)?.id || "");
		                    if (simulated || id.startsWith("pseudo-live-")) {
		                      return false;
		                    }
		                    if (isSalesLead(user?.role) && salesLeadLiveUsersRoleFilter !== "all") {
		                      const role = String(entry?.role || "").toLowerCase().trim();
		                      if (salesLeadLiveUsersRoleFilter === "sales_rep") {
		                        if (
		                          ![
		                            "sales_rep",
		                            "salesrep",
		                            "rep",
		                            "sales_lead",
		                            "saleslead",
		                            "sales-lead",
		                          ].includes(role)
		                        ) {
		                          return false;
		                        }
		                      } else if (salesLeadLiveUsersRoleFilter === "doctor") {
		                        if (role !== "doctor") {
		                          return false;
		                        }
		                      } else if (salesLeadLiveUsersRoleFilter === "test_doctor") {
		                        if (role !== "test_doctor") {
		                          return false;
		                        }
		                      } else if (role !== salesLeadLiveUsersRoleFilter) {
		                        return false;
		                      }
		                    }
		                    if (!liveClientsShowOffline && !Boolean(entry?.isOnline)) {
		                      return false;
		                    }
		                    if (!normalizedQuery) {
		                      return true;
	                    }
	                    const haystack = [entry?.name, entry?.email, entry?.id]
	                      .filter(Boolean)
	                      .join(" ")
	                      .toLowerCase();
	                    return haystack.includes(normalizedQuery);
	                  });

	                  const getLastSeenMs = (entry: any) => {
	                    if (!entry) return 0;
	                    const isOnlineNow = Boolean(entry?.isOnline);
	                    const idleReported = Boolean(entry?.isIdle);
	                    if (isOnlineNow && !idleReported) {
	                      return Date.now();
	                    }
	                    const raw =
	                      entry?.lastInteractionAt ||
	                      entry?.lastSeenAt ||
	                      entry?.lastActivityAt ||
	                      entry?.lastActiveAt ||
	                      entry?.lastLoginAt ||
	                      null;
	                    if (!raw) return 0;
	                    const parsed = new Date(raw).getTime();
	                    return Number.isFinite(parsed) ? parsed : 0;
	                  };

	                  const liveUsers = [...filtered].sort((a: any, b: any) => {
	                    const aLast = getLastSeenMs(a);
	                    const bLast = getLastSeenMs(b);
	                    if (aLast !== bLast) return bLast - aLast;
	                    const aName = String(a?.name || a?.email || a?.id || "").toLowerCase();
	                    const bName = String(b?.name || b?.email || b?.id || "").toLowerCase();
	                    return aName.localeCompare(bName);
	                  });

	                  const onlineCount = liveUsers.filter((u: any) => Boolean(u?.isOnline)).length;

	                  return (
	                    <div className="space-y-3">
		                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-1">
		                        <div className="flex flex-wrap items-center gap-3">
		                          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
		                            <input
		                              type="checkbox"
		                              className="brand-checkbox"
		                              checked={liveClientsShowOffline}
		                              onChange={(e) => setLiveClientsShowOffline(e.target.checked)}
		                            />
		                            Show offline
		                          </label>
		                          <span className="text-xs text-slate-500">
		                            {onlineCount} online
		                          </span>
		                          {isSalesLead(user?.role) && (
		                            <label className="flex items-center gap-2 text-xs text-slate-600">
		                              <span className="uppercase tracking-wide text-[11px] text-slate-500">
		                                Type
		                              </span>
		                              <select
		                                value={salesLeadLiveUsersRoleFilter}
		                                onChange={(e) => setSalesLeadLiveUsersRoleFilter(e.target.value)}
		                                className="rounded-md border border-slate-200/80 bg-white/95 px-2 py-1 text-xs font-medium text-slate-700 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
		                              >
		                                <option value="all">All</option>
		                                <option value="sales_rep">Sales Rep</option>
		                                <option value="doctor">Doctors</option>
		                                <option value="test_doctor">Test doctors</option>
		                              </select>
		                            </label>
		                          )}
		                        </div>
		                        <input
		                          value={liveClientsSearch}
		                          onChange={(e) => setLiveClientsSearch(e.target.value)}
		                          onKeyDown={(e) => {
	                            if (e.key === "Enter") {
	                              e.preventDefault();
	                            }
	                          }}
		                          placeholder={isSalesLead(user?.role) ? "Search users…" : "Search clients…"}
		                          className="w-full sm:w-[260px] rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
		                        />
	                      </div>

	                      <div
	                        className={`sales-rep-table-wrapper ${liveUsers.length === 0 ? "" : "live-users-scroll"}`}
	                      >
	                        <div className="flex w-full min-w-0 flex-col gap-2">
		                          {liveUsers.length === 0 ? (
		                            <div className="px-3 py-3 text-sm text-slate-500">
		                              {isSalesLead(user?.role) ? "No users found." : "No clients found."}
		                            </div>
	                          ) : (
	                            <div className="flex w-full min-w-[900px] flex-col gap-2">
		                          {liveUsers.map((entry: any) => {
		                        const avatarUrl = entry.profileImageUrl || null;
		                        const displayName = entry.name || entry.email || "Doctor";
		                        const resolveLastSeenMs = () => {
		                          const raw =
		                            entry?.lastInteractionAt ||
		                            entry?.lastSeenAt ||
		                            entry?.lastActivityAt ||
		                            entry?.lastActiveAt ||
		                            entry?.lastLoginAt ||
		                            null;
		                          if (!raw) return null;
		                          const parsed = new Date(raw).getTime();
		                          return Number.isFinite(parsed) ? parsed : null;
		                        };
		                        const lastSeenMs = resolveLastSeenMs();
		                        const minutesSinceLastSeen =
		                          lastSeenMs != null
		                            ? Math.max(0, (Date.now() - lastSeenMs) / 60000)
		                            : null;
			                        const IDLE_AFTER_MINUTES = 2;
			                        const onlineReported = Boolean(entry.isOnline);
			                        const idleReported = Boolean(entry.isIdle);
			                        const isOnlineNow = onlineReported;
			                        const showIdle =
			                          isOnlineNow &&
			                          (idleReported ||
			                            (minutesSinceLastSeen != null &&
		                              minutesSinceLastSeen >= IDLE_AFTER_MINUTES));
			                        const role = String(entry?.role || "").toLowerCase().trim();
			                        const rolePill = (() => {
			                          if (role === "admin") {
			                            return {
			                              label: "Admin",
			                              style: {
			                                backgroundColor: "rgb(61,43,233)",
			                                color: "#ffffff",
			                              } as React.CSSProperties,
			                            };
			                          }
			                          if (role === "sales_rep" || role === "salesrep" || role === "rep") {
			                            return {
			                              label: "Sales Rep",
			                              style: {
			                                backgroundColor: "rgb(129,221,228)",
			                                color: "#ffffff",
			                              } as React.CSSProperties,
			                            };
			                          }
			                          if (role === "sales_lead" || role === "saleslead" || role === "sales-lead") {
			                            return {
			                              label: "Sales Lead",
			                              style: {
			                                backgroundColor: "rgb(129,221,228)",
			                                color: "#ffffff",
			                              } as React.CSSProperties,
			                            };
			                          }
			                          if (role === "doctor") {
			                            return {
			                              label: "Doctor",
			                              style: {
			                                backgroundColor: "rgb(95,179,249)",
			                                color: "#ffffff",
			                              } as React.CSSProperties,
			                            };
			                          }
			                          if (role === "test_doctor") {
			                            return {
			                              label: "Test Doctor",
			                              style: {
			                                backgroundColor: "rgb(95,179,249)",
			                                color: "#ffffff",
			                              } as React.CSSProperties,
			                            };
			                          }
			                          return null;
			                        })();

			                        const idleMinutesLabel = showIdle ? formatIdleMinutes(entry) : null;
			                        const formatOfflineFor = (value?: string | null) => {
			                          const raw = formatRelativeMinutes(value);
			                          if (raw === "a few moments ago") return "a few moments";
			                          return raw.replace(/\s+ago$/, "");
			                        };
			                        const offlineAnchor =
			                          entry?.lastSeenAt || entry?.lastInteractionAt || entry?.lastLoginAt || null;
			                        const statusLine = isOnlineNow
			                          ? showIdle
			                            ? `Idle${idleMinutesLabel ? ` (${idleMinutesLabel})` : ""} - ${formatOnlineDuration(entry.lastLoginAt)}`
			                            : formatOnlineDuration(entry.lastLoginAt)
			                          : offlineAnchor
			                            ? `Offline for ${formatOfflineFor(offlineAnchor)}`
			                            : "Offline";

			                        return (
		                          <div
		                            key={entry.id}
		                            className="flex w-full items-center gap-3 rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2"
		                          >
			                            <button
			                              type="button"
			                              onClick={() => openLiveUserDetail(entry)}
			                              aria-label={`Open ${displayName} profile`}
			                              className="min-w-0 flex-1"
			                              style={{ background: "transparent", border: "none", padding: 0 }}
			                            >
			                              <div className="flex items-center gap-3 min-w-0">
			                                <div
			                                  className="rounded-full shrink-0"
			                                  style={{
			                                    width: 41.4,
			                                    height: 41.4,
			                                    minWidth: 41.4,
			                                    boxShadow: !isOnlineNow
			                                      ? undefined
			                                      : showIdle
			                                        ? "0 0 0 1px rgba(255,255,255,1), 0 0 0 4px rgba(148,163,184,1)"
			                                        : "0 0 0 1px rgba(255,255,255,1), 0 0 0 4px rgba(95,179,249,1)",
			                                  }}
			                                >
			                                  <div className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm w-full h-full transition hover:shadow-md hover:border-slate-300">
			                                    {avatarUrl ? (
			                                      <img
			                                        src={avatarUrl}
			                                        alt={displayName}
			                                        className="h-full w-full object-cover"
			                                        loading="lazy"
			                                        decoding="async"
			                                      />
			                                    ) : (
			                                      <span className="text-[11px] font-semibold text-slate-600">
			                                        {getInitials(displayName)}
			                                      </span>
			                                    )}
			                                  </div>
			                                </div>
			                                <div className="min-w-0 flex-1 overflow-hidden">
			                                  <div className="flex flex-col items-start gap-0.5 text-left">
			                                    {rolePill && (
			                                      <span
			                                        className="inline-flex items-center squircle-xs px-2 py-[2px] text-sm font-semibold shrink-0 self-start whitespace-nowrap"
			                                        style={rolePill.style}
			                                      >
			                                        {rolePill.label}
			                                      </span>
			                                    )}
			                                    <span className="text-sm font-semibold text-slate-800 whitespace-nowrap">
			                                      {displayName}
			                                    </span>
			                                    <span className="text-sm text-slate-600 whitespace-nowrap">
			                                      {entry.email || "—"}
			                                    </span>
			                                    <span className="text-sm text-slate-600 whitespace-nowrap">
			                                      {statusLine}
			                                    </span>
			                                  </div>
			                                </div>
			                              </div>
			                            </button>
		                          </div>
		                        );
			                          })}
	                            </div>
		                          )}
		                    </div>
	                  </div>
	                </div>
	                  );
	                })()}
	              </div>
		            </div>
		          )}

		          {isSalesLead(user?.role) && (
		            <div className="mt-6">
		              <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
		                <div className="flex flex-col gap-3 mb-4">
		                  <div className="sales-rep-header-row flex w-full flex-col gap-3">
			                    <div className="min-w-0">
			                      <h3 className="text-lg font-semibold text-slate-900">
			                        Sales by Sales Rep
			                      </h3>
			                      <p className="text-sm text-slate-600">
			                        Orders placed by doctors assigned to each rep.
			                      </p>
			                    </div>
				                    <div className="sales-rep-header-actions flex flex-row flex-wrap justify-end gap-4">
				                      <div className="flex items-center gap-2 min-w-0">
				                        <Popover.Root
				                          open={adminDashboardPeriodPickerOpen}
				                          onOpenChange={setAdminDashboardPeriodPickerOpen}
				                        >
				                          <Popover.Trigger asChild>
				                            <Button
				                              type="button"
				                              variant="outline"
				                              size="icon"
				                              className="header-home-button squircle-sm h-9 w-9 shrink-0"
				                              aria-label="Select sales by rep date range"
				                              title="Select date range"
				                            >
				                              <CalendarDays aria-hidden="true" />
				                            </Button>
				                          </Popover.Trigger>
				                          <Popover.Portal>
				                            <Popover.Content
				                              side="bottom"
				                              align="end"
				                              sideOffset={8}
				                              className="calendar-popover z-[10000] w-[320px] glass-liquid rounded-xl border border-white/60 p-3 shadow-xl"
				                            >
				                              <div className="text-sm font-semibold text-slate-800">
				                                Sales by Sales Rep timeframe
				                              </div>
				                              <div className="mt-2">
				                                <DayPicker
				                                  mode="range"
				                                  numberOfMonths={1}
				                                  selected={adminDashboardPeriodRange}
				                                  onSelect={handleAdminDashboardPeriodSelect}
				                                  defaultMonth={adminDashboardPeriodRange?.from ?? undefined}
				                                />
				                              </div>
				                              <div className="mt-3 flex items-center justify-between">
				                                <Button
				                                  type="button"
				                                  variant="ghost"
				                                  size="sm"
				                                  className="text-slate-700"
				                                  onClick={() => {
				                                    const defaults = getDefaultSalesBySalesRepPeriod();
				                                    setSalesRepPeriodStart(defaults.start);
				                                    setSalesRepPeriodEnd(defaults.end);
				                                  }}
				                                >
				                                  Default
				                                </Button>
				                                <Button
				                                  type="button"
				                                  variant="outline"
				                                  size="sm"
				                                  className="calendar-done-button text-[rgb(95,179,249)] border-[rgba(95,179,249,0.45)] hover:border-[rgba(95,179,249,0.7)] hover:text-[rgb(95,179,249)]"
				                                  onClick={() => setAdminDashboardPeriodPickerOpen(false)}
				                                >
				                                  Done
				                                </Button>
				                              </div>
				                              <Popover.Arrow className="calendar-popover-arrow" />
				                            </Popover.Content>
				                          </Popover.Portal>
				                        </Popover.Root>
				                        <span className="text-sm font-semibold text-slate-900 min-w-0 leading-tight truncate">
				                          ({adminDashboardPeriodLabel})
				                        </span>
				                      </div>
				                      <div className="sales-rep-action flex min-w-0 flex-row items-center justify-end gap-2 sm:!flex-col sm:items-end sm:gap-1">
				                        <Button
				                          type="button"
				                          variant="outline"
			                          size="sm"
			                          className="gap-2 order-2 sm:order-1"
			                          onClick={() => void refreshSalesBySalesRepSummary()}
			                          disabled={salesRepSalesSummaryLoading}
			                          aria-busy={salesRepSalesSummaryLoading}
			                          title="Refresh"
			                        >
			                          <RefreshCw
			                            className={`h-4 w-4 ${salesRepSalesSummaryLoading ? "animate-spin" : ""}`}
			                            aria-hidden="true"
			                          />
			                          Refresh
			                        </Button>
			                        <Button
			                          type="button"
			                          variant="outline"
			                          size="sm"
			                          className="gap-2 order-2 sm:order-1"
		                          onClick={downloadSalesBySalesRepCsv}
		                          disabled={salesRepSalesSummary.length === 0}
		                          title="Download CSV"
		                        >
		                          <Download className="h-4 w-4" aria-hidden="true" />
		                          Download CSV
		                        </Button>
		                        <span className="sales-rep-action-meta order-1 sm:order-2 min-w-0 text-[11px] text-slate-500 leading-tight text-right">
		                          <span className="sm:hidden block min-w-0 truncate">
		                            Last downloaded:{" "}
		                            {salesRepSalesCsvDownloadedAt
		                              ? new Date(salesRepSalesCsvDownloadedAt).toLocaleString(
		                                  undefined,
		                                  {
		                                    timeZone: "America/Los_Angeles",
		                                  },
		                                )
		                              : "—"}
		                          </span>
		                          <span className="hidden sm:block">
		                            <span className="sales-rep-action-meta-label block">
		                              Last downloaded
		                            </span>
		                            <span className="sales-rep-action-meta-value block">
		                              {salesRepSalesCsvDownloadedAt
		                                ? new Date(
		                                    salesRepSalesCsvDownloadedAt,
		                                  ).toLocaleString(undefined, {
		                                    timeZone: "America/Los_Angeles",
		                                  })
		                                : "—"}
		                            </span>
		                          </span>
		                        </span>
		                      </div>
		                    </div>
		                  </div>

		                  {/* Totals shown inline above list below */}
		                </div>
		                <div
		                  className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar"
		                  role="region"
		                  aria-label="Sales by sales rep list"
		                >
		                  {salesRepSalesSummaryError ? (
		                    <div className="px-4 py-3 text-sm text-amber-700 mb-3 bg-amber-50 border border-amber-200 rounded-md">
		                      {salesRepSalesSummaryError}
		                    </div>
		                  ) : salesRepSalesSummaryLoading ? (
		                    <div className="px-4 py-3 text-sm mb-3 text-slate-500">
		                      Checking sales…
		                    </div>
		                  ) : salesRepSalesSummaryLastFetchedAt === null ? (
		                    <div className="px-4 py-3 text-sm mb-3 text-slate-500">
		                      Click Refresh to load sales.
		                    </div>
		                  ) : salesRepSalesSummary.length === 0 ? (
		                    <div className="px-4 py-3 text-sm text-slate-500">
		                      No sales recorded yet.
		                    </div>
		                  ) : (
		                    <div className="w-full" style={{ minWidth: 920 }}>
		                      {(() => {
		                        const metaTotals = salesRepSalesSummaryMeta?.totals || null;
		                        const totals = metaTotals
		                          ? metaTotals
		                          : {
		                              totalOrders: salesRepSalesSummary.reduce(
		                                (sum, row) => sum + (Number(row.totalOrders) || 0),
		                                0,
		                              ),
		                              totalRevenue: salesRepSalesSummary.reduce(
		                                (sum, row) => sum + (Number(row.totalRevenue) || 0),
		                                0,
		                              ),
		                              wholesaleRevenue: salesRepSalesSummary.reduce(
		                                (sum, row) =>
		                                  sum + (Number(row.wholesaleRevenue) || 0),
		                                0,
		                              ),
		                              retailRevenue: salesRepSalesSummary.reduce(
		                                (sum, row) => sum + (Number(row.retailRevenue) || 0),
		                                0,
		                              ),
		                            };
		                        const hasTotals =
		                          typeof totals.totalOrders === "number" &&
		                          typeof totals.totalRevenue === "number";
		                        if (!hasTotals) return null;
		                        return (
		                          <div className="flex flex-wrap items-center justify-between gap-1 bg-white/70 px-3 py-1.5 text-sm font-semibold text-slate-900 border-b-4 border-slate-200/70">
		                            <span>Total Orders: {totals.totalOrders}</span>
		                            <span>
		                              Wholesale:{" "}
		                              {formatCurrency(Number(totals.wholesaleRevenue) || 0)}
		                            </span>
		                            <span>
		                              Retail:{" "}
		                              {formatCurrency(Number(totals.retailRevenue) || 0)}
		                            </span>
		                          </div>
		                        );
		                      })()}
		                      <div className="w-max">
		                        <div
		                          className="grid w-full items-center gap-2 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700"
		                          style={{
		                            gridTemplateColumns:
		                              "minmax(120px,1fr) minmax(160px,1fr) max-content max-content max-content",
		                          }}
		                        >
		                          <div className="whitespace-nowrap">Sales Rep</div>
		                          <div className="whitespace-nowrap">Email</div>
		                          <div className="whitespace-nowrap text-right">Orders</div>
		                          <div className="whitespace-nowrap text-right">Wholesale</div>
		                          <div className="whitespace-nowrap text-right">Retail</div>
		                        </div>
		                        <ul className="w-full border-x border-b border-slate-200/70 max-h-[420px] overflow-y-auto">
		                          {salesRepSalesSummary.map((rep) => (
		                            <li
		                              key={rep.salesRepId}
		                              className="grid w-full items-center gap-2 px-2 py-1 border-b border-slate-200/70 last:border-b-0"
		                              style={{
		                                gridTemplateColumns:
		                                  "minmax(120px,1fr) minmax(160px,1fr) max-content max-content max-content",
		                              }}
		                            >
		                              <div className="text-sm font-semibold text-slate-900 min-w-0">
		                                <button
		                                  type="button"
		                                  className="min-w-0 text-left hover:underline"
		                                  onClick={() =>
		                                    openLiveUserDetail(
		                                      {
		                                        id: rep.salesRepId,
		                                        name: rep.salesRepName,
		                                        email: rep.salesRepEmail,
		                                        role: "sales_rep",
		                                      },
		                                      {
		                                        salesRepWholesaleRevenue: Number(
		                                          rep.wholesaleRevenue || 0,
		                                        ),
		                                        salesRepRetailRevenue: Number(
		                                          rep.retailRevenue || 0,
		                                        ),
		                                      },
		                                    )
		                                  }
		                                  title="Open sales rep details"
		                                >
		                                  {rep.salesRepName}
		                                </button>
		                              </div>
		                              <div
		                                className="text-sm text-slate-700 truncate"
		                                title={rep.salesRepEmail || ""}
		                              >
		                                {rep.salesRepEmail || "—"}
		                              </div>
		                              <div className="text-sm text-right text-slate-800 tabular-nums whitespace-nowrap">
		                                {rep.totalOrders}
		                              </div>
		                              <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
		                                {formatCurrency(rep.wholesaleRevenue || 0)}
		                              </div>
		                              <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
		                                {formatCurrency(rep.retailRevenue || 0)}
		                              </div>
		                            </li>
		                          ))}
		                        </ul>
		                      </div>
		                    </div>
		                  )}
		                </div>
		              </div>
		            </div>
		          )}

		          {adminActionState.error && (
		            <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
		              {adminActionState.error}
		            </p>
	          )}

	          {isAdmin(user?.role) && (
	            <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
                <div className="mb-6 rounded-xl border border-slate-200/70 bg-white/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-base font-semibold text-slate-900">
                        Server Health
                      </h4>
                      <p className="text-sm text-slate-600">
                        Quick usage snapshot (load, memory, disk).
                      </p>
                    </div>
                    <div className="flex-shrink-0">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void fetchServerHealth({ force: true })}
                        disabled={serverHealthLoading}
                        className="gap-2"
                        title="Refresh server health"
                      >
                        <RefreshCw
                          className={`h-4 w-4 ${
                            serverHealthLoading ? "animate-spin" : ""
                          }`}
                        />
                        Refresh
                      </Button>
                    </div>
                  </div>

                  {serverHealthError && (
                    <div className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-4 py-2">
                      {serverHealthError}
                    </div>
                  )}

	                  <div className="sales-rep-table-wrapper admin-dashboard-list">
	                    <div className="flex w-max flex-nowrap gap-2 text-xs sm:w-full sm:flex-wrap">
                      {(() => {
	                      const usage = serverHealthPayload?.usage || null;
                      const cpu = usage?.cpu || null;
                      const mem = usage?.memory || null;
                      const disk = usage?.disk || null;
                      const cgroupMem = serverHealthPayload?.cgroup?.memory || null;
                      const uptime = serverHealthPayload?.uptime || null;
                      const queue = serverHealthPayload?.queue || null;
                      const cpuUsageLabel =
                        typeof cpu?.usagePercent === "number" &&
                        Number.isFinite(cpu.usagePercent)
                          ? `CPU usage: ${cpu.usagePercent}%`
                          : null;
                      const cpuLoadLabel =
                        cpu?.loadPercent !== null && cpu?.loadPercent !== undefined
                          ? `CPU load: ${cpu.loadPercent}%`
                          : cpu?.loadAvg
                            ? `Load avg: ${cpu.loadAvg["1m"] ?? "—"}`
                            : "CPU load: —";
                      const memLabel =
                        mem?.usedPercent !== null && mem?.usedPercent !== undefined
                          ? `Memory: ${mem.usedPercent}%`
                          : typeof mem?.availableMb === "number" && typeof mem?.totalMb === "number"
                            ? `Memory: ${(100 - (mem.availableMb / mem.totalMb) * 100).toFixed(0)}%`
                          : "Memory: —";
                      const diskLabel =
                        disk?.usedPercent !== null && disk?.usedPercent !== undefined
                          ? `Disk: ${disk.usedPercent}%`
                          : "Disk: —";
                      const cgroupLabel = (() => {
                        if (
                          typeof cgroupMem?.usedPercent === "number" &&
                          Number.isFinite(cgroupMem.usedPercent)
                        ) {
                          return `CGroup mem: ${cgroupMem.usedPercent}%`;
                        }
                        if (
                          typeof cgroupMem?.usageMb === "number" &&
                          Number.isFinite(cgroupMem.usageMb) &&
                          typeof cgroupMem?.limitMb === "number" &&
                          Number.isFinite(cgroupMem.limitMb) &&
                          cgroupMem.limitMb > 0
                        ) {
                          return `CGroup mem: ${cgroupMem.usageMb.toFixed(0)}/${cgroupMem.limitMb.toFixed(0)} MB`;
                        }
                        return null;
                      })();
                      const rssLabel = (() => {
                        const rss =
                          usage?.process?.maxRssMb ?? usage?.process?.rssMb ?? null;
                        if (typeof rss === "number" && Number.isFinite(rss)) {
                          return `App RSS: ${rss.toFixed(0)} MB`;
                        }
                        return "App RSS: —";
                      })();
                      const mysqlLabel = (() => {
                        const enabled = serverHealthPayload?.mysql?.enabled;
                        if (typeof enabled === "boolean") {
                          return enabled ? "MySQL: enabled" : "MySQL: disabled";
                        }
                        return null;
                      })();
                      const queueLabel = (() => {
                        const length = queue?.length;
                        if (typeof length === "number" && Number.isFinite(length)) {
                          return `Queue: ${length}`;
                        }
                        return null;
                      })();
                      const uptimeLabel = (() => {
                        const seconds = uptime?.serviceSeconds;
                        if (typeof seconds === "number" && Number.isFinite(seconds)) {
                          const mins = Math.floor(seconds / 60);
                          if (mins < 60) return `Backend uptime: ${mins}m`;
                          const hours = Math.floor(mins / 60);
                          const remMins = mins % 60;
                          if (hours < 24) return `Backend uptime: ${hours}h ${remMins}m`;
                          const days = Math.floor(hours / 24);
                          const remHours = hours % 24;
                          return `Backend uptime: ${days}d ${remHours}h`;
                        }
                        return null;
                      })();
                      const buildLabel = serverHealthPayload?.build
                        ? `Build: ${serverHealthPayload.build}`
                        : null;
                      const tsLabel = serverHealthPayload?.timestamp
                        ? `Updated: ${new Date(serverHealthPayload.timestamp).toLocaleTimeString()}`
                        : null;
                      const workerLabel = (() => {
                        const workers = serverHealthPayload?.workers;
                        const detected = workers?.detected;
                        const configured = workers?.configured;
                        if (typeof detected === "number" && detected > 0) {
                          return `Backend workers: ${detected}${configured ? ` (target ${configured})` : ""}`;
                        }
                        if (typeof configured === "number" && configured > 0) {
                          return `Backend workers: target ${configured}`;
                        }
                        return null;
                      })();
                      const gunicornLabel = (() => {
                        const gunicorn = serverHealthPayload?.workers?.gunicorn;
                        if (!gunicorn) return null;
                        const parts: string[] = [];
                        if (typeof gunicorn.workers === "number") parts.push(`${gunicorn.workers}w`);
                        if (typeof gunicorn.threads === "number") parts.push(`${gunicorn.threads}t`);
                        if (typeof gunicorn.timeoutSeconds === "number") parts.push(`timeout ${gunicorn.timeoutSeconds}s`);
                        return parts.length ? `Gunicorn: ${parts.join(" ")}` : null;
                      })();

                      const pills = [
                        cpuUsageLabel,
                        cpuLoadLabel,
                        memLabel,
                        diskLabel,
                        cgroupLabel,
                        rssLabel,
                        workerLabel,
                        gunicornLabel,
                        queueLabel,
                        mysqlLabel,
                        uptimeLabel,
                        buildLabel,
                        tsLabel,
                      ].filter(
                        (x): x is string => typeof x === "string" && x.trim().length > 0,
                      );
                      return pills.map((label) => (
                        <span
                          key={label}
                          className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-slate-700"
                        >
                          {label}
                        </span>
                      ));
	                      })()}
	                    </div>
	                  </div>
	                </div>

		                {!certificateUploadsVisible && (
		                  <div className="mb-6 rounded-xl border border-slate-200/70 bg-white/70 p-4">
		                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
		                      <div>
		                        <h4 className="text-base font-semibold text-slate-900">
		                          Certificates of Analysis
		                        </h4>
		                        <p className="text-sm text-slate-600">
		                          {missingCertificatesLoading
		                            ? "Checking certificates…"
		                            : missingCertificatesError
		                              ? "Unable to load certificate status."
		                              : "All products have a certificate. (You can still view/delete/upload replacements.)"}
		                        </p>
		                      </div>
		                      <div className="flex-shrink-0">
		                        <Button
		                          type="button"
		                          variant="outline"
		                          onClick={() => setCertificateUploadsVisible(true)}
		                          className="gap-2"
		                        >
		                          Show certificate uploads
		                        </Button>
		                      </div>
		                    </div>
		                  </div>
		                )}

		                {certificateUploadsVisible && (
		                  <div className="mb-6 rounded-xl border border-slate-200/70 bg-white/70 p-4">
		                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		                      <div>
		                        <h4 className="text-base font-semibold text-slate-900">
		                          Certificates of Analysis
		                        </h4>
		                        <p className="text-sm text-slate-600">
		                          {missingCertificatesError
		                            ? "Unable to load missing certificate count."
		                            : missingCertificates.length > 0
		                              ? `${missingCertificates.length} product${missingCertificates.length === 1 ? "" : "s"} missing a certificate.`
		                              : "All products currently have a certificate."}
		                        </p>
		                      </div>
		                      <div className="flex-shrink-0">
		                        <Button
		                          type="button"
		                          variant="outline"
		                          onClick={() => {
		                            void fetchMissingCertificates({ force: true });
		                            void fetchCertificateProducts({ force: true });
		                          }}
		                          disabled={missingCertificatesLoading || certificateProductsLoading}
		                          className="gap-2"
		                          title="Refresh certificates"
		                        >
		                          <RefreshCw
		                            className={`h-4 w-4 ${
		                              missingCertificatesLoading || certificateProductsLoading
		                                ? "animate-spin"
		                                : ""
		                            }`}
		                          />
		                          Refresh
		                        </Button>
		                      </div>
		                    </div>
		
		                    {(missingCertificatesError || certificateProductsError) && (
		                      <div className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-4 py-2">
		                        {certificateProductsError || missingCertificatesError}
		                      </div>
		                    )}

		                    {certificateProductsLoading && certificateProducts.length === 0 && (
		                      <div className="mt-3 px-4 py-3 text-sm text-slate-500">
		                        Loading products…
		                      </div>
		                    )}
		
		                    {(certificateProducts.length > 0 || missingCertificates.length > 0) && (
		                      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
		                        <div className="flex flex-col gap-1">
		                          <label className="text-xs font-medium text-slate-600">
		                            Product
		                          </label>
		                          <select
		                            value={missingCertificatesSelectedId}
		                            onChange={(e) => {
		                              setMissingCertificatesSelectedId(e.target.value);
		                              setMissingCertificatesSelectedFile(null);
		                            }}
		                            disabled={certificateProductsLoading}
		                            className="w-full rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-sky-200 disabled:opacity-60"
		                          >
		                            {(certificateProducts.length > 0
		                              ? certificateProducts
		                              : (missingCertificates as any)
		                            ).map((product: any) => {
		                              const id = String(product.wooProductId);
		                              const labelParts = [
		                                product.name && String(product.name).trim().length > 0
		                                  ? String(product.name).trim()
		                                  : `Product ${id}`,
		                                product.sku ? `SKU ${product.sku}` : null,
		                                product.hasCertificate ? "Has certificate" : "Missing",
		                              ].filter(
		                                (part): part is string =>
		                                  typeof part === "string" &&
		                                  part.trim().length > 0,
		                              );
		                              return (
		                                <option key={id} value={id}>
		                                  {labelParts.join(" · ")}
		                                </option>
		                              );
		                            })}
		                          </select>
		                        </div>
		
		                        <div className="flex flex-col gap-1">
		                          <div className="flex items-center justify-between gap-2">
		                            <label className="text-xs font-medium text-slate-600">
		                              PNG certificate
		                            </label>
		                            <Button
		                              type="button"
		                              variant="ghost"
		                              size="icon"
		                              onClick={() => void handleDeleteSelectedCertificate()}
		                              disabled={
		                                missingCertificatesDeleting ||
		                                missingCertificatesUploading ||
		                                missingCertificatesInfoLoading ||
		                                !missingCertificatesInfo?.exists
		                              }
		                              title="Delete current certificate"
		                              className="h-8 w-8"
		                            >
		                              <Trash2 className="h-4 w-4 text-slate-700" />
		                            </Button>
		                          </div>
		                          <div className="text-xs text-slate-500">
		                            {missingCertificatesInfoLoading
		                              ? "Current: Loading…"
		                              : missingCertificatesInfoError
		                                ? "Current: —"
		                                : missingCertificatesInfo?.exists
		                                  ? `Current: ${missingCertificatesInfo.filename || "certificate-of-analysis.png"}`
		                                  : "Current: None"}
		                          </div>
		                          <input
		                            type="file"
		                            accept="image/png"
		                            onChange={(e) => {
		                              const file = e.target.files?.[0] ?? null;
		                              setMissingCertificatesSelectedFile(file);
		                            }}
		                            disabled={missingCertificatesUploading}
		                            className="w-full rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
		                          />
		                        </div>
		
		                        <Button
		                          type="button"
		                          onClick={() => void handleUploadMissingCertificate()}
		                          disabled={
		                            missingCertificatesUploading ||
		                            !missingCertificatesSelectedId ||
		                            !missingCertificatesSelectedFile
		                          }
		                          className="gap-2"
		                        >
		                          {missingCertificatesUploading ? (
		                            <Loader2 className="h-4 w-4 animate-spin" />
		                          ) : (
		                            <Upload className="h-4 w-4" />
		                          )}
		                          Upload
		                        </Button>
		                      </div>
		                    )}
		                  </div>
		                )}

		              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
		                <div>
		                  <h3 className="text-lg font-semibold text-slate-900">
		                    Settings
		                  </h3>
			                  <p className="text-sm text-slate-600">
			                    Configure storefront availability.
			                  </p>
		                </div>
	                </div>

		                <div className="mb-4 overflow-hidden rounded-lg border border-slate-200/70 bg-white/70">
		                  <div className="border-b border-slate-200/60 px-4 py-4 last:border-b-0">
		                    <label
		                      className={`flex items-start gap-3 ${isAdmin(user.role) ? "cursor-pointer" : "cursor-not-allowed opacity-80"}`}
		                    >
		                      <input
		                        type="checkbox"
		                        aria-label="Enable Shop for users"
		                        checked={shopEnabled}
		                        onChange={(e) => handleShopToggle(e.target.checked)}
		                        className="brand-checkbox mt-0.5"
		                        disabled={!isAdmin(user.role) || settingsSaving.shop}
		                      />
		                      <span className="min-w-0">
		                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-slate-800">
		                          <span>Shop button for users</span>
		                          <span className="text-xs font-semibold text-slate-500">
		                            (Status:{" "}
		                            {settingsSaving.shop
		                              ? "Saving…"
		                              : shopEnabled
		                                ? "Enabled"
		                                : "Disabled"}
		                            )
		                          </span>
		                        </span>
		                        <span className="block text-xs text-slate-600">
		                          Controls whether doctors see the Shop button.
		                        </span>
		                      </span>
		                    </label>
		                  </div>
		
		                  <div className="border-b border-slate-200/60 px-4 py-4 last:border-b-0">
		                    <label
		                      className={`flex items-start gap-3 ${isAdmin(user.role) ? "cursor-pointer" : "cursor-not-allowed opacity-80"}`}
		                    >
		                      <input
		                        type="checkbox"
		                        aria-label="Enable The Peptide Forum card"
		                        checked={peptideForumEnabled}
		                        onChange={(e) =>
		                          handlePeptideForumToggle(e.target.checked)
		                        }
		                        className="brand-checkbox mt-0.5"
		                        disabled={!isAdmin(user.role) || settingsSaving.forum}
		                      />
		                      <span className="min-w-0">
		                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-slate-800">
		                          <span>The Peptide Forum card</span>
		                          <span className="text-xs font-semibold text-slate-500">
		                            (Status:{" "}
		                            {settingsSaving.forum
		                              ? "Saving…"
		                              : peptideForumEnabled
		                                ? "Enabled"
		                                : "Disabled"}
		                            )
		                          </span>
		                        </span>
		                        <span className="block text-xs text-slate-600">
		                          Shows/hides the forum card on the info page.
		                        </span>
		                      </span>
		                    </label>
		                  </div>
		
		                  <div className="border-b border-slate-200/60 px-4 py-4 last:border-b-0">
		                    <label
		                      className={`flex items-start gap-3 ${isAdmin(user.role) ? "cursor-pointer" : "cursor-not-allowed opacity-80"}`}
		                    >
		                      <input
		                        type="checkbox"
		                        aria-label="Enable Research dashboard for doctors and reps"
		                        checked={researchDashboardEnabled}
		                        onChange={(e) =>
		                          handleResearchDashboardToggle(e.target.checked)
		                        }
		                        className="brand-checkbox mt-0.5"
		                        disabled={
		                          !isAdmin(user.role) ||
		                          settingsSaving.research ||
		                          !settingsSupport.research
		                        }
		                      />
		                      <span className="min-w-0">
		                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-slate-800">
		                          <span>Research dashboard access (doctors/reps)</span>
		                          <span className="text-xs font-semibold text-slate-500">
		                            (Status:{" "}
		                            {settingsSaving.research
		                              ? "Saving…"
		                              : !settingsSupport.research
		                                ? "Unavailable"
		                                : researchDashboardEnabled
		                                  ? "Enabled"
		                                  : "Disabled"}
		                            )
		                          </span>
		                        </span>
		                        <span className="block text-xs text-slate-600">
		                          When disabled, only admins and test doctors see the work-in-progress research dashboard.
		                        </span>
		                      </span>
		                    </label>
		                  </div>

                      <div className="px-4 py-4">
                        <label
                          className={`flex items-start gap-3 ${isAdmin(user.role) ? "cursor-pointer" : "cursor-not-allowed opacity-80"}`}
                        >
                          <input
                            type="checkbox"
                            aria-label="Enable test payments override"
                            checked={testPaymentsOverrideEnabled}
                            onChange={(e) =>
                              handleTestPaymentsOverrideToggle(e.target.checked)
                            }
                            className="brand-checkbox mt-0.5"
                            disabled={!isAdmin(user.role) || settingsSaving.testPaymentsOverride}
                          />
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-slate-800">
                              <span>Test payments override ($0.01)</span>
                              <span className="text-xs font-semibold text-slate-500">
                                (Status:{" "}
                                {settingsSaving.testPaymentsOverride
                                  ? "Saving…"
                                  : testPaymentsOverrideEnabled
                                    ? "Enabled"
                                    : "Disabled"}
                                )
                              </span>
                            </span>
                            <span className="block text-xs text-slate-600">
                              When enabled, admin + test_doctor checkouts using Zelle/bank transfer are forced to $0.01.
                            </span>
                          </span>
                        </label>
                      </div>
		                </div>

                <div className="mt-6 pt-6 border-t border-slate-200/70 space-y-6">
                  <div>
                    <h4 className="text-base font-semibold text-slate-900">
                      Live users
                    </h4>
                    <p className="text-sm text-slate-600">
                      Users currently online or idle.
                    </p>
                  </div>

                  {adminLiveUsersError && (
                    <div className="px-4 py-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md">
                      {adminLiveUsersError}
                    </div>
                  )}

                  {adminLiveUsersLoading ? (
                    <div className="px-4 py-3 text-sm text-slate-500">
                      Loading users…
                    </div>
                  ) : (() => {
                    const visibleUsers = (adminLiveUsers || []).filter((entry: any) => {
                      const simulated = (entry as any)?.isSimulated === true;
                      const id = String((entry as any)?.id || "");
                      return !simulated && !id.startsWith("pseudo-live-");
                    });

                    const isEntryCurrentUser = (entry: any) => {
                      return (
                        (user?.id && entry?.id === user.id) ||
                        (user?.email &&
                          entry?.email &&
                          String(user.email).toLowerCase() ===
                            String(entry.email).toLowerCase())
                      );
                    };

                    const getEntryIdle = (entry: any) => {
                      const entryIdleRaw = entry?.isIdle;
                      if (typeof entryIdleRaw === "boolean") {
                        return entryIdleRaw;
                      }
                      return isEntryCurrentUser(entry) && isIdle;
                    };

	                    const getIdleMinutesLabel = (entry: any) => {
	                      void userActivityNowTick;
	                      const numericMinutes =
	                        typeof entry?.idleMinutes === "number" && Number.isFinite(entry.idleMinutes)
	                          ? entry.idleMinutes
	                          : typeof entry?.idleForMinutes === "number" && Number.isFinite(entry.idleForMinutes)
	                            ? entry.idleForMinutes
	                            : null;
	                      if (numericMinutes != null) {
	                        const safeMinutes = Math.max(0, Math.floor(numericMinutes));
	                        if (safeMinutes < 1) return "<1m";
	                        const diffMs = safeMinutes * 60_000;
	                        const totalSeconds = Math.floor(diffMs / 1000);
	                        const units = [
	                          { label: "y", seconds: 365 * 24 * 60 * 60 },
	                          { label: "mo", seconds: 30 * 24 * 60 * 60 },
	                          { label: "d", seconds: 24 * 60 * 60 },
	                          { label: "h", seconds: 60 * 60 },
	                          { label: "m", seconds: 60 },
	                        ];
	                        let remaining = totalSeconds;
	                        const parts: string[] = [];
	                        for (const unit of units) {
	                          const qty = Math.floor(remaining / unit.seconds);
	                          if (qty > 0) {
	                            parts.push(`${qty}${unit.label}`);
	                            remaining -= qty * unit.seconds;
	                          }
	                          if (parts.length >= 2) break;
	                        }
	                        return parts.length ? parts.join(" ") : "<1m";
	                      }
                      const isCurrent =
                        (user?.id && entry?.id === user.id) ||
                        (user?.email &&
                          entry?.email &&
                          String(user.email).toLowerCase() ===
                            String(entry.email).toLowerCase());
                      const idleSinceMs = isCurrent
                        ? lastActivityAtRef.current
                        : (() => {
                            const raw =
                              entry?.lastInteractionAt ||
                              entry?.lastSeenAt ||
                              entry?.lastActivityAt ||
                              entry?.lastActiveAt ||
                              entry?.lastLoginAt ||
                              null;
                            if (!raw) return null;
                            const parsed = new Date(raw).getTime();
                            return Number.isFinite(parsed) ? parsed : null;
                          })();
	                      if (!idleSinceMs) return null;
	                      const diffMs = Math.max(0, Date.now() - idleSinceMs);
	                      const totalSeconds = Math.floor(diffMs / 1000);
	                      if (totalSeconds < 60) return "<1m";
	                      const units = [
	                        { label: "y", seconds: 365 * 24 * 60 * 60 },
	                        { label: "mo", seconds: 30 * 24 * 60 * 60 },
	                        { label: "d", seconds: 24 * 60 * 60 },
	                        { label: "h", seconds: 60 * 60 },
	                        { label: "m", seconds: 60 },
	                      ];
	                      let remaining = totalSeconds;
	                      const parts: string[] = [];
	                      for (const unit of units) {
	                        const qty = Math.floor(remaining / unit.seconds);
	                        if (qty > 0) {
	                          parts.push(`${qty}${unit.label}`);
	                          remaining -= qty * unit.seconds;
	                        }
	                        if (parts.length >= 2) break;
	                      }
	                      return parts.length ? parts.join(" ") : "<1m";
	                    };

	                    const normalizedQuery = adminLiveUsersSearch.trim().toLowerCase();
	                    const filtered = visibleUsers.filter((entry: any) => {
	                      if (!adminLiveUsersShowOffline) {
		                        const onlineReported = Boolean(entry?.isOnline);
		                        if (!onlineReported && !isEntryCurrentUser(entry)) {
		                          return false;
		                        }
		                      }
		                      const role = String(entry?.role || "").toLowerCase().trim();
		                      if (adminLiveUsersRoleFilter !== "all") {
		                        if (adminLiveUsersRoleFilter === "sales_rep") {
		                          if (!["sales_rep", "salesrep", "rep"].includes(role)) {
	                            return false;
	                          }
	                        } else if (adminLiveUsersRoleFilter === "sales_lead") {
	                          if (!["sales_lead", "saleslead", "sales-lead"].includes(role)) {
	                            return false;
	                          }
	                        } else if (adminLiveUsersRoleFilter === "doctor") {
	                          if (role !== "doctor") {
	                            return false;
	                          }
	                        } else if (adminLiveUsersRoleFilter === "test_doctor") {
                          if (role !== "test_doctor") {
                            return false;
                          }
                        } else if (role !== adminLiveUsersRoleFilter) {
                          return false;
                        }
                      }
                      if (!normalizedQuery) {
                        return true;
                      }
                      const haystack = [
                        entry?.name,
                        entry?.email,
                        entry?.role,
                        entry?.id,
                      ]
                        .filter(Boolean)
                        .join(" ")
                        .toLowerCase();
                      return haystack.includes(normalizedQuery);
                    });

	                    const getLastSeenMs = (entry: any) => {
	                      if (!entry) return 0;
	                      const isOnlineNow = Boolean(entry?.isOnline);
	                      const isIdleNow = Boolean(getEntryIdle(entry));
	                      if (isEntryCurrentUser(entry)) {
	                        return isIdleNow ? lastActivityAtRef.current : Date.now();
	                      }
	                      // If the backend says a user is actively online (not idle), treat as "just seen now".
	                      if (isOnlineNow && !isIdleNow) {
	                        return Date.now();
	                      }
	                      const raw =
	                        entry?.lastInteractionAt ||
	                        entry?.lastSeenAt ||
	                        entry?.lastActivityAt ||
	                        entry?.lastActiveAt ||
	                        entry?.lastLoginAt ||
	                        null;
	                      if (!raw) return 0;
	                      const parsed = new Date(raw).getTime();
	                      return Number.isFinite(parsed) ? parsed : 0;
	                    };

	                    const liveUsers = [...filtered].sort((a: any, b: any) => {
	                      const aLast = getLastSeenMs(a);
	                      const bLast = getLastSeenMs(b);
	                      if (aLast !== bLast) return bLast - aLast;
	                      const aName = String(a?.name || a?.email || a?.id || "").toLowerCase();
	                      const bName = String(b?.name || b?.email || b?.id || "").toLowerCase();
	                      return aName.localeCompare(bName);
	                    });

                    const onlineCount = liveUsers.filter((u: any) => Boolean(u?.isOnline)).length;

                    return (
                      <div className="space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-1">
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              className="brand-checkbox"
                              checked={adminLiveUsersShowOffline}
                              onChange={(e) => setAdminLiveUsersShowOffline(e.target.checked)}
                            />
                            Show offline
                          </label>
                          <span className="text-xs text-slate-500">
                            {onlineCount} online
                          </span>
                          <label className="flex items-center gap-2 text-xs text-slate-600">
                            <span className="uppercase tracking-wide text-[11px] text-slate-500">
                              Type
                            </span>
                            <select
                              value={adminLiveUsersRoleFilter}
                              onChange={(e) => setAdminLiveUsersRoleFilter(e.target.value)}
                              className="rounded-md border border-slate-200/80 bg-white/95 px-2 py-1 text-xs font-medium text-slate-700 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                            >
                              <option value="all">All</option>
                              <option value="admin">Admin</option>
	                              <option value="sales_rep">Sales Rep</option>
	                              <option value="sales_lead">Sales Lead</option>
	                              <option value="doctor">Doctors</option>
	                              <option value="test_doctor">Test doctors</option>
                            </select>
                          </label>
                        </div>
                          <input
                            value={adminLiveUsersSearch}
                            onChange={(e) => setAdminLiveUsersSearch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                              }
                            }}
                            placeholder="Search users…"
                            className="w-full sm:w-[260px] rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                          />
                        </div>

                        <div className={`sales-rep-table-wrapper admin-dashboard-list ${liveUsers.length === 0 ? "" : "live-users-scroll"}`}>
                          <div className="flex w-full min-w-0 flex-col gap-2">
	                            {liveUsers.length === 0 ? (
	                              <div className="px-3 py-3 text-sm text-slate-500">
	                                No users found.
	                              </div>
	                            ) : (
	                              <div className="flex w-full min-w-[900px] flex-col gap-2">
		                            {liveUsers.map((entry) => {
                              const role = String(entry?.role || "").toLowerCase().trim();
		                              const rolePill = (() => {
		                                if (role === "admin") {
		                                  return {
		                                    label: "Admin",
		                                    style: {
		                                      backgroundColor: "rgb(61,43,233)",
		                                      color: "#ffffff",
		                                    } as React.CSSProperties,
		                                  };
		                                }
				                                if (role === "sales_rep" || role === "salesrep") {
				                                  return {
				                                    label: "Sales Rep",
				                                    style: {
				                                      backgroundColor: "rgb(129,221,228)",
				                                      color: "#ffffff",
				                                    } as React.CSSProperties,
				                                  };
				                                }
				                                if (role === "sales_lead" || role === "saleslead" || role === "sales-lead") {
				                                  return {
				                                    label: "Sales Lead",
				                                    style: {
				                                      backgroundColor: "rgb(129,221,228)",
				                                      color: "#ffffff",
				                                    } as React.CSSProperties,
				                                  };
				                                }
				                                if (role === "doctor") {
				                                  return {
				                                    label: "Doctor",
				                                    style: {
				                                      backgroundColor: "rgb(95,179,249)",
			                                      color: "#ffffff",
			                                    } as React.CSSProperties,
			                                  };
			                                }
			                                if (role === "test_doctor") {
			                                  return {
			                                    label: "Test Doctor",
			                                    style: {
			                                      backgroundColor: "rgb(95,179,249)",
			                                      color: "#ffffff",
			                                    } as React.CSSProperties,
			                                  };
			                                }
		                                return null;
			                              })();
			                              const avatarUrl = entry.profileImageUrl || null;
			                              const displayName = entry.name || entry.email || "User";
			                              const resolveLastSeenMs = () => {
			                                if (isEntryCurrentUser(entry)) {
			                                  return lastActivityAtRef.current;
			                                }
		                                const raw =
		                                  entry?.lastInteractionAt ||
		                                  entry?.lastSeenAt ||
		                                  entry?.lastActivityAt ||
		                                  entry?.lastActiveAt ||
		                                  entry?.lastLoginAt ||
		                                  null;
		                                if (!raw) return null;
		                                const parsed = new Date(raw).getTime();
		                                return Number.isFinite(parsed) ? parsed : null;
		                              };
		                              const lastSeenMs = resolveLastSeenMs();
		                              const minutesSinceLastSeen =
		                                lastSeenMs != null
		                                  ? Math.max(0, (Date.now() - lastSeenMs) / 60000)
		                                  : null;
			                              const IDLE_AFTER_MINUTES = 2;
			                              const onlineReported = Boolean(entry?.isOnline);
			                              const idleReported = Boolean(getEntryIdle(entry));
			                              const isOnline = onlineReported;
				                              const showIdle =
				                                isOnline &&
				                                (idleReported ||
				                                  (minutesSinceLastSeen != null &&
			                                    minutesSinceLastSeen >= IDLE_AFTER_MINUTES));
				                              const idleMinutesLabel = showIdle ? getIdleMinutesLabel(entry) : null;
				                              const formatOfflineFor = (value?: string | null) => {
				                                const raw = formatRelativeMinutes(value);
				                                if (raw === "a few moments ago") return "a few moments";
				                                return raw.replace(/\s+ago$/, "");
				                              };
				                              const offlineAnchor =
				                                entry?.lastSeenAt || entry?.lastInteractionAt || entry?.lastLoginAt || null;
				                              const statusLine = isOnline
				                                ? showIdle
				                                  ? `Idle${idleMinutesLabel ? ` (${idleMinutesLabel})` : ""} - ${formatOnlineDuration(entry.lastLoginAt)}`
				                                  : formatOnlineDuration(entry.lastLoginAt)
				                                : offlineAnchor
				                                  ? `Offline for ${formatOfflineFor(offlineAnchor)}`
				                                  : "Offline";

			                              return (
		                                <div
		                                  key={entry.id}
                                  className="flex w-full items-center gap-3 rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2"
                                >
	                                  <button
	                                    type="button"
	                                    onClick={() => openLiveUserDetail(entry)}
	                                    aria-label={`Open ${displayName} profile`}
	                                    className="min-w-0 flex-1"
	                                    style={{ background: "transparent", border: "none", padding: 0 }}
	                                  >
			                                    <div className="flex items-center gap-3 min-w-0">
				                                        <div
				                                          className="rounded-full shrink-0"
				                                          style={{
				                                            width: 41.4,
				                                            height: 41.4,
				                                            minWidth: 41.4,
				                                            boxShadow: !isOnline
				                                              ? undefined
				                                              : showIdle
				                                                ? "0 0 0 1px rgba(255,255,255,1), 0 0 0 4px rgba(148,163,184,1)"
				                                                : "0 0 0 1px rgba(255,255,255,1), 0 0 0 4px rgba(95,179,249,1)",
				                                          }}
				                                        >
				                                        <div className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm w-full h-full transition hover:shadow-md hover:border-slate-300">
			                                        {avatarUrl ? (
			                                          <img
	                                            src={avatarUrl}
	                                            alt={displayName}
                                            className="h-full w-full object-cover"
                                            loading="lazy"
                                            decoding="async"
                                          />
                                        ) : (
	                                          <span className="text-[11px] font-semibold text-slate-600">
			                                            {getInitials(displayName)}
			                                          </span>
			                                        )}
			                                      </div>
			                                    </div>
				                                      <div className="min-w-0 flex-1 overflow-hidden">
				                                        <div className="flex flex-col items-start gap-0.5 text-left">
				                                          {rolePill && (
				                                            <span
				                                              className="inline-flex items-center squircle-xs px-2 py-[2px] text-sm font-semibold shrink-0 self-start whitespace-nowrap"
				                                              style={rolePill.style}
				                                            >
				                                              {rolePill.label}
				                                            </span>
				                                          )}
				                                          <span className="text-sm font-semibold text-slate-800 whitespace-nowrap">
				                                            {displayName}
				                                          </span>
				                                          <span className="text-sm text-slate-600 whitespace-nowrap">
				                                            {entry.email || "—"}
				                                          </span>
					                                          <span className="text-sm text-slate-600 whitespace-nowrap">
					                                            {statusLine}
					                                          </span>
				                                        </div>
				                                      </div>
				                                    </div>
				                                  </button>

	                                </div>
	                              );
		                            })}
	                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                    
                </div>
	            </div>
	          )}

			          {isAdmin(user?.role) && (
				            <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
				              <div className="flex flex-col gap-3">
				                <div className="min-w-0">
				                  <h3 className="text-lg font-semibold text-slate-900">
				                    Admin Reports
				                  </h3>
				                  <p className="text-sm text-slate-600">
				                    Sales by Sales Rep, Taxes by State, and Products Sold & Commission.
				                  </p>
				                </div>
					                <div className="w-full mt-3 mb-4 flex flex-wrap items-center gap-2 min-w-0">
					                  <div className="flex items-center gap-2 min-w-0 flex-1">
					                    <Popover.Root
					                      open={adminDashboardPeriodPickerOpen}
					                      onOpenChange={setAdminDashboardPeriodPickerOpen}
					                    >
					                      <Popover.Trigger asChild>
						                        <Button
						                          type="button"
						                          variant="outline"
						                          size="icon"
						                          className="header-home-button squircle-sm h-10 w-10 shrink-0"
						                          aria-label="Select date range"
						                        >
						                          <CalendarDays aria-hidden="true" />
						                        </Button>
					                      </Popover.Trigger>
					                      <Popover.Portal>
					                        <Popover.Content
					                          side="bottom"
					                          align="end"
					                          sideOffset={8}
					                          className="calendar-popover z-[10000] w-[320px] glass-liquid rounded-xl border border-white/60 p-3 shadow-xl"
					                        >
					                          <div className="text-sm font-semibold text-slate-800">
					                            Dashboard timeframe
					                          </div>
					                          <div className="mt-2">
					                            <DayPicker
					                              mode="range"
					                              numberOfMonths={1}
					                              selected={adminDashboardPeriodRange}
					                              onSelect={handleAdminDashboardPeriodSelect}
					                              defaultMonth={adminDashboardPeriodRange?.from ?? undefined}
					                            />
					                          </div>
					                          <div className="mt-3 flex items-center justify-between">
					                            <Button
					                              type="button"
					                              variant="ghost"
					                              size="sm"
					                              className="text-slate-700"
					                              onClick={() => {
					                                const defaults = getDefaultSalesBySalesRepPeriod();
					                                setSalesRepPeriodStart(defaults.start);
					                                setSalesRepPeriodEnd(defaults.end);
					                              }}
					                            >
					                              Default
					                            </Button>
					                            <Button
					                              type="button"
					                              variant="outline"
					                              size="sm"
					                              className="calendar-done-button text-[rgb(95,179,249)] border-[rgba(95,179,249,0.45)] hover:border-[rgba(95,179,249,0.7)] hover:text-[rgb(95,179,249)]"
					                              onClick={() => {
					                                applyAdminDashboardPeriod();
					                                setAdminDashboardPeriodPickerOpen(false);
					                              }}
					                            >
					                              Done
					                            </Button>
					                          </div>
					                          <Popover.Arrow className="calendar-popover-arrow" />
					                        </Popover.Content>
					                      </Popover.Portal>
					                    </Popover.Root>
					                    <span className="text-sm font-semibold text-slate-900 min-w-0 leading-tight truncate">
					                      ({adminDashboardPeriodLabel})
					                    </span>
					                  </div>
					                  <Button
					                    type="button"
					                    variant="outline"
					                    size="sm"
					                    className="gap-2 justify-center px-3 flex-[0_1_220px] max-w-[220px] ml-auto"
					                    onClick={applyAdminDashboardPeriod}
					                    disabled={adminDashboardRefreshing}
					                    aria-busy={adminDashboardRefreshing}
					                  >
					                    <RefreshCw
					                      className={`h-4 w-4 ${adminDashboardRefreshing ? "animate-spin" : ""}`}
					                      aria-hidden="true"
					                    />
					                    {adminDashboardRefreshing ? "Refreshing..." : "Refresh"}
					                  </Button>
					                </div>
			              </div>
			
				              <div className="mt-8 space-y-6">
			                <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
			                  <div className="flex flex-col gap-3 mb-4">
                <div className="sales-rep-header-row flex w-full flex-col gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-slate-900">
                      Sales by Sales Rep
                    </h3>
                    <p className="text-sm text-slate-600">
                      Orders placed by doctors assigned to each rep.
                    </p>
				                    {/* Period controls moved to the parent Admin Reports header. */}
                  </div>
                  <div className="sales-rep-header-actions flex flex-row flex-wrap justify-end gap-4">
                    <div className="sales-rep-action flex min-w-0 flex-row items-center justify-end gap-2 sm:!flex-col sm:items-end sm:gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-2 order-2 sm:order-1"
                        onClick={downloadSalesBySalesRepCsv}
                        disabled={salesRepSalesSummary.length === 0}
                        title="Download CSV"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download CSV
                      </Button>
                      <span className="sales-rep-action-meta order-1 sm:order-2 min-w-0 text-[11px] text-slate-500 leading-tight text-right">
                        <span className="sm:hidden block min-w-0 truncate">
                          Last downloaded:{" "}
                          {salesRepSalesCsvDownloadedAt
                            ? new Date(salesRepSalesCsvDownloadedAt).toLocaleString(undefined, {
                                timeZone: "America/Los_Angeles",
                              })
                            : "—"}
                        </span>
                        <span className="hidden sm:block">
                          <span className="sales-rep-action-meta-label block">
                            Last downloaded
                          </span>
                          <span className="sales-rep-action-meta-value block">
                            {salesRepSalesCsvDownloadedAt
                              ? new Date(salesRepSalesCsvDownloadedAt).toLocaleString(undefined, {
                                  timeZone: "America/Los_Angeles",
                                })
                              : "—"}
                          </span>
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
			
                {/* Totals shown inline above list below */}
			              </div>
			              <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Sales by sales rep list">
                {salesRepSalesSummaryError ? (
                  <div className="px-4 py-3 text-sm text-amber-700 mb-3 bg-amber-50 border border-amber-200 rounded-md">
                    {salesRepSalesSummaryError}
                  </div>
                ) : salesRepSalesSummaryLoading ? (
                  <div className="px-4 py-3 text-sm mb-3 text-slate-500">
                    Checking sales…
                  </div>
                ) : salesRepSalesSummaryLastFetchedAt === null ? (
                  <div className="px-4 py-3 text-sm mb-3 text-slate-500">
                    Click Refresh to load sales.
                  </div>
	                ) : salesRepSalesSummary.length === 0 ? (
	                  <div className="px-4 py-3 text-sm text-slate-500">
	                    No sales recorded yet.
	                  </div>
		                ) : (
			                  <div className="w-full" style={{ minWidth: 920 }}>
		                        {(() => {
		                          const metaTotals = salesRepSalesSummaryMeta?.totals || null;
		                          const totals = metaTotals
	                            ? metaTotals
	                            : {
	                                totalOrders: salesRepSalesSummary.reduce(
	                                  (sum, row) => sum + (Number(row.totalOrders) || 0),
	                                  0,
	                                ),
	                                totalRevenue: salesRepSalesSummary.reduce(
	                                  (sum, row) => sum + (Number(row.totalRevenue) || 0),
	                                  0,
	                                ),
	                                wholesaleRevenue: salesRepSalesSummary.reduce(
	                                  (sum, row) => sum + (Number(row.wholesaleRevenue) || 0),
	                                  0,
	                                ),
	                                retailRevenue: salesRepSalesSummary.reduce(
	                                  (sum, row) => sum + (Number(row.retailRevenue) || 0),
	                                  0,
	                                ),
	                              };
		                          const hasTotals =
		                            typeof totals.totalOrders === "number" &&
		                            typeof totals.totalRevenue === "number";
		                          if (!hasTotals) return null;
                          return (
                            <div className="flex flex-wrap items-center justify-between gap-1 bg-white/70 px-3 py-1.5 text-sm font-semibold text-slate-900 border-b-4 border-slate-200/70">
		                              <span>Total Orders: {totals.totalOrders}</span>
		                              <span>Wholesale: {formatCurrency(Number(totals.wholesaleRevenue) || 0)}</span>
		                              <span>Retail: {formatCurrency(Number(totals.retailRevenue) || 0)}</span>
		                            </div>
		                          );
		                        })()}
			                      <div className="w-max">
			                        <div
			                          className="grid w-full items-center gap-2 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700"
			                          style={{
			                            gridTemplateColumns:
			                              "minmax(120px,1fr) minmax(160px,1fr) max-content max-content max-content",
			                          }}
			                        >
			                          <div className="whitespace-nowrap">Sales Rep</div>
			                          <div className="whitespace-nowrap">Email</div>
			                          <div className="whitespace-nowrap text-right">Orders</div>
			                          <div className="whitespace-nowrap text-right">Wholesale</div>
			                          <div className="whitespace-nowrap text-right">Retail</div>
			                        </div>
			                        <ul className="w-full border-x border-b border-slate-200/70 max-h-[420px] overflow-y-auto">
			                          {salesRepSalesSummary.map((rep) => (
			                            <li
			                              key={rep.salesRepId}
			                              className="grid w-full items-center gap-2 px-2 py-1 border-b border-slate-200/70 last:border-b-0"
			                              style={{
			                                gridTemplateColumns:
			                                  "minmax(120px,1fr) minmax(160px,1fr) max-content max-content max-content",
			                              }}
			                            >
		                            <div className="text-sm font-semibold text-slate-900 min-w-0">
		                              <button
		                                type="button"
		                                className="min-w-0 text-left hover:underline"
		                                onClick={() =>
		                                  openLiveUserDetail(
		                                    {
		                                      id: rep.salesRepId,
		                                      name: rep.salesRepName,
		                                      email: rep.salesRepEmail,
		                                      role: "sales_rep",
		                                    },
		                                    {
		                                      salesRepWholesaleRevenue: Number(
		                                        rep.wholesaleRevenue || 0,
		                                      ),
		                                      salesRepRetailRevenue: Number(
		                                        rep.retailRevenue || 0,
		                                      ),
		                                    },
		                                  )
		                                }
		                                title="Open sales rep details"
		                              >
		                                {rep.salesRepName}
		                              </button>
		                            </div>
                            <div
                              className="text-sm text-slate-700 truncate"
                              title={rep.salesRepEmail || ""}
                            >
                              {rep.salesRepEmail || "—"}
                            </div>
	                            <div className="text-sm text-right text-slate-800 tabular-nums whitespace-nowrap">
	                              {rep.totalOrders}
	                            </div>
	                            <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
	                              {formatCurrency(rep.wholesaleRevenue || 0)}
	                            </div>
		                            <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
		                              {formatCurrency(rep.retailRevenue || 0)}
		                            </div>
			                            </li>
			                          ))}
			                        </ul>
			                      </div>
		                  </div>
	                )}
              </div>
            </div>

            <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
	                  <div className="min-w-0">
	                    <h3 className="text-lg font-semibold text-slate-900">Taxes by State</h3>
	                    <p className="text-sm text-slate-600">
	                      Cumulative tax totals by destination state for the selected period.
	                    </p>
			                    {/* Period controls moved to the parent Admin Reports header. */}
	                  </div>
	                  <div className="sales-rep-header-actions flex flex-row flex-wrap justify-end gap-4">
	                    <div className="sales-rep-action flex min-w-0 flex-row items-center justify-end gap-2 sm:!flex-col sm:items-end sm:gap-1">
	                      <Button
	                        type="button"
	                        variant="outline"
	                        size="sm"
	                        className="gap-2 order-2 sm:order-1"
	                        onClick={() => void downloadAdminTaxesByStateCsv()}
	                        disabled={adminTaxesByStateRows.length === 0}
	                        title="Download CSV"
	                      >
	                        <Download className="h-4 w-4" aria-hidden="true" />
	                        Download CSV
	                      </Button>
	                      <span className="sales-rep-action-meta order-1 sm:order-2 min-w-0 text-[11px] text-slate-500 leading-tight text-right">
	                        <span className="sm:hidden block min-w-0 truncate">
	                          Last downloaded:{" "}
	                          {adminTaxesByStateCsvDownloadedAt
	                            ? new Date(adminTaxesByStateCsvDownloadedAt).toLocaleString(
	                                undefined,
	                                { timeZone: "America/Los_Angeles" },
	                              )
	                            : "—"}
	                        </span>
	                        <span className="hidden sm:block">
	                          <span className="sales-rep-action-meta-label block">
	                            Last downloaded
	                          </span>
	                          <span className="sales-rep-action-meta-value block">
	                            {adminTaxesByStateCsvDownloadedAt
	                              ? new Date(adminTaxesByStateCsvDownloadedAt).toLocaleString(
	                                  undefined,
	                                  { timeZone: "America/Los_Angeles" },
	                                )
	                              : "—"}
	                          </span>
	                        </span>
	                      </span>
	                    </div>
	                  </div>
	                </div>
	              </div>

		              {adminTaxesByStateError ? (
			                <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Taxes by state list">
			                  <div className="px-4 py-3 sm:px-5 sm:py-4 text-sm text-amber-700 bg-amber-50">
			                    {adminTaxesByStateError}
			                  </div>
			                </div>
			              ) : adminTaxesByStateLoading ? (
			                <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Taxes by state list">
			                  <div className="px-4 py-3 sm:px-5 sm:py-4 text-sm text-slate-500">Loading taxes…</div>
			                </div>
			              ) : adminTaxesByStateRows.length === 0 ? (
			                <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Taxes by state list">
			                  <div className="px-4 py-3 sm:px-5 sm:py-4 text-sm text-slate-500">No tax data for this period.</div>
			                </div>
			              ) : (
				              <div className="grid grid-cols-1 gap-2">
						              <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Taxes by state list">
			                    <div className="w-full" style={{ minWidth: 920 }}>
			                      {adminTaxesByStateMeta?.totals && (
                        <div className="flex flex-wrap items-center justify-between gap-1 bg-white/70 px-3 py-1.5 text-sm font-semibold text-slate-900 border-b-4 border-slate-200/70">
			                          <span>
			                            Orders:{" "}
			                            {Number((adminTaxesByStateMeta.totals as any)?.orderCount || 0)}
			                          </span>
			                          <span>
			                            Tax:{" "}
			                            {formatCurrency(
			                              Number((adminTaxesByStateMeta.totals as any)?.taxTotal || 0),
			                            )}
			                          </span>
			                        </div>
			                      )}
			                      <div className="w-max">
			                        <div
			                          className="grid w-full items-center gap-2 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700"
			                          style={{
			                            gridTemplateColumns: "minmax(120px,1fr) max-content max-content",
			                          }}
			                        >
			                          <div className="whitespace-nowrap">State</div>
			                          <div className="whitespace-nowrap text-right">Orders</div>
			                          <div className="whitespace-nowrap text-right">Tax</div>
			                        </div>
			                        <ul className="w-full border-x border-b border-slate-200/70 max-h-[420px] overflow-y-auto">
			                          {adminTaxesByStateRows.map((row) => (
			                            <li
			                              key={row.state}
			                              className="grid w-full items-center gap-2 px-2 py-1 border-b border-slate-200/70 last:border-b-0"
			                              style={{
			                                gridTemplateColumns: "minmax(120px,1fr) max-content max-content",
			                              }}
			                            >
			                            <div className="text-sm font-semibold text-slate-900 min-w-0 truncate">
			                              {row.state}
			                            </div>
			                            <div className="text-sm text-right text-slate-800 tabular-nums whitespace-nowrap">
			                              {Number(row.orderCount || 0)}
			                            </div>
			                            <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
			                              {formatCurrency(Number(row.taxTotal || 0))}
			                            </div>
			                            </li>
			                          ))}
			                        </ul>
			                      </div>
			                    </div>
					              </div>

				                  {adminTaxesByStateOrders.length > 0 && (
						                    <details
						                          className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar bg-white/60 border border-slate-200/70"
		                          open={adminTaxesByStateBreakdownOpen}
		                          onToggle={(event) => {
		                            setAdminTaxesByStateBreakdownOpen(
		                              (event.currentTarget as HTMLDetailsElement).open,
		                            );
		                          }}
                        >
			                      <summary className="cursor-pointer select-none flex items-center justify-between gap-1 px-2 py-1 text-sm font-semibold text-slate-900 bg-white/70 border-b-4 border-slate-200/70">
			                        <span>Order Tax Breakdown</span>
		                        <span className="rounded-full border border-slate-200/80 bg-white/70 px-2 py-1 text-[11px] font-semibold text-slate-600 whitespace-nowrap">
                              {adminTaxesByStateBreakdownOpen ? "Collapse" : "Expand"}
                            </span>
		                      </summary>
					                      <div className="w-full" style={{ minWidth: 920 }}>
					                      <div className="w-max">
					                        <div
					                          className="grid w-full items-center gap-2 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700"
					                          style={{
					                            gridTemplateColumns: "minmax(120px,1fr) max-content",
					                          }}
					                        >
					                          <div className="whitespace-nowrap">Order</div>
					                          <div className="whitespace-nowrap text-right">Tax</div>
					                        </div>
					                        <ul className="w-full border-x border-b border-slate-200/70 max-h-[320px] overflow-y-auto">
					                          {adminTaxesByStateOrders.map((line) => (
					                            <li
					                              key={`${line.orderNumber}-${line.state}`}
					                              className="grid w-full items-center gap-2 px-2 py-1 border-b border-slate-200/70 last:border-b-0"
					                              style={{
					                                gridTemplateColumns: "minmax(120px,1fr) max-content",
					                              }}
					                            >
					                              <div className="min-w-0">
					                                <div className="text-sm font-semibold text-slate-900 truncate">
					                                  {line.orderNumber}
					                                </div>
					                                <div className="text-xs text-slate-600 truncate">
					                                  State: {line.state}
					                                </div>
					                              </div>
					                              <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
					                                {formatCurrency(Number(line.taxTotal || 0))}
					                              </div>
					                            </li>
					                          ))}
					                        </ul>
					                      </div>
					                      </div>
		                    </details>
			                  )}
			              </div>
			              )}
            </div>

            <div className="glass-card squircle-xl p-4 sm:p-6 border border-slate-200/70">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
	                  <div className="min-w-0">
	                    <h3 className="text-lg font-semibold text-slate-900">Products Sold & Commission</h3>
	                    <p className="text-sm text-slate-600">
	                      Product quantities sold plus commission totals (wholesale 10%, retail 20%; house/contact-form split and administrative).
	                    </p>
	                    {/* Period controls moved to the parent Admin Reports header. */}
	                    {adminProductsCommissionMeta?.totals && (
	                      <div className="mt-2 flex flex-wrap gap-3 text-sm font-semibold text-slate-900">
	                        <span>
	                          Base:{" "}
	                          {formatCurrency(Number((adminProductsCommissionMeta.totals as any)?.commissionableBase || 0))}
                        </span>
                        <span>
                          Commission:{" "}
                          {formatCurrency(Number((adminProductsCommissionMeta.totals as any)?.commissionTotal || 0))}
                        </span>
                      </div>
                    )}
                  </div>
	                  <div className="sales-rep-header-actions flex flex-row flex-wrap justify-end gap-4">
	                    <div className="sales-rep-action flex min-w-0 flex-row items-center justify-end gap-2 sm:!flex-col sm:items-end sm:gap-1">
	                      <Button
	                        type="button"
	                        variant="outline"
	                        size="sm"
	                        className="gap-2 order-2 sm:order-1"
	                        onClick={() => void downloadAdminProductsCommissionCsv()}
	                        disabled={
	                          adminProductSalesRows.length === 0 &&
	                          adminCommissionRows.length === 0
	                        }
	                        title="Download CSV"
	                      >
	                        <Download className="h-4 w-4" aria-hidden="true" />
	                        Download CSV
	                      </Button>
	                      <span className="sales-rep-action-meta order-1 sm:order-2 min-w-0 text-[11px] text-slate-500 leading-tight text-right">
	                        <span className="sm:hidden block min-w-0 truncate">
	                          Last downloaded:{" "}
	                          {adminProductsCommissionCsvDownloadedAt
	                            ? new Date(
	                                adminProductsCommissionCsvDownloadedAt,
	                              ).toLocaleString(undefined, {
	                                timeZone: "America/Los_Angeles",
	                              })
	                            : "—"}
	                        </span>
	                        <span className="hidden sm:block">
	                          <span className="sales-rep-action-meta-label block">
	                            Last downloaded
	                          </span>
	                          <span className="sales-rep-action-meta-value block">
	                            {adminProductsCommissionCsvDownloadedAt
	                              ? new Date(
	                                  adminProductsCommissionCsvDownloadedAt,
	                                ).toLocaleString(undefined, {
	                                  timeZone: "America/Los_Angeles",
	                                })
	                              : "—"}
	                          </span>
	                        </span>
	                      </span>
	                    </div>
	                  </div>
                </div>
              </div>

	              {adminProductsCommissionError ? (
			                <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Products sold and commission lists">
			                  <div className="px-4 py-3 sm:px-5 sm:py-4 text-sm text-amber-700 bg-amber-50">
			                    {adminProductsCommissionError}
			                  </div>
			                </div>
			              ) : adminProductsCommissionLoading ? (
			                <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Products sold and commission lists">
			                  <div className="px-4 py-3 sm:px-5 sm:py-4 text-sm text-slate-500">Loading report…</div>
			                </div>
			              ) : adminProductSalesRows.length === 0 && adminCommissionRows.length === 0 ? (
			                <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Products sold and commission lists">
			                  <div className="px-4 py-3 sm:px-5 sm:py-4 text-sm text-slate-500">No data for this period.</div>
			                </div>
				              ) : (
					              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						              <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Products sold list">
					                    <div className="flex flex-wrap items-center justify-between gap-1 bg-white/70 px-3 py-1.5 text-sm font-semibold text-slate-900 border-b-4 border-slate-200/70">
					                      <span>Products Sold</span>
					                    </div>
					                    <div className="w-full" style={{ minWidth: 920 }}>
					                      <div className="w-max">
					                        <div
					                          className="grid w-full items-center gap-2 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700"
					                          style={{ gridTemplateColumns: "minmax(0,1fr) max-content" }}
					                        >
					                          <div className="whitespace-nowrap">Product</div>
					                          <div className="whitespace-nowrap text-right">Qty</div>
					                        </div>
					                        <ul className="w-full border-x border-b border-slate-200/70 max-h-[420px] overflow-y-auto">
					                          {adminProductSalesRows.map((row) => (
					                            <li
					                              key={row.key}
					                              className="grid w-full items-center gap-2 px-2 py-1 border-b border-slate-200/70 last:border-b-0"
					                              style={{
					                                gridTemplateColumns: "minmax(0,1fr) max-content",
					                              }}
					                            >
					                            <div className="min-w-0">
					                              <div
					                                className="text-sm font-semibold text-slate-900 truncate"
					                                title={row.name}
					                              >
					                                {row.name}
					                              </div>
					                              <div className="text-[11px] leading-tight text-slate-600 truncate">
					                                {row.sku
					                                  ? `SKU: ${row.sku}`
					                                  : row.productId != null
					                                    ? `Product ID: ${row.productId}`
					                                    : "—"}
					                              </div>
					                            </div>
					                            <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
					                              {Number(row.quantity || 0)}
					                            </div>
					                            </li>
					                          ))}
					                        </ul>
					                      </div>
					                    </div>
						              </div>

						                  <div className="sales-rep-table-wrapper admin-dashboard-list p-0 overflow-x-auto no-scrollbar" role="region" aria-label="Commission list">
						                    <div className="flex flex-wrap items-center justify-between gap-1 bg-white/70 px-3 py-1.5 text-sm font-semibold text-slate-900 border-b-4 border-slate-200/70">
					                      <span>Commission</span>
					                    </div>
						                    <div className="w-full" style={{ minWidth: 920 }}>
						                      <div className="w-max">
						                        <div
						                          className="grid w-full items-center gap-2 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700"
						                          style={{
						                            gridTemplateColumns: "minmax(0,1fr) max-content",
						                          }}
						                        >
						                          <div className="whitespace-nowrap">Recipient</div>
						                          <div className="whitespace-nowrap text-right">Amount</div>
						                        </div>
						                        <ul className="w-full border-x border-b border-slate-200/70 max-h-[420px] overflow-y-auto">
						                          {adminCommissionRows.map((row) => (
						                            <li
						                              key={row.id}
						                              className="grid w-full items-center gap-2 px-2 py-1 border-b border-slate-200/70 last:border-b-0"
						                              style={{
						                                gridTemplateColumns: "minmax(0,1fr) max-content",
						                              }}
						                            >
						                            <div className="min-w-0">
						                              <div
						                                className="text-sm font-semibold text-slate-900 truncate"
						                                title={row.name}
						                              >
						                                {row.name}
						                              </div>
						                              <div className="mt-0.5 text-[11px] leading-tight text-slate-600 whitespace-nowrap overflow-x-auto no-scrollbar">
								                              {(() => {
					                                const retailOrders = Number(row.retailOrders || 0);
					                                const wholesaleOrders = Number(row.wholesaleOrders || 0);
					                                const retailBase = Number(row.retailBase || 0);
				                                const wholesaleBase = Number(row.wholesaleBase || 0);
				                                const houseRetailOrders = Number((row as any).houseRetailOrders || 0);
				                                const houseWholesaleOrders = Number((row as any).houseWholesaleOrders || 0);
					                                const houseRetailBase = Number((row as any).houseRetailBase || 0);
					                                const houseWholesaleBase = Number((row as any).houseWholesaleBase || 0);
					                                const houseRetailCommission = Number((row as any).houseRetailCommission || 0);
					                                const houseWholesaleCommission = Number((row as any).houseWholesaleCommission || 0);
					                                const bonus = Number(row.specialAdminBonus || 0);
					                                const bonusRate = Number((row as any).specialAdminBonusRate || 0);
					                                const bonusMonthlyCap = Number((row as any).specialAdminBonusMonthlyCap || 0);
					                                const bonusByMonth = (row as any).specialAdminBonusByMonth as
					                                  | Record<string, number>
					                                  | undefined;
					                                const bonusBaseByMonth = (row as any).specialAdminBonusBaseByMonth as
					                                  | Record<string, number>
					                                  | undefined;
					                                const retailEarned = retailBase * 0.2;
					                                const wholesaleEarned = wholesaleBase * 0.1;
						                                const segments: ReactNode[] = [];
						                                segments.push(
						                                  <span
						                                    key="role"
						                                    className="whitespace-nowrap"
						                                  >
						                                    Role: {row.role || "— "}
						                                  </span>,
						                                );
						                                if (houseRetailOrders > 0 || houseRetailBase > 0 || houseRetailCommission > 0) {
						                                  const computed = houseRetailBase * 0.2;
						                                  const value = houseRetailCommission || computed;
						                                  segments.push(
						                                    <span className="whitespace-nowrap tabular-nums" key="house-retail">
						                                      House Retail: {formatCurrency(value)} (
						                                      {houseRetailOrders} · {formatCurrency(houseRetailBase)}×0.2)
						                                    </span>,
						                                  );
						                                } else if (retailOrders > 0 || retailBase > 0) {
						                                  const value = retailEarned;
						                                  segments.push(
						                                    <span
						                                      key="retail"
						                                      className="whitespace-nowrap tabular-nums"
						                                    >
						                                       Retail: {formatCurrency(value)} ({retailOrders} · {formatCurrency(retailBase)}×0.2)
						                                    </span>,
						                                  );
						                                }
						                                if (houseWholesaleOrders > 0 || houseWholesaleBase > 0 || houseWholesaleCommission > 0) {
						                                  const computed = houseWholesaleBase * 0.1;
						                                  const value = houseWholesaleCommission || computed;
						                                  segments.push(
						                                    <span className="whitespace-nowrap tabular-nums" key="house-wholesale">
						                                      House Wholesale: {formatCurrency(value)} (
						                                      {houseWholesaleOrders} · {formatCurrency(houseWholesaleBase)}×0.1)
						                                    </span>,
						                                  );
						                                } else if (wholesaleOrders > 0 || wholesaleBase > 0) {
						                                  const value = wholesaleEarned;
						                                  segments.push(
						                                    <span
						                                      key="wholesale"
						                                      className="whitespace-nowrap tabular-nums"
						                                    >
						                                       Wholesale: {formatCurrency(value)} ({wholesaleOrders} · {formatCurrency(wholesaleBase)}×0.1)
						                                    </span>,
						                                  );
						                                }
					                                if (bonus > 0) {
					                                  const monthKeys = Array.from(
					                                    new Set([
					                                      ...Object.keys(bonusByMonth || {}),
					                                      ...Object.keys(bonusBaseByMonth || {}),
					                                    ]),
					                                  ).sort();
					                                  const baseTotal = monthKeys.reduce((sum, monthKey) => {
					                                    return (
					                                      sum +
					                                      Number((bonusBaseByMonth || {})[monthKey] || 0)
					                                    );
					                                  }, 0);
					                                  const rawTotal = monthKeys.reduce((sum, monthKey) => {
					                                    const monthBase = Number(
					                                      (bonusBaseByMonth || {})[monthKey] || 0,
					                                    );
					                                    return sum + Math.round(monthBase * bonusRate * 100) / 100;
					                                  }, 0);
					                                  const paidTotal = monthKeys.reduce((sum, monthKey) => {
					                                    const paid = Number((bonusByMonth || {})[monthKey] || 0);
					                                    if (paid > 0) return sum + paid;
					                                    const monthBase = Number(
					                                      (bonusBaseByMonth || {})[monthKey] || 0,
					                                    );
					                                    return sum + Math.round(monthBase * bonusRate * 100) / 100;
					                                  }, 0);
					                                  const computedPaid = paidTotal > 0 ? paidTotal : rawTotal;
					                                  const capApplied = bonus > 0 && Math.abs(bonus - rawTotal) > 0.009;
					                                  const capSuffix =
					                                    bonusMonthlyCap > 0 && capApplied
					                                      ? ` (cap ${formatCurrency(bonusMonthlyCap)}/mo)`
					                                      : "";
					                                  const bonusMath =
					                                    bonusRate > 0 && baseTotal > 0
					                                      ? ` (${formatCurrency(baseTotal)}×${bonusRate}${capSuffix})`
					                                      : bonusRate > 0
					                                        ? ` (rate ${bonusRate}${
					                                            bonusMonthlyCap > 0
					                                              ? `, cap ${formatCurrency(bonusMonthlyCap)}/mo`
					                                              : ""
					                                          })`
					                                        : "";
						                                  segments.push(
				                                    <span
				                                      key="bonus"
				                                      className="whitespace-nowrap tabular-nums"
				                                    >
				                                      Web: {formatCurrency(bonus)}
				                                      {bonusMath}
				                                    </span>,
				                                  );
				                                }
			                                return (
			                                  <>
				                                    {segments.map((segment, index) => (
					                                      <Fragment
					                                        key={(segment as any)?.key ?? index}
					                                      >
				                                        {index > 0 && (
						                                          <span className="text-slate-300">
						                                            {"\u00A0|\u00A0"}
						                                          </span>
				                                        )}
				                                        {segment}
					                                      </Fragment>
				                                    ))}
			                                  </>
			                                );
								                              })()}
						                              </div>
						                            </div>
						                            <div className="text-sm text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
						                              {formatCurrency(Number(row.amount || 0))}
						                            </div>
						                            </li>
						                          ))}
						                        </ul>
						                      </div>
						                    </div>
	                  </div>
		            </div>
		              )}
		            </div>
			              </div>
			            </div>
			          )}
	
		          {hasChartData && (
	            <div className="sales-rep-combined-chart">
	              <div className="sales-rep-chart-header">
	                <div>
	                  <h3>Your Pipeline</h3>
	                  <p>Track lead volume as contacts advance through each stage.</p>
	                </div>
	              </div>
	              <div className="sales-rep-chart-body">
	                <ResponsiveContainer width="100%" height={210}>
	                  <BarChart
	                    data={salesRepChartData}
	                    margin={{ top: 16, right: 12, left: -14, bottom: 0 }}
	                  >
                    <defs>
                      <linearGradient
                        id="statusBar"
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="#5FB3F9"
                          stopOpacity={0.9}
                        />
                        <stop
                          offset="100%"
                          stopColor="#95C5F9"
                          stopOpacity={0.9}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(148, 163, 184, 0.3)"
                    />
	                    <XAxis
	                      dataKey="label"
	                      interval={0}
	                      tick={<PipelineXAxisTick />}
	                      tickLine={false}
	                      height={58}
	                      tickMargin={0}
	                      padding={{ left: 0, right: 0 }}
	                    />
	                    <YAxis
	                      allowDecimals={false}
	                      tick={{ fontSize: 12, fill: "#334155" }}
	                      width={34}
	                      tickMargin={2}
	                    />
                    <Tooltip
                      cursor={{ fill: "rgba(148, 163, 184, 0.12)" }}
                      content={PipelineTooltip}
                    />
	                    <Bar
	                      dataKey="count"
	                      radius={[4, 4, 2.5, 2.5]}
	                      fill="url(#statusBar)"
	                      barSize={32}
	                    >
                      <LabelList
                        dataKey="count"
                        position="insideTop"
                        fill="#ffffff"
                        fontSize={12}
                        offset={7}
                        formatter={(value: any) =>
                          typeof value === "number" ? value : Number(value) || 0
                        }
                        style={{ textShadow: "0 1px 4px rgba(15, 23, 42, 0.35)" }}
                        content={(props: any) => {
                          const val = Number(props.value) || 0;
                          if (val === 0) return null;
                          const { x, width } = props;
                          const cx = x + width / 2;
                          const cy = (props.y || 0) + 12;
                          return (
                            <text
                              x={cx}
                              y={cy}
                              textAnchor="middle"
                              fill="#ffffff"
                              fontSize={12}
                              style={{ textShadow: "0 1px 4px rgba(15, 23, 42, 0.35)" }}
                            >
                              {val}
                            </text>
                          );
                        }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="sales-rep-dashboard-grid">
            <div className="sales-rep-leads-card sales-rep-combined-card">
              <div className="sales-rep-leads-header">
                <div className="sales-rep-leads-title">
                  <div className="flex items-start mb-1 justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <h3 className="text-lg sm:text-xl">Your Sales</h3>
                      <p className="text-sm text-slate-600">
                        Live orders grouped by your doctors.
                      </p>
                    </div>
                    <div className="sales-rep-card-controls">
	                      <Button
	                        type="button"
	                        variant="outline"
	                        onClick={(e) => {
	                          e.stopPropagation();
	                          void fetchSalesTrackingOrders({ force: true });
	                        }}
	                        disabled={salesTrackingLoading || salesTrackingRefreshing}
	                        className="gap-2"
	                        title="Refresh your sales data"
	                      >
                        <RefreshCw
                          className={`h-4 w-4 ${
                            salesTrackingLoading || salesTrackingRefreshing
                              ? "animate-spin"
                              : ""
                          }`}
                        />
                        Refresh
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="sales-metric-pill-group sales-metric-controls">
                <div className="sales-metric-pill">
                  <p className="sales-metric-label">Orders</p>
                  <p className="sales-metric-value">
                    {salesTrackingSummary?.totalOrders ?? 0}
                  </p>
                </div>
                <div className="sales-metric-pill">
                  <p className="sales-metric-label">Total Revenue</p>
                  <p className="sales-metric-value">
                    {formatCurrency(salesTrackingSummary?.totalRevenue ?? 0)}
                  </p>
                </div>
              </div>
              <div className="sales-rep-lead-grid">
                {salesTrackingLoading && (
                  <ul className="space-y-4" aria-live="polite">
                    {[...Array(2)].map((_, idx) => (
                      <li
                        key={`sales-loading-${idx}`}
                        className="lead-panel bg-white/60 border border-slate-200/80 rounded-2xl p-4"
                      >
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className="news-loading-thumb rounded-full" />
                            <div className="space-y-2">
                              <div className="news-loading-line news-loading-shimmer w-32" />
                              <div className="news-loading-line news-loading-shimmer w-24" />
                            </div>
                          </div>
                          <div className="space-y-2 text-right">
                            <div className="news-loading-line news-loading-shimmer w-16 ml-auto" />
                            <div className="news-loading-line news-loading-shimmer w-20" />
                          </div>
                        </div>
                        <div className="space-y-3">
                          {[...Array(2)].map((_, lineIdx) => (
                            <div
                              key={`sales-loading-line-${idx}-${lineIdx}`}
                              className="flex items-center justify-between rounded-xl border border-slate-100 bg-white/70 p-3"
                            >
                              <div className="space-y-2">
                                <div className="news-loading-line news-loading-shimmer w-28" />
                                <div className="news-loading-line news-loading-shimmer w-36" />
                                <div className="news-loading-line news-loading-shimmer w-32" />
                              </div>
                              <div className="flex items-center gap-3">
                                <div className="news-loading-line news-loading-shimmer w-14 rounded-full" />
                                <div className="news-loading-line news-loading-shimmer w-16" />
                              </div>
                            </div>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {!salesTrackingLoading && salesTrackingError && (
                  <p className="lead-panel-empty text-sm text-rose-600">
                    {salesTrackingError}
                  </p>
                )}
                {!salesTrackingLoading &&
                  !salesTrackingError &&
                  salesTrackingOrdersByDoctor.length === 0 && (
                    <p className="lead-panel-empty text-sm text-slate-500">
                      No sales activity reported yet.
                    </p>
                  )}
                {!salesTrackingLoading &&
                  !salesTrackingError &&
                  salesTrackingOrdersByDoctor.length > 0 &&
	                  salesTrackingOrdersByDoctor.map((bucket) => {
	                    const isCollapsed = collapsedSalesDoctorIds.has(bucket.doctorId);
	                    return (
	                      <section key={bucket.doctorId} className="lead-panel">
	                        <div
	                          className="lead-panel-header sales-doctor-row cursor-pointer items-center"
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleSalesDoctorCollapse(bucket.doctorId)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleSalesDoctorCollapse(bucket.doctorId);
                            }
                          }}
	                          aria-expanded={!isCollapsed}
	                          aria-controls={`sales-orders-${bucket.doctorId}`}
	                          style={{ alignItems: "center" }}
	                        >
	                            <div className="sales-doctor-chevron">
	                              <ChevronRight
	                                className="h-4 w-4 text-slate-500"
	                                aria-hidden="true"
	                                style={{
	                                  transform: isCollapsed
	                                    ? "rotate(0deg)"
                                    : "rotate(90deg)",
                                  transition:
                                    "transform 0.32s cubic-bezier(0.42, 0, 0.38, 1)",
                                  transformOrigin: "center",
                                }}
                              />
                            </div>
                            <div className="sales-doctor-scroll">
                              <div className="sales-doctor-scroll-inner">
                                <button
                                  type="button"
                                  className="flex items-center gap-3 min-w-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openSalesDoctorDetail(
                                      {
                                        ...bucket,
                                        referralId: resolveReferralIdForDoctorNotes(
                                          bucket.doctorId,
                                          bucket.doctorEmail,
                                        ),
                                      },
                                      "doctor",
                                    );
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      openSalesDoctorDetail(
                                        {
                                          ...bucket,
                                          referralId: resolveReferralIdForDoctorNotes(
                                            bucket.doctorId,
                                            bucket.doctorEmail,
                                          ),
                                        },
                                        "doctor",
                                      );
                                    }
                                  }}
                                  aria-label={`View ${bucket.doctorName} details`}
                                  style={{
                                    background: "transparent",
                                    border: "none",
                                    padding: 0,
                                  }}
                                >
                                  <div
                                    className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm"
                                    style={{ width: 44, height: 44, minWidth: 44 }}
                                  >
                                    {bucket.doctorAvatar ? (
                                      <img
                                        src={bucket.doctorAvatar}
                                        alt={bucket.doctorName}
                                        className="h-full w-full object-cover"
                                        style={{ width: 44, height: 44 }}
                                      />
                                    ) : (
                                      <span className="text-sm font-semibold text-slate-600">
                                        {getInitials(bucket.doctorName)}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-left">
		                                    <p className="lead-list-name whitespace-nowrap flex items-center gap-1">
		                                      <NotebookPen
		                                        className="h-4 w-4 text-slate-400"
		                                        aria-hidden="true"
		                                      />
		                                      <span>{bucket.doctorName}</span>
		                                    </p>
                                    {String(bucket.leadType || "").toLowerCase() ===
                                      "contact_form" && (
                                      <span className="lead-source-pill lead-source-pill--contact mt-1">
                                        House / Contact Form
                                      </span>
                                    )}
                                    {bucket.doctorEmail && (
                                      <p className="lead-list-detail whitespace-nowrap">
                                        {bucket.doctorEmail}
                                      </p>
                                    )}
                                  </div>
                                </button>
                                <div className="text-right">
                                  <p className="text-xs text-slate-500 uppercase tracking-[0.16em]">
                                    Revenue
                                  </p>
                                  <p className="text-base font-semibold text-slate-900">
                                    {formatCurrency(bucket.total)}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    {bucket.orders.length} order
                                    {bucket.orders.length === 1 ? "" : "s"}
                                  </p>
                                </div>
                              </div>
                            </div>
	                        </div>
	                        {!isCollapsed && (
	                          <ul
	                            className="lead-list"
                            id={`sales-orders-${bucket.doctorId}`}
                          >
                          {bucket.orders.map((order) => {
                            const placedDate =
                              order.createdAt ||
                              (order as any).dateCreated ||
                              (order as any).date_created ||
                              (order as any).dateCreatedGmt ||
                              (order as any).date_created_gmt ||
                              order.updatedAt ||
                              null;
                            const isShipped =
                              ((order as any)?.shippingEstimate?.status ||
                                (order as any)?.shipping?.status ||
                                order.status ||
                                "")
                                .toString()
                                .toLowerCase() === "shipped";
                            const arrivalDate = isShipped
                              ? order?.shippingEstimate?.estimatedArrivalDate ||
                                (order as any)?.shippingEstimate?.deliveryDateGuaranteed ||
                                (order as any)?.shippingEstimate?.estimated_delivery_date ||
                                (order as any)?.shipping?.estimatedArrivalDate ||
                                (order as any)?.shipping?.estimated_delivery_date ||
                                null
                              : null;
                            const orderKey = String(order.id || order.number || "");
                            const isHydrating =
                              salesOrderHydratingIds.has(orderKey) ||
                              salesOrderRefreshingIds.has(orderKey);
                            const showShimmer = isHydrating;
                            const placedLabel = placedDate
                              ? `Order placed ${formatDateTime(placedDate as string)}`
                              : "Order placed Unknown date";
	                            const arrivalLabel = arrivalDate
	                              ? `Expected delivery ${formatDate(arrivalDate as string)}`
	                              : "Expected delivery unavailable";
	                            const statusLabel = describeSalesOrderStatus(order as any);
	                            const orderNotes =
	                              typeof (order as any)?.notes === "string"
	                                ? String((order as any).notes).trim()
	                                : "";
	                            return (
	                              <li
	                                key={order.id}
	                                className="lead-list-item sales-order-card cursor-pointer transition hover:shadow-sm hover:border-[rgb(95,179,249)]"
                                onClick={() => openSalesOrderDetails(order)}
                                aria-busy={showShimmer}
                              >
                                <div className="sales-order-card-content flex flex-col gap-2 w-full">
                                  <div className="flex items-center justify-between gap-3 flex-wrap">
                                    <div className="lead-list-name">
                                      Order #{order.number ?? order.id}
                                    </div>
                                    {showShimmer ? (
                                      <div className="flex items-center gap-2 justify-end w-full sm:w-auto max-w-[200px]">
                                        <div className="news-loading-line news-loading-shimmer w-16" />
                                        <div className="news-loading-line news-loading-shimmer w-20" />
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-3 justify-end">
                                        <div className="lead-updated">
                                          {formatCurrency(order.total)}
                                        </div>
                                        <span className="sales-tracking-row-status">
                                          {statusLabel}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  {showShimmer ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                                      <div className="news-loading-line news-loading-shimmer w-full" />
                                      <div className="news-loading-line news-loading-shimmer w-full" />
                                    </div>
	                                  ) : (
	                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
	                                      <div className="lead-list-detail">
	                                        {placedLabel}
	                                      </div>
	                                      <div className="lead-list-detail">
	                                        {arrivalLabel}
	                                      </div>
	                                      {orderNotes ? (
	                                        <div className="lead-list-detail sm:col-span-2">
	                                          <span className="text-xs font-semibold text-slate-500 mr-1">
	                                            Notes:
	                                          </span>
	                                          <span className="line-clamp-2">
	                                            {orderNotes}
	                                          </span>
	                                        </div>
	                                      ) : null}
	                                    </div>
	                                  )}
	                                </div>
	                              </li>
	                            );
                          })}
                          </ul>
                        )}
                      </section>
                    );
                  })}
              </div>
            </div>
            <div className="sales-rep-leads-card sales-rep-combined-card">
              <div className="sales-rep-leads-header">
                <div className="sales-rep-leads-title">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <h3 className="text-lg sm:text-xl">Your Leads</h3>
                      <p>
                        Advance referrals and inbound requests through your
                        pipeline.
                      </p>
                    </div>
                    <div className="sales-rep-card-controls">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          void tracedRefreshReferralData("sales-rep-manual-refresh", {
                            showLoading: true,
                          });
                        }}
                        disabled={referralDataLoading}
                        className="gap-2"
                      >
                        <RefreshCw
                          className={`h-4 w-4 ${referralDataLoading ? "animate-spin" : ""}`}
                        />
                        Refresh
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="sales-rep-lead-grid">
                <section className="lead-panel">
                  <div className="lead-panel-header">
                    <div className="w-full">
                      <div className="lead-panel-filter-row">
                        <h4>
                          {filteredActiveProspects.length} Active Prospect
                          {filteredActiveProspects.length === 1 ? "" : "s"}
                        </h4>
                        <select
                          value={activeProspectFilter}
                          onChange={(e) =>
                            setActiveProspectFilter(e.target.value)
                          }
                          className="rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                        >
                          {activeProspectFilterOptions.map((option) => (
                            <option key={option} value={option}>
                              {option === "all"
                                ? "All statuses"
                                : humanizeReferralStatus(option)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="text-sm text-slate-500 referrals-subtitle">
                        Combination of referral and contact form prospects.
                      </p>
                      <div className="mt-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setShowManualProspectModal(true)}
                          className="gap-2 text-sm"
                        >
                          <Plus className="h-4 w-4" />
                          Manual Prospect
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="lead-panel-divider" />
                  {referralDataLoading && filteredActiveProspects.length === 0 ? (
                    <p className="lead-panel-empty text-sm text-slate-500">
                      Loading prospects…
                    </p>
                  ) : filteredActiveProspects.length === 0 ? (
                    <p className="lead-panel-empty text-sm text-slate-500">
                      Nobody yet. Update a referral or contact form status to
                      move it here.
                    </p>
                  ) : (
                    <div className="lead-list-scroll active-prospects-list-scroll">
                      <ul className="lead-list">
	                        {filteredActiveProspects.map(({ kind, record }) => {
	                        const isUpdating =
	                          adminActionState.updatingReferral === record.id;
	                        const normalizedStatus =
	                          kind === "contact_form"
	                            ? (record.status || "contact_form").toLowerCase()
	                            : sanitizeReferralStatus(record.status);
		                        const selectedStatusValue =
		                          normalizedStatus === "contact_form"
		                            ? "pending"
		                            : normalizedStatus;
		                        const isVerified = selectedStatusValue === "verified";
                          const isCrediting = creditingReferralId === record.id;
                          const referralDisplayName =
                            (kind === "referral" &&
                              record.referrerDoctorName) ||
                            "User";
                          const referralCreditTimestamp =
                            kind === "referral" && record.creditIssuedAt
                              ? record.creditIssuedAt
                              : null;
                          const referralCreditAmount =
                            kind === "referral" &&
                            record.creditIssuedAmount != null
                              ? record.creditIssuedAmount
                              : 50;
                          const isManualLead =
                            kind === "referral" && isManualEntry(record);
                          const sourceClass =
                            kind === "contact_form"
                              ? "lead-source-pill--contact"
                              : isManualLead
                                ? "lead-source-pill--manual"
                                : "lead-source-pill--referral";
                          const sourceLabel =
                            kind === "contact_form"
                              ? "Contact Form"
                              : isManualLead
                                ? "Manual"
                                : "Referral";
	                          const hasContactAccount =
	                            typeof record.referredContactHasAccount === "boolean"
	                              ? record.referredContactHasAccount
	                              : false;
	                          const creditEligible =
	                            kind === "referral"
	                              ? Boolean(record.referredContactEligibleForCredit)
	                              : false;
		                          const awaitingFirstPurchase =
		                            selectedStatusValue === "converted" &&
		                            !hasLeadPlacedOrder(record);
			                          const isSyntheticAccount =
			                            (record as any).syntheticAccountProspect === true;
			                          const resellerPermitExempt = Boolean(
			                            (record as any).resellerPermitExempt,
			                          );
			                          const resellerPermitFileName =
			                            typeof (record as any).resellerPermitFileName ===
			                              "string" && (record as any).resellerPermitFileName.trim()
			                              ? (record as any).resellerPermitFileName.trim()
			                              : "";
			                          const resellerPermitFilePath =
			                            typeof (record as any).resellerPermitFilePath === "string"
			                              ? (record as any).resellerPermitFilePath
			                              : "";
			                          const hasResellerPermitFile = Boolean(
			                            resellerPermitFileName || resellerPermitFilePath,
			                          );
			                          const permitSatisfied =
			                            resellerPermitExempt || hasResellerPermitFile;
				                          const isPermitBusy = Boolean(
				                            resellerPermitBusyByProspectId[String(record?.id || "")],
				                          );
				                          const permitInputId = `reseller-permit-${String(record?.id || "")
				                            .replace(/[^a-zA-Z0-9_-]/g, "_")
				                            .slice(0, 64)}`;
				                          const shouldShowAccountCreatedForVerified =
				                            hasContactAccount && selectedStatusValue === "verified";
			                          const currentStatusLabel = (() => {
				                            if (selectedStatusValue === "pending") {
				                              return "Pending";
				                            }
				                            if (shouldShowAccountCreatedForVerified) {
				                              return "Account Created";
				                            }
				                            return humanizeReferralStatus(selectedStatusValue);
				                          })();
			                          const nextPromotion = (() => {
			                            if (isSyntheticAccount) {
			                              if (selectedStatusValue === "converted") {
			                                return null;
			                              }
			                              return { value: "converted", label: "Converted", disabled: false };
			                            }
			                            if (shouldShowAccountCreatedForVerified) {
			                              return { value: "converted", label: "Converted", disabled: false };
			                            }
			                            switch (selectedStatusValue) {
			                              case "pending":
			                                return { value: "contacted", label: "Contacting", disabled: false };
			                              case "contacted":
			                                return {
			                                  value: "verified",
			                                  label: permitSatisfied ? "Verified" : "Verified (permit required)",
			                                  disabled: !permitSatisfied,
			                                };
			                              case "verified":
			                                return { value: "account_created", label: "Account Created", disabled: false };
			                              case "account_created":
			                                return { value: "converted", label: "Converted", disabled: false };
			                              default:
			                                return null;
			                            }
			                          })();
                              const stageInstructionKey =
                                shouldShowAccountCreatedForVerified
                                  ? "account_created"
                                  : selectedStatusValue;
                              const stageInstructions: Record<string, string> = {
                                pending: "Move to Contacting when ready to reach out.",
                                contacted:
                                  "Reach out to them, verify their practice, ensure they have an NPI number, and note down any other personal and practice details. Collect their reseller permit if available for their tax exemption. When verified, advance their status.",
                                verified:
                                  "Now that they are verified, help them create an account by sharing your referral code. You can see when they have created an account with the label in this container.",
                                account_created:
                                  "Now that their account is created, walk them through the platform. Ensure to promote their educational and research excellence and our support for them. You can preemptively move them to the Converted status for your convenience if you wish. It will note when they make their first purchase automatically.",
                              };
                              const stageInstruction =
                                stageInstructions[stageInstructionKey] || "";
			                          const backwardStatuses = (() => {
			                            const order = [
			                              "pending",
			                              "contacted",
			                              "verified",
			                              "account_created",
			                              "converted",
			                            ];
			                            const currentIndex = order.indexOf(selectedStatusValue);
			                            if (currentIndex <= 0) return [];
			                            return order.slice(0, currentIndex).map((value) => ({
			                                value,
			                                label:
			                                  value === "pending"
			                                    ? "Pending"
			                                    : humanizeReferralStatus(value),
			                                disabled: false,
			                              }));
			                          })();
			                          const promotionOptions = [
			                            ...backwardStatuses,
			                            {
			                              value: selectedStatusValue,
			                              label: currentStatusLabel,
			                              disabled: true,
			                            },
			                            ...(nextPromotion ? [nextPromotion] : []),
			                          ];
		                          const leadAccountProfile = (() => {
		                            if (!hasContactAccount) return null;
		                            const accountId = (record as any).referredContactAccountId;
	                            const accountEmail =
	                              typeof (record as any).referredContactAccountEmail === "string"
	                                ? (record as any).referredContactAccountEmail.trim()
	                                : "";
	                            const leadEmail =
	                              typeof (record as any).referredContactEmail === "string"
	                                ? (record as any).referredContactEmail.trim()
	                                : "";
	                            const email = (accountEmail || leadEmail).toLowerCase();
	                            const phone =
	                              typeof (record as any).referredContactPhone === "string"
	                                ? (record as any).referredContactPhone.trim()
	                                : "";
	
	                            const lookups = [
	                              accountId ? `acct:${accountId}` : null,
	                              accountId ? `acct:${String(accountId).toLowerCase()}` : null,
	                              email ? `email:${email}` : null,
	                              email || null,
	                              phone ? `phone:${phone}` : null,
	                            ].filter(Boolean) as string[];
	
	                            for (const key of lookups) {
	                              const match = accountProfileLookup.get(key);
	                              if (match) return match;
	                            }
	                            return null;
	                          })();
	                          const leadDisplayName =
	                            (hasContactAccount && leadAccountProfile?.name) ||
	                            record.referredContactName ||
	                            record.referredContactEmail ||
	                            "—";
	                          return (
	                            <li
	                              key={record.id}
	                              className="lead-list-item lead-list-item--active-prospect"
	                            >
	                              <div className="lead-list-meta">
	                                <div className="lead-list-name min-w-0">
                                  <button
                                    type="button"
                                    className="inline-flex items-start gap-1 min-w-0 text-left"
                                    onClick={() => {
	                                      const doctorId =
	                                        (record as any).referredContactAccountId ||
	                                        (record as any).referredContactId ||
	                                        (record as any).userId ||
	                                        (record as any).doctorId ||
	                                        record.id;
	                                      const doctorEmail =
	                                        record.referredContactEmail ||
	                                        (leadAccountProfile?.email ?? null) ||
	                                        null;
                                    openSalesDoctorDetail(
                                      {
                                        doctorId: String(doctorId || record.id),
                                        referralId: kind === "referral" ? String(record.id) : null,
                                        doctorName: leadDisplayName,
                                        doctorEmail,
                                        doctorAvatar:
                                          leadAccountProfile?.profileImageUrl ?? null,
                                        doctorPhone: record.referredContactPhone || null,
                                        doctorAddress: null,
                                        orders: [],
                                        total: 0,
                                      },
                                      "doctor",
                                    );
	                                    }}
	                                    onKeyDown={(e) => {
	                                      if (e.key === "Enter" || e.key === " ") {
	                                        e.preventDefault();
	                                        const doctorId =
	                                          (record as any).referredContactAccountId ||
	                                          (record as any).referredContactId ||
	                                          (record as any).userId ||
	                                          (record as any).doctorId ||
	                                          record.id;
	                                        const doctorEmail =
	                                          record.referredContactEmail ||
	                                          (leadAccountProfile?.email ?? null) ||
	                                          null;
                                        openSalesDoctorDetail(
                                          {
                                            doctorId: String(doctorId || record.id),
                                            referralId: kind === "referral" ? String(record.id) : null,
                                            doctorName: leadDisplayName,
                                            doctorEmail,
                                            doctorAvatar:
                                              leadAccountProfile?.profileImageUrl ?? null,
                                            doctorPhone: record.referredContactPhone || null,
                                            doctorAddress: null,
                                            orders: [],
                                            total: 0,
                                          },
                                          "doctor",
                                        );
	                                      }
	                                    }}
	                                    aria-label={`View ${leadDisplayName} details`}
	                                    style={{
	                                      background: "transparent",
	                                      border: "none",
	                                      padding: 0,
	                                    }}
	                                  >
                                    <span className="flex items-center gap-1.5 min-w-0 text-left">
                                      <div
                                        className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm shrink-0"
                                        style={{ width: 28, height: 28, minWidth: 28 }}
                                      >
                                        {leadAccountProfile?.profileImageUrl ? (
                                          <img
                                            src={leadAccountProfile.profileImageUrl}
                                            alt={leadDisplayName}
                                            className="h-full w-full object-cover"
                                            loading="lazy"
                                            decoding="async"
                                          />
                                        ) : (
                                          <span className="text-[11px] font-semibold text-slate-600">
                                            {getInitials(leadDisplayName)}
                                          </span>
                                        )}
                                      </div>
                                      <NotebookPen
                                        className="h-4 w-4 text-slate-400 shrink-0 lead-list-name-icon"
                                        aria-hidden="true"
                                      />
                                      <span className="lead-list-name-text min-w-0 flex-1 break-words justify-start text-left leading-snug mt-[1px] self-start w-full">
                                        {leadDisplayName}
                                      </span>
                                    </span>
                                  </button>
	                                </div>
	                                {record.referredContactEmail && (
	                                  <div className="lead-list-detail">
	                                    <a
	                                      href={`mailto:${record.referredContactEmail}`}
                                      className="text-[rgb(95,179,249)] hover:underline"
                                    >
                                      {record.referredContactEmail}
                                    </a>
                                  </div>
                                )}
                                {record.referredContactPhone && (
                                  <div className="lead-list-detail">
                                    {record.referredContactPhone}
                                  </div>
                                )}
                                <span
                                  className={`lead-source-pill ${sourceClass}`}
                                >
                                  {sourceLabel}
                                </span>
                                <span
                                  className={`account-status-pill ${hasContactAccount ? "account-status-pill--active" : ""}`}
                                >
                                  {hasContactAccount
                                    ? "Account Created"
                                    : "No Account Yet"}
                                </span>
                              </div>
				                              <div className="active-prospect-status">
				                                <select
				                                  value={selectedStatusValue}
				                                  disabled={isUpdating || isPermitBusy}
				                                  onChange={(event) => {
				                                    const nextValue = event.target.value;
				                                    if (nextValue === selectedStatusValue) {
				                                      return;
				                                    }
				                                    if (
				                                      isManualLead &&
				                                      nextValue === MANUAL_PROSPECT_DELETE_VALUE
				                                    ) {
				                                      handleDeleteManualProspect(record.id);
				                                      return;
				                                    }
				                                    if (
				                                      nextValue === "account_created" &&
				                                      !hasContactAccount &&
				                                      !window.confirm(
				                                        "They have not yet created a PepPro account, are you sure you want to promote them to Account Created?",
				                                      )
				                                    ) {
				                                      return;
				                                    }
				                                    if (isSyntheticAccount) {
				                                      void promoteSyntheticAccountProspect(
				                                        record,
				                                        nextValue,
				                                      );
				                                      return;
				                                    }
				                                    handleUpdateReferralStatus(record.id, nextValue);
				                                  }}
				                                  className="lead-status-select"
				                                >
				                                  {isManualLead && (
				                                    <option value={MANUAL_PROSPECT_DELETE_VALUE}>
				                                      Delete
				                                    </option>
				                                  )}
				                                  {promotionOptions.map((option) => (
				                                    <option
				                                      key={option.value}
				                                      value={option.value}
				                                      disabled={option.disabled}
				                                    >
				                                      {option.label}
				                                    </option>
				                                  ))}
				                                </select>
				                              </div>
				                              <div className="active-prospect-right">
	                                {stageInstruction ? (
	                                  <div className="prospect-permit-instructions mt-2 text-xs leading-snug text-slate-500">
	                                    {stageInstruction}
	                                  </div>
	                                ) : null}
	                                {isVerified && (
	                                  <div className="mt-1 text-xs text-slate-700 text-center">
	                                    {typeof (user as any)?.referralCode === "string" &&
	                                    (user as any).referralCode.trim() ? (
	                                      <>
	                                        <button
	                                          type="button"
	                                          className="text-[11px] font-semibold tracking-wide text-slate-700 hover:text-[rgb(37,99,235)]"
	                                          title="Copy your sales code"
	                                          onClick={() => {
	                                            const code = String((user as any).referralCode || "")
	                                              .trim()
	                                              .toUpperCase();
	                                            if (!code) return;
	                                            try {
	                                              void navigator.clipboard?.writeText(code);
	                                            } catch {
	                                              // ignore
	                                            }
	                                          }}
	                                        >
	                                          Your referral code:{" "}
	                                          {String((user as any).referralCode || "")
	                                            .trim()
	                                            .toUpperCase()}
	                                        </button>
	                                      </>
	                                    ) : (
	                                      <span className="font-semibold tracking-wide text-slate-700">
	                                        Your referral code: —
	                                      </span>
	                                    )}
	                                  </div>
	                                )}
	                                {awaitingFirstPurchase && (
	                                  <div className="text-xs text-amber-600 text-center mt-1">
	                                    Awaiting their first purchase
	                                  </div>
	                                )}
		                                {kind === "referral" &&
		                                  !isManualLead &&
		                                  normalizedStatus === "converted" &&
		                                  !referralCreditTimestamp &&
		                                  creditEligible && (
		                                    <Button
	                                      type="button"
                                        variant="outline"
                                        size="sm"
	                                      disabled={isCrediting}
	                                      onClick={() =>
	                                        handleReferralCredit(
	                                          record as ReferralRecord,
	                                        )
	                                      }
	                                      className="mt-2 w-full header-home-button squircle-sm justify-center"
	                                    >
	                                      {isCrediting
	                                        ? "Crediting…"
	                                        : `Credit ${referralDisplayName} $50`}
	                                    </Button>
	                                  )}
			                                {kind === "referral" &&
			                                  !isManualLead &&
			                                  normalizedStatus === "converted" &&
			                                  !referralCreditTimestamp &&
			                                  !creditEligible && (
			                                    <div className="text-xs text-slate-500 text-center mt-1">
			                                      Awaiting first order to credit
			                                    </div>
			                                  )}
		                                <div className="lead-list-actions-footer">
		                                  {selectedStatusValue === "contacted" &&
		                                    !isSyntheticAccount && (
		                                      <div className="prospect-permit-container">
		                                        <div className="prospect-permit-caption">
		                                          Reseller Permit Verification
		                                        </div>
		                                        <div className="prospect-permit-controls">
			                                          <label className="prospect-permit-checkbox">
			                                            <input
			                                              type="checkbox"
			                                              checked={resellerPermitExempt}
			                                              disabled={
			                                                isUpdating ||
			                                                isPermitBusy ||
			                                                (hasResellerPermitFile &&
			                                                  !resellerPermitExempt)
			                                              }
			                                              onChange={(event) => {
			                                                void updateResellerPermitExempt(
			                                                  String(record.id),
			                                                  event.target.checked,
		                                                );
		                                              }}
		                                              className="prospect-permit-checkbox-input"
		                                            />
		                                            Doctor does not have a resellers permit
		                                          </label>
			                                          <div className="prospect-permit-file-picker">
				                                            <input
				                                              id={permitInputId}
				                                              type="file"
				                                              accept="application/pdf,image/*"
				                                              disabled={
				                                                isUpdating ||
				                                                isPermitBusy ||
				                                                resellerPermitExempt
				                                              }
				                                              onChange={(event) => {
				                                                const file =
				                                                  event.target.files?.[0];
				                                                if (file) {
			                                                  void uploadResellerPermit(
			                                                    String(record.id),
			                                                    file,
			                                                  );
			                                                  event.target.value = "";
			                                                }
			                                              }}
			                                              className="prospect-permit-file-input"
			                                            />
				                                            <label
				                                              htmlFor={permitInputId}
				                                              className="prospect-permit-file-button"
				                                              aria-disabled={
				                                                isUpdating ||
				                                                isPermitBusy ||
				                                                resellerPermitExempt
				                                              }
				                                            >
				                                              Upload Permit
				                                            </label>
				                                            {hasResellerPermitFile ? (
				                                              <div className="prospect-permit-file-meta">
	                                            {(() => {
	                                              const fullName =
	                                                resellerPermitFileName ||
	                                                resellerPermitFilePath
	                                                  .split("/")
	                                                  .pop() ||
	                                                "reseller_permit";
	                                              const shortName =
	                                                fullName.length <= 12
	                                                  ? fullName
	                                                  : `${fullName.slice(0, 8)}…${fullName.slice(-3)}`;
	                                              return (
	                                                <button
	                                                  type="button"
	                                                  className="prospect-permit-file-name prospect-permit-file-name-button"
	                                                  disabled={
	                                                    isUpdating || isPermitBusy
	                                                  }
	                                                  aria-label="Download uploaded reseller permit"
	                                                  title={fullName}
	                                                  onClick={() => {
	                                                    void viewResellerPermit(
	                                                      String(record.id),
	                                                      fullName,
	                                                    );
	                                                  }}
	                                                >
	                                                  {shortName}
	                                                </button>
	                                              );
	                                            })()}
				                                                <button
				                                                  type="button"
				                                                  className="prospect-permit-file-delete"
				                                                  disabled={
				                                                    isUpdating || isPermitBusy
				                                                  }
				                                                  title="Delete uploaded permit"
				                                                  onClick={() => {
				                                                    void deleteResellerPermit(
				                                                      String(record.id),
				                                                    );
				                                                  }}
				                                                >
				                                                  <Trash2
				                                                    className="h-4 w-4"
				                                                    aria-hidden="true"
				                                                  />
				                                                </button>
				                                              </div>
				                                            ) : (
				                                              <span className="prospect-permit-file-name">
				                                                No file selected
				                                              </span>
				                                            )}
			                                          </div>
			                                        </div>
			                                      </div>
			                                    )}
		                                  <div className="lead-list-updated-block">
		                                    {kind === "referral" &&
		                                      referralCreditTimestamp && (
		                                        <div className="text-xs font-semibold text-emerald-600 text-right break-words">
		                                          {`Credited ${referralDisplayName} ${formatCurrency(referralCreditAmount)} at ${formatDateTime(referralCreditTimestamp)}`}
		                                        </div>
		                                      )}
		                                    <div className="lead-updated text-right">
		                                      {record.updatedAt
		                                        ? `Updated ${formatDateTime(record.updatedAt)}`
		                                        : formatDateTime(record.createdAt)}
		                                    </div>
		                                  </div>
		                                </div>
				                              </div>
			                            </li>
			                          );
			                        })}
                      </ul>
                    </div>
                  )}
                </section>
                <section className="lead-panel">
	                  <div className="lead-panel-header">
	                    <div className="w-full">
	                      <div className="lead-panel-filter-row">
	                        <h4>
	                          {filteredSalesRepReferrals.length} Referral
	                          {filteredSalesRepReferrals.length === 1 ? "" : "s"}
	                        </h4>
	                      </div>
	                      <p className="text-sm text-slate-500 referrals-subtitle">
	                        Qualify new referrals and update their status.
	                      </p>
	                    </div>
                  </div>
                  <div className="lead-panel-divider" />
                  <div className="lead-list-scroll">
                    {referralDataLoading ? (
                      <p className="lead-panel-empty text-sm text-slate-500 px-1 py-2">
                        Loading referrals…
                      </p>
                    ) : filteredSalesRepReferrals.length === 0 ? (
                      <p className="lead-panel-empty text-sm text-slate-500 px-1 py-2">
                        You have no referrals yet. Encourage doctors to grow the
                        network.
                      </p>
                    ) : (
                      <ul className="lead-list">
	                        {filteredSalesRepReferrals.map((referral) => {
		                          const isUpdating =
		                            adminActionState.updatingReferral === referral.id;
		                          const isCrediting =
		                            creditingReferralId === referral.id;
		                          const manualLead = isManualEntry(referral);
		                          const normalizedStatus = sanitizeReferralStatus(
		                            referral.status,
		                          );
		                          const referralStatusOptions = (() => {
		                            if (manualLead) {
		                              return leadStatusOptions;
	                            }
	                            const base = ["pending", "contacted"];
	                            const options: string[] = [];
	                            const pushUnique = (value: string) => {
	                              if (!value) return;
	                              if (options.includes(value)) return;
	                              options.push(value);
	                            };
	                            if (!base.includes(normalizedStatus)) {
	                              pushUnique(normalizedStatus);
	                            }
	                            base.forEach((value) => pushUnique(value));
	                            return options;
	                          })();
                          const referralDisplayName =
                            referral.referrerDoctorName || "User";
                          const referralCreditTimestamp =
                            referral.creditIssuedAt || null;
                          const referralCreditAmount =
                            referral.creditIssuedAmount != null
                              ? referral.creditIssuedAmount
                              : 50;
	                          const referralEligibleForCredit = Boolean(
	                            referral.referredContactEligibleForCredit,
	                          );
	                          const isCollapsed = collapsedReferralIds.has(referral.id);
	                          const capitalizeName = (value?: string | null) => {
	                            if (!value) return value;
	                            return value
                              .split(" ")
                              .map((part) =>
                                part ? part.charAt(0).toUpperCase() + part.slice(1) : part,
                              )
                              .join(" ");
                          };
                          const refName =
                            capitalizeName(referral.referredContactName) ||
                            referral.referredContactEmail ||
                            "Lead";
                          const referrerName =
                            capitalizeName(referral.referrerDoctorName) || "Referrer";
                          const referrerEmail = referral.referrerDoctorEmail || "—";
                          const referrerPhone = referral.referrerDoctorPhone || "—";
                          const refereeEmail = referral.referredContactEmail || "—";
                          const refereePhone = referral.referredContactPhone || "—";
                          return (
                            <li
                              key={referral.id}
                              className="lead-list-item flex-col gap-3"
                            >
                              <div
                                className="lead-panel-header referral-card-header cursor-pointer items-center sales-doctor-row"
                                role="button"
                                tabIndex={0}
                                onClick={() => toggleReferralCollapse(referral.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleReferralCollapse(referral.id);
                                  }
                                }}
                                aria-expanded={!isCollapsed}
                              >
	                                <div className="sales-doctor-chevron">
	                                  <ChevronRight
	                                    className="h-4 w-4 text-slate-500"
	                                    aria-hidden="true"
	                                    style={{
	                                      transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
	                                      transition:
                                        "transform 0.32s cubic-bezier(0.42, 0, 0.38, 1)",
                                      transformOrigin: "center",
                                    }}
                                  />
                                </div>
                                <div className="sales-doctor-scroll">
                                  <div className="sales-doctor-scroll-inner">
                                    <div className="flex items-center gap-3 min-w-0">
                                      <div className="min-w-0">
                                        <p className="lead-list-name">
                                          {referrerName}{" "}
                                          <span className="text-slate-500 font-normal">
                                            referred
                                          </span>{" "}
                                          {refName}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="text-right text-xs text-slate-500 space-y-1 min-w-[180px]">
                                      <div>Submitted {formatDateTime(referral.createdAt)}</div>
                                      <div className="text-[11px] text-slate-400">
                                        Updated {formatDateTime(referral.updatedAt)}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {!isCollapsed && (
                                <>
                                  <div className="flex flex-wrap gap-2">
                                  {manualLead && (
                                    <span className="lead-source-pill lead-source-pill--manual">
                                      Manual
                                    </span>
                                  )}
                                  <span
                                    className={`account-status-pill ${referral.referredContactHasAccount ? "account-status-pill--active" : ""}`}
                                  >
                                    {referral.referredContactHasAccount
                                      ? "Account Created"
                                      : "No Account Yet"}
                                  </span>
                                </div>

                                <div className="text-sm text-slate-700 leading-relaxed bg-slate-50/80 border border-slate-200/70 rounded-lg p-3">
                                  {referral.notes ? (
                                    <span className="whitespace-pre-wrap">
                                      Notes from {referrerName}: {referral.notes}
                                    </span>
                                  ) : (
                                    <span className="text-xs italic text-slate-400">
                                      No notes
                                    </span>
                                  )}
                                </div>

                                  <div className="flex flex-wrap items-start justify-between gap-3 w-full">
                                    <div className="min-w-[200px] space-y-1">
                                      <p className="lead-list-detail">
                                        Referee Email:{" "}
                                        {refereeEmail && refereeEmail !== "—" ? (
                                          <a
                                            href={`mailto:${refereeEmail}`}
                                            className="text-[rgb(95,179,249)] hover:underline"
                                          >
                                            {refereeEmail}
                                          </a>
                                        ) : (
                                          refereeEmail
                                        )}
                                      </p>
                                      <p className="lead-list-detail">Referee Phone: {refereePhone}</p>
                                      <p className="lead-list-detail">
                                        Referrer Email:{" "}
                                        {referrerEmail && referrerEmail !== "—" ? (
                                          <a
                                            href={`mailto:${referrerEmail}`}
                                            className="text-[rgb(95,179,249)] hover:underline"
                                          >
                                            {referrerEmail}
                                          </a>
                                        ) : (
                                          referrerEmail
                                        )}
                                      </p>
                                      <p className="lead-list-detail">Referrer Phone: {referrerPhone}</p>
                                    </div>
                                    <div className="flex flex-col items-end gap-2 min-w-[240px] ml-auto">
                                      <select
                                        value={normalizedStatus}
	                                        onChange={(event) => {
	                                          const nextValue = event.target.value;
	                                          if (
	                                            manualLead &&
	                                            nextValue === MANUAL_PROSPECT_DELETE_VALUE
	                                          ) {
	                                            handleDeleteManualProspect(referral.id);
	                                            return;
	                                          }
	                                          if (
	                                            nextValue === "account_created" &&
	                                            !referral.referredContactHasAccount &&
	                                            !window.confirm(
	                                              "They have not created a PepPro account, yet are you sure you want to promote them?",
	                                            )
	                                          ) {
	                                            return;
	                                          }
	                                          handleUpdateReferralStatus(
	                                            referral.id,
	                                            nextValue,
	                                          );
	                                        }}
                                        disabled={isUpdating}
                                        className="w-full rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                                      >
	                                        {manualLead && (
	                                          <option value={MANUAL_PROSPECT_DELETE_VALUE}>
	                                            Delete
	                                          </option>
	                                        )}
	                                        {referralStatusOptions.map((status) => (
	                                          <option
	                                            key={status}
	                                            value={status}
	                                            disabled={!manualLead && !["pending", "contacted"].includes(status)}
	                                          >
	                                            {humanizeReferralStatus(status)}
	                                          </option>
	                                        ))}
	                                      </select>
	                                      {normalizedStatus === "converted" &&
	                                        !manualLead &&
	                                        !referralCreditTimestamp &&
	                                        referralEligibleForCredit && (
	                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            disabled={isCrediting}
                                            onClick={() =>
                                              handleReferralCredit(referral)
                                            }
                                            className="w-full header-home-button squircle-sm justify-center"
                                          >
                                            {isCrediting
                                              ? "Crediting…"
                                              : `Credit ${referralDisplayName} $50`}
                                          </Button>
                                        )}
	                                      {normalizedStatus === "converted" &&
	                                        !manualLead &&
	                                        !referralCreditTimestamp &&
	                                        !referralEligibleForCredit && (
	                                          <div className="text-xs text-slate-500 text-right w-full">
	                                            Awaiting first order to credit
	                                          </div>
	                                        )}
                                      {referralCreditTimestamp && (
                                        <div className="text-xs font-semibold text-emerald-600 text-right break-words">
                                          {`Credited ${referralDisplayName} ${formatCurrency(referralCreditAmount)} at ${formatDateTime(referralCreditTimestamp)}`}
                                        </div>
                                      )}
                                      <div className="text-[11px] text-slate-500 text-right">
                                        Updated {formatDateTime(referral.updatedAt)}
                                      </div>
                                    </div>
                                  </div>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </section>
                {isAdmin(user?.role) && (
                  <section className="lead-panel">
	                    <div className="lead-panel-header">
	                      <div>
	                        <h4>{contactFormQueue.length} House / Contact Form{contactFormQueue.length === 1 ? "" : "s"}</h4>
	                        <p className="text-sm text-slate-500">
	                          Inbound submissions captured directly from the site.
	                        </p>
	                      </div>
	                    </div>
                    <div className="sales-rep-table-wrapper admin-dashboard-list">
                      <table className="min-w-[720px] divide-y mb-2 divide-slate-200/70">
                        <thead className="bg-slate-50/70">
                          <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                            <th className="px-4 py-3">ID</th>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Email</th>
                            <th className="px-4 py-3">Phone</th>
                            <th className="px-4 py-3">
                              How did you get introduced to PepPro?
                            </th>
                            <th className="px-4 py-3">Received</th>
                            <th className="px-4 py-3">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y mt-2 mb-2 divide-slate-200/60">
                          {referralDataLoading ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-4 py-6 text-center mt-2 mb-2 text-sm text-slate-500"
                              >
                                Loading contact forms…
                              </td>
                            </tr>
                          ) : contactFormQueue.length === 0 ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-4 py-6 text-center mt-4 mb-2 text-sm text-slate-500"
                              >
                                No contact form submissions available.
                              </td>
                            </tr>
                          ) : (
                            contactFormQueue.map((lead) => {
                              const isUpdating =
                                adminActionState.updatingReferral === lead.id;
                              const normalizedStatusRaw = sanitizeReferralStatus(
                                lead.status || "contact_form",
                              );
                              const normalizedStatus =
                                normalizedStatusRaw === "contact_form"
                                  ? "pending"
                                  : normalizedStatusRaw;
                              const displayId =
                                (lead.id || "").replace("contact_form:", "") ||
                                lead.id ||
                                "—";
                              return (
                                <tr key={lead.id} className="align-top">
                                  <td className="px-4 py-4 font-mono text-xs text-slate-500">
                                    {displayId}
                                  </td>
                                  <td className="px-4 py-4 text-sm font-medium text-slate-900">
                                    {lead.referredContactName || "—"}
                                  </td>
                                  <td className="px-4 py-4 text-sm text-slate-600">
                                    <div>
                                      {lead.referredContactEmail ? (
                                        <a
                                          href={`mailto:${lead.referredContactEmail}`}
                                          className="text-[rgb(95,179,249)] hover:underline"
                                        >
                                          {lead.referredContactEmail}
                                        </a>
                                      ) : (
                                        "—"
                                      )}
                                    </div>
                                    <span
                                      className={`account-status-pill ${lead.referredContactHasAccount ? "account-status-pill--active" : ""}`}
                                    >
                                      {lead.referredContactHasAccount
                                        ? "Account Created"
                                        : "No Account Yet"}
                                    </span>
                                  </td>
                                  <td className="px-4 py-4 text-sm text-slate-600">
                                    {lead.referredContactPhone || "—"}
                                  </td>
                                  <td className="px-4 py-4 text-sm text-slate-600">
                                    {lead.notes || "Contact form"}
                                  </td>
                                  <td className="px-4 py-4 text-sm text-slate-600">
                                    <div>{formatDateTime(lead.createdAt)}</div>
                                  </td>
                                  <td className="px-4 py-4">
		                                    <select
		                                      value={normalizedStatus}
		                                      disabled={isUpdating}
		                                      onChange={(event) => {
		                                        const nextValue = event.target.value;
		                                        if (nextValue === normalizedStatus) {
		                                          return;
		                                        }
		                                        handleUpdateReferralStatus(lead.id, nextValue);
		                                      }}
		                                      className="rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
		                                    >
		                                      {(() => {
		                                        const base = ["pending", "contacted"];
		                                        const options: Array<{
		                                          value: string;
		                                          label: string;
		                                          disabled: boolean;
		                                        }> = [];
		                                        const pushUnique = (
		                                          value: string,
		                                          label: string,
		                                          disabled = false,
		                                        ) => {
		                                          if (!value) return;
		                                          if (options.some((opt) => opt.value === value)) return;
		                                          options.push({ value, label, disabled });
		                                        };
		                                        if (!base.includes(normalizedStatus)) {
		                                          pushUnique(
		                                            normalizedStatus,
		                                            humanizeReferralStatus(normalizedStatus),
		                                            true,
		                                          );
		                                        }
		                                        base.forEach((value) => {
		                                          const label =
		                                            value === "pending"
		                                              ? "Pending"
		                                              : humanizeReferralStatus(value);
		                                          pushUnique(value, label, false);
		                                        });
		                                        return options.map((option) => (
		                                          <option
		                                            key={option.value}
		                                            value={option.value}
		                                            disabled={option.disabled}
		                                          >
		                                            {option.label}
		                                          </option>
		                                        ));
		                                      })()}
		                                    </select>
	                                    {normalizedStatus === "verified" && (
	                                      <button
	                                        type="button"
	                                        onClick={openAccountDetailsTab}
	                                        className="block text-[rgb(95,179,249)] text-xs font-semibold hover:underline mt-1"
	                                      >
	                                        Share Referral Code
	                                      </button>
	                                    )}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </div>
              {/* Historic prospects removed; credited referrals appear in Sales */}
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-500/80 pt-2 text-center italic dashboard-feedback-note">
          Send dashboard recommendations and ideas to{" "}
          <a
            className="text-[rgb(95,179,249)] underline-offset-2 hover:underline"
            href="mailto:petergibbons7@icloud.com?subject=Dashboard%20Recommendation%20(PepPro)"
          >
            petergibbons7@icloud.com
          </a>
          .
        </p>
      </section>
    );
  };

  const handleViewProduct = (product: Product) => {
    console.debug("[Product] View details", { productId: product.id });
    setSelectedProduct(product);
    setProductDetailOpen(true);
    const isVariable = (product.type ?? "").toLowerCase() === "variable";
    if (isVariable && (!product.variants || product.variants.length === 0)) {
      void ensureCatalogProductHasVariants(product);
    }
  };

  const handleCloseProductDetail = () => {
    console.debug("[Product] Close details");
    setProductDetailOpen(false);
    setSelectedProduct(null);
  };

  useEffect(() => {
    if (!productDetailOpen || !selectedProduct) {
      return;
    }
    const isVariable = (selectedProduct.type ?? "").toLowerCase() === "variable";
    if (isVariable && (!selectedProduct.variants || selectedProduct.variants.length === 0)) {
      void ensureCatalogProductHasVariants(selectedProduct);
    }
  }, [productDetailOpen, selectedProduct, ensureCatalogProductHasVariants]);

  // Filter and search products
  const filteredProductCatalog = useMemo(
    () =>
      catalogProducts.filter((product) => {
        if (product.isSubscription) {
          return false;
        }
        const type = product.type?.toLowerCase() || "";
        const name = product.name?.toLowerCase() || "";
        const category = product.category?.toLowerCase() || "";
        const manufacturer = product.manufacturer?.toLowerCase() || "";
        const sku = product.description?.toLowerCase() || "";
        return !(
          type.includes("subscription") ||
          name.includes("subscription") ||
          category.includes("subscription") ||
          manufacturer.includes("subscription") ||
          sku.includes("subscription")
        );
      }),
    [catalogProducts],
  );

  const filteredProducts = useMemo(() => {
    let filtered = filteredProductCatalog;

    if (searchQuery) {
      filtered = filtered.filter(
        (product) =>
          product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          product.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
          product.manufacturer
            .toLowerCase()
            .includes(searchQuery.toLowerCase()) ||
          (product.description &&
            product.description
              .toLowerCase()
              .includes(searchQuery.toLowerCase())),
      );
    }

    if (filters.categories.length > 0) {
      filtered = filtered.filter((product) =>
        filters.categories.includes(product.category),
      );
    }

    if (filters.types.length > 0) {
      filtered = filtered.filter(
        (product) => product.type && filters.types.includes(product.type),
      );
    }

    return filtered;
  }, [filteredProductCatalog, searchQuery, filters]);

  const categoryCountsAll = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const product of filteredProductCatalog) {
      const category = (product.category || "").trim();
      if (!category) continue;
      counts[category] = (counts[category] || 0) + 1;
    }
    return counts;
  }, [filteredProductCatalog]);

  const visibleCatalogCategories = useMemo(() => {
    const uncategorizedCount = categoryCountsAll["Uncategorized"] || 0;
    return catalogCategories.filter((category) => {
      if (category.toLowerCase() === "uncategorized") {
        return uncategorizedCount > 0;
      }
      return true;
    });
  }, [catalogCategories, categoryCountsAll]);

  useEffect(() => {
    if (filters.categories.length === 0) {
      return;
    }
    const valid = new Set(visibleCatalogCategories);
    const next = filters.categories.filter((category) => valid.has(category));
    if (next.length === filters.categories.length) {
      return;
    }
    setFilters((prev) => ({ ...prev, categories: next }));
  }, [filters.categories, visibleCatalogCategories]);

  const productCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const category of visibleCatalogCategories) {
      counts[category] = categoryCountsAll[category] || 0;
    }
    return counts;
  }, [visibleCatalogCategories, categoryCountsAll]);

  // Add springy scroll effect to filter sidebar on large screens - DISABLED FOR TESTING
  // useEffect(() => {
  //   let lastScrollY = window.scrollY;
  //   let ticking = false;

  //   const handleScroll = () => {
  //     if (ticking) {
  //       return;
  //     }
  //     window.requestAnimationFrame(() => {
  //       const sidebar = document.querySelector<HTMLDivElement>('.filter-sidebar-container > *');
  //       if (sidebar && window.innerWidth >= 1024) {
  //         const currentScrollY = window.scrollY;
  //         const scrollDelta = currentScrollY - lastScrollY;
  //         const maxOffset = 40;
  //         const offset = Math.max(-maxOffset, Math.min(maxOffset, scrollDelta * 0.8));

  //         sidebar.style.transform = `translateY(${-offset}px)`;

  //         window.setTimeout(() => {
  //           sidebar.style.transform = 'translateY(0)';
  //         }, 150);

  //         lastScrollY = currentScrollY;
  //       }
  //       ticking = false;
  //     });
  //     ticking = true;
  //   };

  //   window.addEventListener('scroll', handleScroll, { passive: true });
  //   return () => window.removeEventListener('scroll', handleScroll);
  // }, []);

  const featuredProducts = filteredProductCatalog.slice(0, 4);
  const quoteReady = showQuote && Boolean(quoteOfTheDay);
  const { quoteFontSize, quoteLineClamp, quoteMobileFont } = useMemo(() => {
    const len = quoteOfTheDay?.text?.length || 0;
    if (len > 260) {
      return {
        quoteFontSize: "clamp(0.55rem, 1.1vw, 0.72rem)",
        quoteLineClamp: 8,
        quoteMobileFont: "clamp(0.68rem, 1.9vw, 0.84rem)",
      };
    }
    if (len > 180) {
      return {
        quoteFontSize: "clamp(0.6rem, 1.3vw, 0.8rem)",
        quoteLineClamp: 6,
        quoteMobileFont: "clamp(0.72rem, 2vw, 0.88rem)",
      };
    }
    if (len > 120) {
      return {
        quoteFontSize: "clamp(0.66rem, 1.5vw, 0.9rem)",
        quoteLineClamp: 5,
        quoteMobileFont: "clamp(0.78rem, 2.2vw, 0.94rem)",
      };
    }
    return {
      quoteFontSize: "clamp(0.74rem, 1.8vw, 0.98rem)",
      quoteLineClamp: 4,
      quoteMobileFont: "clamp(0.84rem, 2.5vw, 1rem)",
    };
  }, [quoteOfTheDay]);

  const totalCartItems = cartItems.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
		  const shouldShowHeaderCartIcon =
		    totalCartItems > 0 && !isCheckoutButtonVisible;
		  const newsLoadingPlaceholders = Array.from({ length: 5 });
		  const forumLoadingPlaceholders = Array.from({ length: 1 });
		  const landingAvatarSize = isDesktopLandingLayout ? 52 : 61;
		  const landingAccountButton = user ? (
		    <Button
		      type="button"
		      variant="default"
		      size="sm"
		      onClick={openAccountDetailsTab}
		      className="squircle-sm glass-brand btn-hover-lighter transition-all duration-300 whitespace-nowrap pl-1 pr-0 header-account-button"
		      aria-label="Open account"
		    >
		      <span className="hidden sm:inline text-white">{user.name}</span>
		      <span className="header-account-avatar-shell">
		        {user.profileImageUrl ? (
		          <img
		            src={user.profileImageUrl}
	            alt={user.name}
	            className="header-account-avatar header-avatar-image"
	            style={{ width: landingAvatarSize, height: landingAvatarSize }}
	          />
	        ) : (
	          <span
	            className="header-account-avatar header-avatar-fallback"
	            style={{ width: landingAvatarSize, height: landingAvatarSize }}
	            aria-hidden="true"
	          >
	            {getInitials(user.name)}
	          </span>
	        )}
	      </span>
	    </Button>
	  ) : null;

	  return (
	    <div
	      className="min-h-screen bg-slate-50 flex flex-col safe-area-vertical"
      style={{
        position: "static",
      }}
    >
      {/* Ambient background texture */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          top: "-12vh",
          left: "-6vw",
          width: "112vw",
          height: "140vh",
          backgroundImage: "url(/leafTexture.jpg)",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          zIndex: 0,
          pointerEvents: "none",
          maskImage:
            "linear-gradient(to top, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.15) 33%, rgba(0,0,0,0.075) 66%, rgba(0,0,0,0) 100%)",
          WebkitMaskImage:
            "linear-gradient(to top, rgba(0,0,0,0.50) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0) 100%)",
        }}
      />
      {infoFocusActive && postLoginHold && user && (
        <div className="info-focus-overlay" aria-hidden="true" />
      )}
		      <div className="relative z-10 flex flex-1 flex-col">
		        {/* Header - Only show when logged in */}
			        {user && (
			          <div style={{ display: postLoginHold ? "none" : undefined }}>
		                  <Header
				              user={user}
				              researchDashboardEnabled={researchDashboardEnabled}
				              onLogin={handleLogin}
				              onLogout={handleLogout}
				              cartItems={totalCartItems}
		              onSearch={handleSearch}
		              onCreateAccount={handleCreateAccount}
		              onCartClick={() => setCheckoutOpen(true)}
		              loginPromptToken={loginPromptToken}
		              loginContext={loginContext}
		              showCartIconFallback={shouldShowHeaderCartIcon}
		              onShowInfo={() => {
		                console.log(
		                  "[App] onShowInfo called, setting postLoginHold to true",
		                );
		                setPostLoginHold(true);
		              }}
		              onUserUpdated={(next) => setUser(next as User)}
		              accountOrders={accountOrders}
		              accountOrdersLoading={accountOrdersLoading}
		              accountOrdersError={accountOrdersError}
		              ordersLastSyncedAt={accountOrdersSyncedAt}
		              onRefreshOrders={loadAccountOrders}
			              showCanceledOrders={showCanceledOrders}
			              onToggleShowCanceled={toggleShowCanceledOrders}
			              accountModalRequest={accountModalRequest}
                    onAccountModalRequestHandled={(token) => {
                      setAccountModalRequest((prev) => {
                        if (!prev) return prev;
                        return prev.token === token ? null : prev;
                      });
	                    }}
	                    suppressAccountHomeButton={postLoginHold}
				              onBuyOrderAgain={handleBuyOrderAgain}
				              onCancelOrder={handleCancelOrder}
				              referralCodes={referralCodesForHeader}
				              catalogLoading={catalogLoading}
				            />
			          </div>
			        )}

        <div className="flex-1 w-full flex flex-col">
          {/* Landing Page - Show when not logged in */}
          {(!user || postLoginHold) && (
            <div className="min-h-screen flex flex-col items-center pt-20 px-4 py-12">
              {/* Logo with Welcome and Quote Containers */}
              {postLoginHold && user ? (
	                <div className="w-full max-w-7xl mb-6 px-4">
		                  {isDesktopLandingLayout ? (
			                    <div className="flex items-center justify-between gap-6 lg:gap-8 mb-8 w-full">
		                      <div className="flex-shrink-0">
		                        <div className="brand-logo brand-logo--landing">
		                          <img
		                            src="/Peppro_fulllogo.png"
		                            alt="PepPro"
                            style={{
                              display: "block",
                              width: "auto",
                              height: "auto",
                              maxWidth: "min(330px, 35vw)",
                              maxHeight: "min(290px, 25vh)",
                              objectFit: "contain",
                            }}
	                          />
		                        </div>
		                      </div>

		                      <div
		                        className={`flex items-center justify-end gap-4 transition-all duration-500 flex-shrink-0 ${
		                          showWelcome
		                            ? "opacity-100 translate-y-0"
		                            : "opacity-0 translate-y-4 pointer-events-none"
		                        }`}
		                      >
		                        <p
		                          className={`font-semibold text-[rgb(95,179,249)] text-right leading-none shimmer-text ${infoFocusActive ? "is-shimmering" : "shimmer-text--cooldown"}`}
			                          style={{
			                            color: "rgb(95,179,249)",
			                            fontSize: infoFocusActive
			                              ? "clamp(1.6rem, 2.9vw, 3rem)"
			                              : "clamp(1.35rem, 2.6vw, 2.2rem)",
			                            transition: "font-size 800ms ease",
			                          }}
		                        >
		                          Welcome{user.visits && user.visits > 1 ? " back!" : "!"}
	                        </p>
	                        {landingAccountButton}
	                      </div>
	                    </div>
	                  ) : (
                    <div className="flex flex-col items-center gap-6 mb-8">
                      <div className="flex w-full items-center justify-between gap-4 px-4">
                        <div className="brand-logo brand-logo--landing flex-shrink-0">
                          <img
                            src="/Peppro_fulllogo.png"
                            alt="PepPro"
                            style={{
                              display: "block",
                              width: "auto",
                              height: "auto",
                              minWidth: "180px",
                              minHeight: "54px",
                              maxWidth: "min(330px, 35vw)",
                              maxHeight: "min(290px, 25vh)",
                              objectFit: "contain",
                            }}
                          />
                        </div>
                        {landingAccountButton}
                      </div>
                      <div
                        className={`glass-card squircle-lg border border-[var(--brand-glass-border-2)] px-4 py-4 shadow-lg transition-all duration-500 w-full info-highlight-card ${infoFocusActive ? "info-focus-active" : ""} ${
                          showWelcome
                            ? "opacity-100 translate-y-0"
                            : "opacity-0 -translate-y-4"
                        } flex flex-col items-center text-center justify-center sm:justify-start`}
                        style={{
                          backdropFilter: "blur(20px) saturate(1.4)",
                          minHeight:
                            quoteReady && quoteOfTheDay
                              ? "auto"
                              : "min(140px, 20vh)",
                        }}
                      >
                        <p
                          className={`text-center font-semibold text-[rgb(95,179,249)] shimmer-text ${infoFocusActive ? "is-shimmering" : "shimmer-text--cooldown"}`}
                          style={{
                            color: "rgb(95,179,249)",
                            fontSize:
                              quoteReady && quoteOfTheDay
                                ? "clamp(1rem, 3.2vw, 1.6rem)"
                                : "clamp(1.32rem, 4.9vw, 1.9rem)",
                            lineHeight: 1.2,
                            transform:
                              quoteReady && quoteOfTheDay
                                ? "translateY(-8px)"
                                : "translateY(0)",
                            transition:
                              "font-size 600ms ease, transform 600ms ease",
                          }}
                        >
                          Welcome{user.visits && user.visits > 1 ? " back!" : "!"}
                          , {user.name}!
                        </p>
                        <div
                          className={`${quoteLoading && !quoteReady ? "quote-container-shimmer" : ""} w-full rounded-lg bg-white/65 px-3 py-3 sm:px-4 sm:py-3 text-center shadow-inner transition-opacity duration-500 mt-6`}
                          aria-live="polite"
                        >
                          {!quoteReady && (
                            <div className="min-h-[56px] flex items-center justify-center w-full">
                              <p className="text-sm font-semibold mt-3 text-center shimmer-text is-shimmering" style={{ color: "rgb(95,179,249)" }}>
                                Loading today&apos;s quote…
                              </p>
                            </div>
                          )}
                          {quoteReady && quoteOfTheDay && (
                            <p
                              className="px-4 sm:px-6 italic text-[rgb(95,179,249)] leading-snug break-words"
                              style={{
                                color: "rgb(95,179,249)",
                                fontSize: quoteMobileFont,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                display: "-webkit-box",
                                WebkitLineClamp: quoteLineClamp,
                                WebkitBoxOrient: "vertical",
                              }}
                            >
                              "{quoteOfTheDay.text}" — {quoteOfTheDay.author}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className={`flex justify-center ${
                    landingAuthMode === "signup"
                      ? "mb-6 sm:mb-8 lg:mb-12"
                      : "mb-12 sm:mb-12 lg:mb-20"
                  }`}
                >
                  <div className="brand-logo brand-logo--landing">
                    <img
                      src="/Peppro_fulllogo.png"
                      alt="PepPro"
                      style={{
                        display: "block",
                        width: "auto",
                        height: "auto",
                        maxWidth: "min(360px, 80vw)",
                        maxHeight: "min(360px, 40vh)",
                        objectFit: "contain",
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Info Container - After Login */}
              {postLoginHold && user ? (
                <div className="w-full max-w-6xl mt-4 sm:mt-6 md:mt-8">
                  <div className="post-login-layout">
                    <div
                      className="post-login-news glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-6 sm:p-8 shadow-xl"
                      style={{ backdropFilter: "blur(38px) saturate(1.6)" }}
                    >
                      <div className="space-y-5">
                        <div className="flex items-center justify-between gap-3 mb-4">
                          <div className="flex items-center gap-2">
                            <h2 className="text-lg sm:text-xl font-semibold text-[rgb(95,179,249)]">
                              Peptide News
                            </h2>
                            <button
                              onClick={handleRefreshNews}
                              disabled={peptideNewsLoading}
                              className="p-1.5 rounded-md hover:bg-[rgba(95,179,249,0.1)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Refresh news"
                            >
                              <RefreshCw
                                className={`h-4 w-4 text-[rgb(95,179,249)] ${peptideNewsLoading ? "animate-spin" : ""}`}
                              />
                            </button>
                            {peptideNewsUpdatedAt && (
                              <span className="text-xs text-gray-500">
                                Updated at:{" "}
                                {peptideNewsUpdatedAt.toLocaleTimeString(
                                  "en-US",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                    hour12: false,
                                  },
                                )}
                              </span>
                            )}
                          </div>
                          <a
                            href="https://www.nature.com/subjects/peptides"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold uppercase tracking-wide text-[rgb(95,179,249)] hover:underline underline-offset-4"
                          >
                            View All
                          </a>
                        </div>
                        <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4 text-sm text-gray-700 leading-relaxed">
                          {peptideNewsLoading && (
                            <ul className="space-y-4" aria-live="polite">
                              {newsLoadingPlaceholders.map((_, index) => (
                                <li
                                  key={index}
                                  className="news-loading-card flex items-start gap-3"
                                >
                                  <div
                                    className="news-loading-thumb"
                                    aria-hidden="true"
                                  />
                                  <div className="flex-1 space-y-2">
                                    <div
                                      className="news-loading-line news-loading-shimmer w-3/4"
                                      aria-hidden="true"
                                    />
                                    <div
                                      className="news-loading-line news-loading-shimmer w-full"
                                      aria-hidden="true"
                                    />
                                    <div
                                      className="news-loading-line news-loading-shimmer w-1/2"
                                      aria-hidden="true"
                                    />
                                  </div>
                                </li>
                              ))}
                              <li className="text-xs text-slate-500 pl-1">
                                Loading latest headlines…
                              </li>
                            </ul>
                          )}
                          {!peptideNewsLoading && peptideNewsError && (
                            <p className="text-xs text-red-600">
                              {peptideNewsError}
                            </p>
                          )}
                          {!peptideNewsLoading &&
                            !peptideNewsError &&
                            peptideNews.length === 0 && (
                              <p className="text-xs text-slate-600">
                                No headlines available right now. Please check
                                back soon.
                              </p>
                            )}
                          {!peptideNewsLoading &&
                            !peptideNewsError &&
                            peptideNews.length > 0 && (
                              <>
                                <ul className="space-y-4">
                                  {peptideNews.map((item) => (
                                    <li
                                      key={item.url}
                                      className="flex items-start gap-3"
                                    >
                                      <div className="peptide-news-thumb flex-none ring-1 ring-white/40 shadow-sm">
                                        <img
                                          src={
                                            item.image ??
                                            PEPTIDE_NEWS_PLACEHOLDER_IMAGE
                                          }
                                          alt={`Peptide news: ${item.title}`}
                                          loading="lazy"
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <div>
                                          <a
                                            href={item.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-[rgb(95,179,249)] font-semibold hover:underline underline-offset-4"
                                            aria-label={`${item.date ? formatNewsDate(item.date) + " — " : ""}${item.title}`}
                                          >
                                            {item.date && (
                                              <span className="text-xs text-gray-500 mr-2">
                                                {formatNewsDate(item.date)}
                                              </span>
                                            )}
                                            <span className="align-middle">
                                              {item.title}
                                            </span>
                                          </a>
                                        </div>
                                        {item.summary && (
                                          <p className="text-xs text-gray-600 leading-relaxed">
                                            {item.summary}
                                          </p>
                                        )}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                                <div className="pt-4 text-[11px] uppercase tracking-wide text-gray-500 border-t border-white/40">
                                  Source:{" "}
                                  <a
                                    href="https://www.nature.com/subjects/peptides"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-semibold text-[rgb(95,179,249)] hover:underline underline-offset-4"
                                  >
                                    Nature.com – Peptide Subject
                                  </a>
                                </div>
                              </>
                            )}
                        </div>
                      </div>
                    </div>
	                    <div
	                      className="post-login-info glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] pt-6 px-6 pb-4 sm:pt-8 sm:px-8 sm:pb-5 shadow-xl"
	                      style={{ backdropFilter: "blur(38px) saturate(1.6)" }}
	                    >
                      <div className="space-y-4">
                        <div
                          className={`flex w-full flex-wrap items-center gap-3 pb-2 ${
                            isDoctorRole(user?.role) ? "justify-between" : ""
                          }`}
                        >
                          <Button
                            type="button"
                            size="lg"
                            onClick={() => {
                              if (typeof window !== "undefined") {
                                window.dispatchEvent(
                                  new CustomEvent("peppro:logout-with-thanks"),
                                );
                              } else {
                                handleLogout();
                              }
                            }}
                            className="text-white squircle-sm px-6 py-2 font-semibold uppercase tracking-wide shadow-lg shadow-[rgba(95,179,249,0.4)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(95,179,249,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-white transition-all duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                            style={{ backgroundColor: "rgb(95, 179, 249)" }}
                          >
                            <ArrowLeft
                              className="h-4 w-4 mr-2"
                              aria-hidden="true"
                            />
                            <span>Logout</span>
                          </Button>
                          <Button
                            type="button"
                            size="lg"
                            onClick={handleAdvanceFromWelcome}
                            disabled={
                              !(
                                shopEnabled ||
                                isAdmin(user?.role) ||
                                isRep(user?.role) ||
                                isTestDoctor(user?.role)
                              )
                            }
                            className="text-white squircle-sm px-6 py-2 font-semibold uppercase tracking-wide shadow-lg shadow-[rgba(95,179,249,0.4)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(95,179,249,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-white transition-all duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                            style={{ backgroundColor: "rgb(95, 179, 249)" }}
                          >
                            <span className="mr-2">Shop</span>
                            <ArrowRight
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          </Button>
	                          {(isRep(user?.role) || isAdmin(user?.role)) && (
	                            <span className="text-[11px] text-slate-600 italic">
	                              Shop for physicians:{" "}
	                              {shopEnabled ? "Enabled" : "Disabled"}
	                            </span>
	                          )}
	                        </div>
                          {isDesktopLandingLayout && (
                            <div
                              className={`glass-card ${quoteLoading && !quoteReady ? "quote-container-shimmer" : ""} squircle-md border border-[var(--brand-glass-border-2)] px-4 py-4 shadow-lg transition-all duration-500 flex flex-col justify-center w-full`}
                              style={{ backdropFilter: "blur(20px) saturate(1.4)" }}
                              aria-live="polite"
                            >
                              {!quoteReady && (
                                <div className="flex w-full items-center justify-center">
                                  <p
                                    className="text-sm font-semibold text-center shimmer-text is-shimmering"
                                    style={{ color: "rgb(95,179,249)" }}
                                  >
                                    Loading today&apos;s quote…
                                  </p>
                                </div>
                              )}
                              {quoteReady && quoteOfTheDay && (
                                <p
                                  className="px-4 sm:px-6 italic text-[rgb(95,179,249)] text-center leading-snug break-words"
                                  style={{
                                    color: "rgb(95,179,249)",
                                    fontSize: quoteFontSize,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    display: "-webkit-box",
                                    WebkitLineClamp: quoteLineClamp,
                                    WebkitBoxOrient: "vertical",
                                  }}
                                >
                                  "{quoteOfTheDay.text}" — {quoteOfTheDay.author}
                                </p>
                              )}
                            </div>
                          )}
		                        {shouldShowPeptideForumCard && (
		                        <div className="glass-card squircle-md p-4 space-y-3 border border-[var(--brand-glass-border-2)]">
		                          <div className="flex items-start justify-between gap-3">
		                            <div className="space-y-1">
	                              <h2 className="text-lg sm:text-xl font-semibold text-[rgb(95,179,249)]">
	                                The Peptide Forum
	                              </h2>
	                              {!peptideForumEnabled &&
	                                isAdmin(user?.role) && (
	                                  <p className="text-[11px] text-amber-700">
	                                    Hidden for users (admin override)
	                                  </p>
	                                )}
	                            </div>
	                            <div className="flex flex-col items-end gap-1">
	                              <Button
	                                type="button"
	                                variant="outline"
	                                size="sm"
	                                className="header-home-button squircle-sm bg-white text-slate-900"
	                                onClick={() => void refreshPeptideForum()}
	                                disabled={peptideForumLoading}
	                              >
	                                {peptideForumLoading ? "Refreshing…" : "Refresh"}
	                              </Button>
	                            </div>
	                          </div>

	                          {peptideForumLoading && (
	                            <ul className="space-y-3" aria-live="polite">
	                              {forumLoadingPlaceholders.map((_, index) => (
	                                <li
	                                  key={index}
	                                  className="rounded-lg border border-white/40 bg-white/70 px-3 py-2 shadow-sm animate-pulse min-h-[108px]"
	                                >
	                                  <div className="space-y-2">
	                                    <div className="h-4 w-4/5 rounded bg-[rgba(95,179,249,0.14)]" />
	                                    <div className="h-3 w-full rounded bg-[rgba(95,179,249,0.10)]" />
	                                    <div className="h-3 w-11/12 rounded bg-[rgba(95,179,249,0.10)]" />
	                                    <div className="h-3 w-1/3 rounded bg-[rgba(95,179,249,0.12)]" />
	                                  </div>
	                                </li>
	                              ))}
	                            </ul>
	                          )}
                          {!peptideForumLoading && peptideForumError && (
                            <p className="text-xs text-red-600" role="alert">
                              {peptideForumError}
                            </p>
                          )}
                          {!peptideForumLoading && !peptideForumError && (() => {
                            const visibleItems = (peptideForumItems || [])
                              .slice()
                              .sort((a, b) => {
                                const toTime = (value?: string | null) => {
                                  if (!value) return Number.NEGATIVE_INFINITY;
                                  const parsed = Date.parse(value);
                                  return Number.isFinite(parsed)
                                    ? parsed
                                    : Number.NEGATIVE_INFINITY;
                                };
                                const aTime = toTime(a?.date ?? null);
                                const bTime = toTime(b?.date ?? null);
                                return bTime - aTime;
                              })
                              .filter((item) => {
                                const dateValue = item?.date ?? null;
                                const dateMs = dateValue ? Date.parse(dateValue) : Number.NaN;
                                if (!Number.isFinite(dateMs)) {
                                  return Boolean(
                                    (item?.link && String(item.link).trim())
                                    || (item?.recording && String(item.recording).trim()),
                                  );
                                }
                                const hasRecording = Boolean(
                                  item?.recording && String(item.recording).trim(),
                                );
                                const hasWebinarLink = Boolean(
                                  item?.link && String(item.link).trim(),
                                );
                                const isPast = dateMs < Date.now();
                                if (isPast) return hasRecording;
                                return hasWebinarLink || hasRecording;
                              });

	                            if (visibleItems.length === 0) {
	                              return (
	                                <p className="text-xs text-slate-500">
	                                  Stay tuned! New classes will be scheduled here and on our{" "}
	                                  <a
	                                    href="https://www.linkedin.com/company/peppro/posts/?feedView=all"
	                                    target="_blank"
	                                    rel="noreferrer"
	                                    className="text-[rgb(26,85,173)] hover:underline"
	                                  >
	                                    LinkedIn
	                                  </a>
	                                  .
	                                </p>
	                              );
	                            }

                            return (
                              <ul className="space-y-3">
                                {visibleItems.map((item) => (
                                    <li
                                      key={item.id}
                                      className="rounded-lg border border-white/40 bg-white/70 px-3 py-2 shadow-sm"
                                    >
                                      <div className="space-y-1.5">
                                        <p className="text-sm font-semibold text-slate-800">
                                          {item.date
                                            ? `${formatDateTime(item.date)} — `
                                            : ""}
                                          {item.title}
                                        </p>
                                        {item.description && (
                                          <p className="text-xs text-slate-600 leading-relaxed">
                                            {item.description}
                                          </p>
                                        )}
                                        {(() => {
                                          const dateValue = item?.date ?? null;
                                          const dateMs = dateValue ? Date.parse(dateValue) : Number.NaN;
                                          const isPast = Number.isFinite(dateMs) ? dateMs < Date.now() : false;
                                          const recording = item?.recording && String(item.recording).trim() ? String(item.recording).trim() : null;
                                          const webinarLink = item?.link && String(item.link).trim() ? String(item.link).trim() : null;

                                          const href = isPast ? recording : webinarLink;
                                          if (!href) return null;

	                                          const label = isPast ? "Recording Available" : "Join the Lecture";
	
	                                          return (
	                                            <p className="text-sm mt-1 pt-0.5">
	                                              <a
	                                                href={href}
	                                                target="_blank"
	                                                rel="noopener noreferrer"
	                                                className="font-semibold !text-[rgb(95,179,249)] hover:underline underline-offset-4"
	                                                style={{ color: "rgb(95, 179, 249)" }}
	                                              >
	                                                <span className="inline-flex items-center gap-1">
	                                                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
	                                                  <span>{label}</span>
	                                                </span>
	                                              </a>
	                                            </p>
	                                          );
	                                        })()}
                                      </div>
                                    </li>
                                  ))}
                              </ul>
                            );
                          })()}
                        </div>
                        )}
                        {/* Regional contact info for doctors */}
                        {!(isRep(user.role) || isAdmin(user.role)) && (
                          <div className="glass-card squircle-md p-4 space-y-2 border border-[var(--brand-glass-border-2)]">
                            <p className="text-sm font-medium text-slate-700">
                              Please contact your representative
                              anytime.
                            </p>
                            <div className="space-y-1 text-sm text-slate-600">
                              <p>
                                <span className="font-semibold">Name:</span>{" "}
                                {user.salesRep?.name || "N/A"}
                              </p>
                              <p>
                                <span className="font-semibold">Email:</span>{" "}
                                {user.salesRep?.email ? (
                                  <a
                                    href={`mailto:${user.salesRep.email}`}
                                    className="text-[rgb(95,179,249)] hover:underline"
                                  >
                                    {user.salesRep.email}
                                  </a>
                                ) : (
                                  "N/A"
                                )}
                              </p>
                              <p>
                                <span className="font-semibold">Phone:</span>{" "}
                                {user.salesRep?.phone || "N/A"}
                              </p>
                            </div>
                          </div>
                        )}
                        {/* Passkey registration now handled automatically after login when supported */}
                        <div className="relative flex flex-col gap-6 max-h-[70vh]">
                          <div className="flex-1 overflow-y-auto pr-1 space-y-16">
                            {/* Removed: Customer experiences & referrals section */}

	                            {/* Removed: Care & Compliance container */}
	                          </div>
	                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className={`w-full max-w-md ${
                    landingAuthMode === "signup"
                      ? "mt-3 sm:mt-4 md:mt-6"
                      : "mt-4 sm:mt-6 md:mt-8"
                  }`}
                >
                  <div
                    className="glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-8 shadow-xl"
                    style={{ backdropFilter: "blur(38px) saturate(1.6)" }}
                  >
                    <div
                      className={
                        landingAuthMode === "signup" ? "space-y-6" : "space-y-4"
                      }
                    >
                      {landingAuthMode === "login" && (
                        <>
	                          <form
	                            onSubmit={async (e) => {
	                              e.preventDefault();
	                              if (landingLoginPending) {
	                                return;
	                              }
	                              const classifyNetworkIssue = (
	                                message?: string | null,
	                              ): "offline" | "network" | null => {
	                                if (
	                                  typeof navigator !== "undefined" &&
	                                  navigator.onLine === false
	                                ) {
	                                  return "offline";
	                                }
	                                const text = String(message || "")
	                                  .toLowerCase()
	                                  .trim();
	                                if (!text) return null;
	                                if (
	                                  text.includes("internet connection appears to be offline") ||
	                                  text.includes("appears to be offline") ||
	                                  text.includes("no internet") ||
	                                  text.includes("offline")
	                                ) {
	                                  return "offline";
	                                }
	                                if (
	                                  text.includes("failed to fetch") ||
	                                  text.includes("networkerror") ||
	                                  text.includes("network request failed") ||
	                                  text.includes("load failed") ||
	                                  text.includes("timeout") ||
	                                  text.includes("econnrefused") ||
	                                  text.includes("enotfound") ||
	                                  text.includes("eai_again")
	                                ) {
	                                  return "network";
	                                }
	                                return null;
	                              };
	                              setLandingLoginError("");
	                              setLandingLoginPending(true);
	                              try {
	                                const fd = new FormData(e.currentTarget);
	                                const res = await handleLogin(
	                                  fd.get("username") as string,
	                                  fd.get("password") as string,
	                                );
	                                if (res.status !== "success") {
	                                  if (res.status === "invalid_password") {
	                                    setLandingLoginError(
	                                      "Incorrect password. Please try again.",
	                                    );
	                                  } else if (res.status === "email_not_found") {
	                                    setLandingLoginError(
	                                      "We could not find that email.",
	                                    );
	                                  } else {
	                                    const issue = classifyNetworkIssue(
	                                      (res as any)?.message ?? null,
	                                    );
	                                    setLandingLoginError(
	                                      issue === "offline"
	                                        ? "No internet connection detected. Please turn on Wi‑Fi or cellular data and try again."
	                                        : issue === "network"
	                                          ? "Can't reach PepPro right now. This usually means your internet is offline or very slow. Please check your connection and try again."
	                                          : "Unable to log in. Please try again.",
	                                    );
	                                  }
	                                }
	                              } catch (error) {
	                                console.warn("[Landing Login] Failed", error);
	                                const issue = classifyNetworkIssue(
	                                  error instanceof Error ? error.message : null,
	                                );
	                                setLandingLoginError(
	                                  issue === "offline"
	                                    ? "No internet connection detected. Please turn on Wi‑Fi or cellular data and try again."
	                                    : issue === "network"
	                                      ? "We cannot reach the PepPro serverright now. Please check your connection and try again in a minute."
	                                      : "Unable to log in. Please try again.",
	                                );
	                              } finally {
	                                setLandingLoginPending(false);
	                              }
	                            }}
                            className="space-y-3"
                            autoComplete="on"
                          >
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-username"
                                className="text-sm font-medium"
                              >
                                Email
                              </label>
                              <div className="flex items-center gap-2">
                                <input
                                  ref={landingLoginEmailRef}
                                  id="landing-username"
                                  name="username"
                                  type="text"
                                  autoComplete="username"
                                  inputMode="email"
                                  autoCapitalize="none"
                                  autoCorrect="off"
                                  spellCheck={false}
                                  required
                                  onFocus={handleLandingCredentialFocus}
                                  className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                              </div>
                              {/* Hidden field to hint WebAuthn conditional UI to the browser */}
                              <input
                                type="text"
                                autoComplete="webauthn"
                                aria-hidden="true"
                                tabIndex={-1}
                                style={{
                                  position: "absolute",
                                  left: "-9999px",
                                  top: "auto",
                                  width: "1px",
                                  height: "1px",
                                  opacity: 0,
                                }}
                              />
                            </div>
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-password"
                                className="text-sm font-medium"
                              >
                                Password
                              </label>
                              <div className="relative">
                                <input
                                  ref={landingLoginPasswordRef}
                                  id="landing-password"
                                  name="password"
                                  type={
                                    showLandingLoginPassword
                                      ? "text"
                                      : "password"
                                  }
                                  autoComplete="current-password"
                                  autoCorrect="off"
                                  spellCheck={false}
                                  required
                                  onFocus={handleLandingCredentialFocus}
                                  className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowLandingLoginPassword((p) => !p)
                                  }
                                  className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
                                  aria-label={
                                    showLandingLoginPassword
                                      ? "Hide password"
                                      : "Show password"
                                  }
                                  aria-pressed={showLandingLoginPassword}
                                >
                                  {showLandingLoginPassword ? (
                                    <Eye className="h-5 w-5" />
                                  ) : (
                                    <EyeOff className="h-5 w-5" />
                                  )}
                                </button>
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
                                <p>
                                  Forgot your password?{" "}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateLandingAuthMode("forgot")
                                    }
                                    className="font-semibold hover:underline btn-hover-lighter"
                                    style={{ color: "rgb(95, 179, 249)" }}
                                  >
                                    Reset it
                                  </button>
                                </p>
                                {passkeySupport.platform && (
                                  <button
                                    type="button"
                                    onClick={handleManualPasskeyLogin}
                                    disabled={passkeyLoginPending}
                                    className="inline-flex items-center gap-1 font-semibold text-transparent hover:text-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter disabled:opacity-50 disabled:cursor-not-allowed"
                                    aria-label="Sign in with a passkey (biometrics)"
                                    style={{
                                      backgroundColor: "transparent",
                                      borderColor: "transparent",
                                    }}
                                  >
                                    {passkeyLoginPending ? (
                                      <Loader2
                                        className="h-4 w-4 animate-spin-slow"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <Fingerprint
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span className="sr-only">
                                      Sign in with passkey
                                    </span>
                                  </button>
                                )}
                              </div>
                            </div>
                            {landingLoginError && (
                              <p className="text-sm text-red-600" role="alert">
                                {landingLoginError}
                              </p>
                            )}
                            <div className="space-y-2">
                              <Button
                                type="submit"
                                size="lg"
                                className="mt-2 w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                                disabled={landingLoginPending}
                              >
                                {landingLoginPending && (
                                  <Loader2
                                    className="h-4 w-4 animate-spin-slow text-white shrink-0"
                                    aria-hidden="true"
                                    style={{
                                      transformOrigin: "center center",
                                      transform: "translateZ(0)",
                                    }}
                                  />
                                )}
                                {landingLoginPending
                                  ? "Signing in…"
                                  : "Sign In"}
                              </Button>
                              <p className="text-center text-sm text-gray-600">
                                Have a referral code?{" "}
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateLandingAuthMode("signup")
                                  }
                                  className="font-semibold hover:underline btn-hover-lighter"
                                  style={{ color: "rgb(95, 179, 249)" }}
                                >
                                  Create an account
                                </button>
                              </p>
                            </div>
                          </form>
                        </>
                      )}
                      {landingAuthMode === "forgot" && (
                        <>
                          <div className="text-center space-y-2">
                            <h1 className="text-2xl font-semibold">
                              Reset your password
                            </h1>
                            <p className="text-sm text-gray-600">
                              Enter the email associated with your account and
                              we&rsquo;ll send you a secure link.
                            </p>
                          </div>
                          <form
                            onSubmit={handlePasswordResetRequestSubmit}
                            className="space-y-3"
                          >
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-reset-email"
                                className="text-sm font-medium"
                              >
                                Email
                              </label>
                              <input
                                id="landing-reset-email"
                                type="email"
                                required
                                value={passwordResetEmail}
                                onChange={(event) => {
                                  setPasswordResetEmail(event.target.value);
                                  if (passwordResetRequestError) {
                                    setPasswordResetRequestError("");
                                  }
                                  if (passwordResetRequestSuccess) {
                                    setPasswordResetRequestSuccess(false);
                                  }
                                }}
                                className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                              />
                            </div>
                            {passwordResetRequestError && (
                              <p className="text-sm text-red-600" role="alert">
                                {passwordResetRequestError}
                              </p>
                            )}
                            {passwordResetRequestSuccess && (
                              <p
                                className="text-sm text-emerald-600"
                                role="status"
                              >
                                Your reset link will likely arrive in your spam folder within the next 30 seconds.
                              </p>
                            )}
                            <Button
                              type="submit"
                              size="lg"
                              className="w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                              disabled={passwordResetRequestPending}
                            >
                              {passwordResetRequestPending
                                ? "Sending…"
                                : passwordResetRequestSuccess
                                  ? "Reset link sent"
                                  : "Send reset link"}
                            </Button>
                          </form>
                          <div className="text-center text-sm text-gray-600">
                            <button
                              type="button"
                              onClick={() => closeResetWindow()}
                              className="font-semibold hover:underline btn-hover-lighter"
                              style={{ color: "rgb(95, 179, 249)" }}
                            >
                              Return to sign in
                            </button>
                          </div>
                        </>
                      )}
                      {landingAuthMode === "reset" && (
                        <>
                          <div className="text-center space-y-2">
                            <h1 className="text-2xl font-semibold">
                              Choose a new password
                            </h1>
                            <p className="text-sm text-gray-600">
                              {resetPasswordToken
                                ? "Create a new password to secure your account."
                                : "This reset link is invalid or expired. Request a new one to continue."}
                            </p>
                          </div>
                          {!resetPasswordSuccess && (
                            <form
                              onSubmit={handlePasswordResetSubmit}
                              className="space-y-3"
                            >
                              <div className="space-y-2">
                                <label
                                  htmlFor="landing-new-password"
                                  className="text-sm font-medium"
                                >
                                  New password
                                </label>
                                <div className="relative">
                                  <input
                                    id="landing-new-password"
                                    type={
                                      showResetPassword ? "text" : "password"
                                    }
                                    value={resetPasswordValue}
                                    onChange={(event) =>
                                      setResetPasswordValue(event.target.value)
                                    }
                                    required
                                    disabled={!resetPasswordToken}
                                    className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-slate-50 disabled:text-slate-500"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setShowResetPassword((prev) => !prev)
                                    }
                                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
                                    aria-label={
                                      showResetPassword
                                        ? "Hide new password"
                                        : "Show new password"
                                    }
                                    aria-pressed={showResetPassword}
                                  >
                                    {showResetPassword ? (
                                      <Eye className="h-5 w-5" />
                                    ) : (
                                      <EyeOff className="h-5 w-5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                              <div className="space-y-2">
                                <label
                                  htmlFor="landing-confirm-password"
                                  className="text-sm font-medium"
                                >
                                  Confirm password
                                </label>
                                <div className="relative">
                                  <input
                                    id="landing-confirm-password"
                                    type={
                                      showResetPasswordConfirm
                                        ? "text"
                                        : "password"
                                    }
                                    value={resetPasswordConfirmValue}
                                    onChange={(event) =>
                                      setResetPasswordConfirmValue(
                                        event.target.value,
                                      )
                                    }
                                    required
                                    disabled={!resetPasswordToken}
                                    className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-slate-50 disabled:text-slate-500"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setShowResetPasswordConfirm(
                                        (prev) => !prev,
                                      )
                                    }
                                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
                                    aria-label={
                                      showResetPasswordConfirm
                                        ? "Hide confirm password"
                                        : "Show confirm password"
                                    }
                                    aria-pressed={showResetPasswordConfirm}
                                  >
                                    {showResetPasswordConfirm ? (
                                      <Eye className="h-5 w-5" />
                                    ) : (
                                      <EyeOff className="h-5 w-5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                              {resetPasswordError && (
                                <p
                                  className="text-sm text-red-600"
                                  role="alert"
                                >
                                  {resetPasswordError}
                                </p>
                              )}
                              <Button
                                type="submit"
                                size="lg"
                                className="w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                                disabled={
                                  !resetPasswordToken || resetPasswordPending
                                }
                              >
                                {resetPasswordPending
                                  ? "Updating…"
                                  : "Update password"}
                              </Button>
                            </form>
                          )}
                          {resetPasswordSuccess && (
                            <div className="space-y-3 text-center">
                              <p
                                className="text-sm text-emerald-600"
                                role="status"
                              >
                                {resetPasswordSuccess}
                              </p>
                              <Button
                                type="button"
                                size="lg"
                                className="w-full squircle-sm glass-brand btn-hover-lighter"
                                onClick={() => closeResetWindow()}
                              >
                                Return to sign in
                              </Button>
                            </div>
                          )}
                          {!resetPasswordToken && !resetPasswordSuccess && (
                            <div className="text-center text-sm text-gray-600">
                              <button
                                type="button"
                                onClick={() => updateLandingAuthMode("forgot")}
                                className="font-semibold hover:underline btn-hover-lighter"
                                style={{ color: "rgb(95, 179, 249)" }}
                              >
                                Request a new reset link
                              </button>
                            </div>
                          )}
                          <div className="text-center text-sm text-gray-600">
                            <button
                              type="button"
                              onClick={() => updateLandingAuthMode("login")}
                              className="font-semibold hover:underline btn-hover-lighter"
                              style={{ color: "rgb(95, 179, 249)" }}
                            >
                              Back to sign in
                            </button>
                          </div>
                        </>
                      )}
	                      {landingAuthMode === "signup" && (
	                        <>
	                          <div className="text-center space-y-2">
	                            <h1 className="text-2xl font-semibold">
	                              Join the PepPro Network
	                            </h1>
	                          </div>
	                          <form
                            onSubmit={async (e) => {
                              e.preventDefault();
                              setLandingSignupError("");
                              const fd = new FormData(e.currentTarget);
                              const suffix = (fd.get("suffix") as string) || "";
                              const nameOnly = (fd.get("name") as string) || "";
                              const fullName = suffix
                                ? `${suffix} ${nameOnly}`.trim()
                                : nameOnly;
                              const details = {
                                name: fullName,
                                email: (fd.get("email") as string) || "",
                                password: (fd.get("password") as string) || "",
                                confirmPassword:
                                  (fd.get("confirm") as string) || "",
                                code: (
                                  (fd.get("code") as string) || ""
                                ).toUpperCase(),
                                npiNumber:
                                  (fd.get("npiNumber") as string) || "",
                              };
                              const res = await handleCreateAccount(details);
                              if (res.status === "success") {
                                updateLandingAuthMode("login");
                              } else if (res.status === "email_exists") {
                                setLandingSignupError(
                                  "An account with this email already exists. Please sign in.",
                                );
                              } else if (
                                res.status === "invalid_referral_code"
                              ) {
                                setLandingSignupError(
                                  "Referral codes must be 5 characters (e.g., AB123).",
                                );
                              } else if (
                                res.status === "referral_code_not_found"
                              ) {
                                setLandingSignupError(
                                  "We couldn't locate that referral code. Please confirm it with your representative.",
                                );
	                              } else if (
	                                res.status === "referral_code_unavailable"
	                              ) {
	                                setLandingSignupError(
	                                  "This onboarding code isn't available. Please confirm it with your representative.",
	                                );
	                              } else if (res.status === "name_email_required") {
	                                setLandingSignupError(
	                                  "Name and email are required to create your account.",
	                                );
                              } else if (res.status === "password_mismatch") {
                                setLandingSignupError(
                                  "Passwords do not match. Please confirm and try again.",
                                );
                              } else if (res.status === "invalid_npi") {
                                setLandingSignupError(
                                  "Enter a valid 10-digit NPI number assigned to you by CMS.",
                                );
                              } else if (res.status === "npi_not_found") {
                                setLandingSignupError(
                                  "We couldn't verify that NPI number in the CMS registry. Please double-check and try again.",
                                );
                              } else if (
                                res.status === "npi_already_registered"
                              ) {
                                setLandingSignupError(
                                  "An account already exists for this NPI number. Please sign in or contact support@peppro.net.",
                                );
                              } else if (
                                res.status === "npi_verification_failed"
                              ) {
                                setLandingSignupError(
                                  "We were unable to reach the CMS NPI registry. Please try again in a moment.",
                                );
                              } else if (res.status === "error") {
                                if (res.message === "PASSWORD_REQUIRED") {
                                  setLandingSignupError(
                                    "Please create a secure password to access your account.",
                                  );
                                } else if (res.message) {
                                  setLandingSignupError(res.message);
                                } else {
                                  setLandingSignupError(
                                    "Unable to create account. Please try again.",
                                  );
                                }
                              }
                            }}
                            className="space-y-4"
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                              <div className="space-y-2 sm:w-36">
                                <label
                                  htmlFor="landing-suffix"
                                  className="text-sm font-medium"
                                >
                                  <span>Suffix</span>
                                  <span className="ml-2 text-xs font-normal text-gray-500">
                                    Optional
                                  </span>
                                </label>
                                <select
                                  id="landing-suffix"
                                  name="suffix"
                                  className="glass squircle-sm w-full px-3 text-sm border transition-colors focus-visible:outline-none focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)] leading-tight"
                                  style={{
                                    borderColor: "rgba(95,179,249,0.18)",
                                    backgroundColor: "rgba(95,179,249,0.02)",
                                    WebkitAppearance: "none" as any,
                                    MozAppearance: "none" as any,
                                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23071b1b' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                                    backgroundRepeat: "no-repeat",
                                    backgroundPosition: "right 0.75rem center",
                                    backgroundSize: "12px",
                                    paddingRight: "2.5rem",
                                    height: "2.5rem",
                                    lineHeight: "1.25rem",
                                  }}
                                >
                                  <option value="">None</option>
                                  <option value="Mr.">Mr.</option>
                                  <option value="Mrs.">Mrs.</option>
                                  <option value="Ms.">Ms.</option>
                                  <option value="Mx.">Mx.</option>
                                  <option value="Dr.">Dr.</option>
                                  <option value="Prof.">Prof.</option>
                                  <option value="Sir">Sir</option>
                                  <option value="Dame">Dame</option>
                                </select>
                              </div>
                              <div className="flex-1 space-y-2">
                                <label
                                  htmlFor="landing-name"
                                  className="text-sm font-medium"
                                >
                                  Full Name
                                </label>
                                <input
                                  id="landing-name"
                                  name="name"
                                  type="text"
                                  required
                                  className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                              </div>
                            </div>
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-email2"
                                className="text-sm font-medium"
                              >
                                Email
                              </label>
                              <input
                                id="landing-email2"
                                name="email"
                                type="email"
                                required
                                className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                              />
                            </div>
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-password2"
                                className="text-sm font-medium"
                              >
                                Password
                              </label>
                              <div className="relative">
                                <input
                                  id="landing-password2"
                                  name="password"
                                  type={
                                    showLandingSignupPassword
                                      ? "text"
                                      : "password"
                                  }
                                  required
                                  autoComplete="new-password"
                                  className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowLandingSignupPassword((p) => !p)
                                  }
                                  className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
                                  aria-label={
                                    showLandingSignupPassword
                                      ? "Hide password"
                                      : "Show password"
                                  }
                                  aria-pressed={showLandingSignupPassword}
                                >
                                  {showLandingSignupPassword ? (
                                    <Eye className="h-5 w-5" />
                                  ) : (
                                    <EyeOff className="h-5 w-5" />
                                  )}
                                </button>
                              </div>
                            </div>
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-confirm"
                                className="text-sm font-medium"
                              >
                                Confirm Password
                              </label>
                              <div className="relative">
                                <input
                                  id="landing-confirm"
                                  name="confirm"
                                  type={
                                    showLandingSignupConfirm
                                      ? "text"
                                      : "password"
                                  }
                                  required
                                  autoComplete="new-password"
                                  className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowLandingSignupConfirm((p) => !p)
                                  }
                                  className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
                                  aria-label={
                                    showLandingSignupConfirm
                                      ? "Hide confirm password"
                                      : "Show confirm password"
                                  }
                                  aria-pressed={showLandingSignupConfirm}
                                >
                                  {showLandingSignupConfirm ? (
                                    <Eye className="h-5 w-5" />
                                  ) : (
                                    <EyeOff className="h-5 w-5" />
                                  )}
                                </button>
                              </div>
                            </div>
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-npi"
                                className="text-sm font-medium"
                              >
                                NPI Number
                              </label>
                              <input
                                id="landing-npi"
                                name="npiNumber"
                                type="text"
                                inputMode="numeric"
                                pattern="\d*"
                                maxLength={10}
                                placeholder="10-digit NPI"
                                onInput={(event) => {
                                  const target = event.currentTarget;
                                  const digits = target.value
                                    .replace(/[^0-9]/g, "")
                                    .slice(0, 10);
                                  target.value = digits;
                                  handleLandingNpiInputChange(digits);
                                }}
                                className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                              />
                              <p
                                className={`text-xs ${
                                  landingNpiStatus === "verified"
                                    ? "text-emerald-600"
                                    : landingNpiStatus === "rejected"
                                      ? "text-red-600"
                                      : "text-slate-500"
                                }`}
                              >
                                {landingNpiStatus === "idle" &&
                                  "We securely verify your medical credentials with the CMS NPI registry."}
                                {landingNpiStatus === "checking" &&
                                  "Contacting the CMS NPI registry..."}
                                {landingNpiStatus === "verified" && (
                                  <span className="inline-flex items-center gap-1">
                                    <span
                                      className="npi-checkmark"
                                      aria-hidden="true"
                                    >
                                      ✔
                                    </span>
                                    {landingNpiMessage ||
                                      "NPI verified with the CMS registry."}
                                  </span>
                                )}
                                {landingNpiStatus === "rejected" &&
                                  (landingNpiMessage ||
                                    "We were unable to verify this NPI number. Please double-check and try again.")}
                              </p>
                            </div>
                            <div className="space-y-2">
                              <label
                                htmlFor="landing-code"
                                className="text-sm font-medium"
                              >
                                Referral Code
                              </label>
                              <input
                                id="landing-code"
                                name="code"
                                type="text"
                                required
                                maxLength={5}
                                inputMode="text"
                                pattern="[A-Z0-9]*"
                                autoComplete="off"
                                onInput={(event) => {
                                  const target = event.currentTarget;
                                  target.value = target.value
                                    .toUpperCase()
                                    .replace(/[^A-Z0-9]/g, "")
                                    .slice(0, 5);
                                }}
                                className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                                style={{ textTransform: "uppercase" }}
                              />
                              <p className="text-xs text-slate-500">
                                Codes are 5 characters and issued by your
                                representative.
                              </p>
                            </div>
                            {landingSignupError && (
                              <p className="text-sm text-red-600" role="alert">
                                {landingSignupError}
                              </p>
                            )}
                            <div className="space-y-2">
                              <Button
                                type="submit"
                                size="lg"
                                className="mt-2 w-full squircle-sm glass-brand btn-hover-lighter"
                              >
                                Create Account
                              </Button>
                              <p className="text-center text-sm text-gray-600">
                                Already have an account?{" "}
                                <button
                                  type="button"
                                  onClick={() => updateLandingAuthMode("login")}
                                  className="font-semibold hover:underline btn-hover-lighter"
                                  style={{ color: "rgb(95, 179, 249)" }}
                                >
                                  Sign in
                                </button>
                              </p>
                            </div>
                          </form>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

	          {/* Main Content */}
	          {user && !postLoginHold && (
	            <main
	              className="w-full pb-12 mobile-safe-area"
	              style={{
	                paddingTop: "calc(var(--app-header-height, 0px) + 1rem)",
	              }}
	            >
	              {isRep(user.role) || isAdmin(user.role)
	                ? renderSalesRepDashboard()
	                : renderDoctorDashboard()}
	              {renderProductSection()}
            </main>
          )}
        </div>

      {user ? (
        <LegalFooter showContactCTA={false} variant="full" />
      ) : (
        <LegalFooter showContactCTA variant="ctaOnly" />
      )}
      </div>

      {/* Checkout Modal */}
      <CheckoutModal
        isOpen={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        cartItems={cartItems}
        onCheckout={handleCheckout}
        onClearCart={() => setCartItems([])}
        onPaymentSuccess={() => {
          const requestToken = Date.now();
          const optimisticOrder = postCheckoutOptimisticOrderRef.current;
          setAccountModalRequest({
            tab: "orders",
            open: true,
            token: requestToken,
            order: optimisticOrder ?? undefined,
          });
          triggerPostCheckoutOrdersRefresh().catch(() => undefined);
          setTimeout(() => {
            setAccountModalRequest((prev) =>
              prev && prev.token === requestToken ? null : prev,
            );
          }, 2500);
        }}
        onUpdateItemQuantity={handleUpdateCartItemQuantity}
        onRemoveItem={handleRemoveCartItem}
        isAuthenticated={Boolean(user)}
        onRequireLogin={handleRequireLogin}
        physicianName={user?.npiVerification?.name || user?.name || null}
        customerEmail={user?.email || null}
        customerName={user?.name || null}
        defaultShippingAddress={checkoutDefaultShippingAddress}
        availableCredits={availableReferralCredits}
        pricingMode={checkoutPricingMode}
        onPricingModeChange={setCheckoutPricingMode}
        showRetailPricingToggle={canUseRetailPricing}
      />

      <Dialog
        open={showManualProspectModal}
        onOpenChange={(open) => {
          if (!open) {
            closeManualProspectModal();
          } else {
            setShowManualProspectModal(true);
          }
        }}
      >
        <DialogContent
          style={{ maxWidth: "min(960px, calc(100vw - 3rem))" }}
        >
          <DialogHeader>
            <DialogTitle>Enter Prospect</DialogTitle>
            <DialogDescription>
              Create a manual prospect entry to jumpstart the pipeline.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={handleManualProspectSubmit}
          >
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">
                Name
              </label>
              <Input
                value={manualProspectForm.name}
                onChange={(event) =>
                  setManualProspectForm((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                required
                placeholder="Prospect name"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Email
                </label>
                <Input
                  type="email"
                  value={manualProspectForm.email}
                  onChange={(event) =>
                    setManualProspectForm((prev) => ({
                      ...prev,
                      email: event.target.value,
                    }))
                  }
                  placeholder="prospect@email.com"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Phone
                </label>
                <Input
                  value={manualProspectForm.phone}
                  onChange={(event) =>
                    setManualProspectForm((prev) => ({
                      ...prev,
                      phone: event.target.value,
                    }))
                  }
                  placeholder="(555) 000-0000"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">
                Notes
              </label>
	              <Textarea
	                value={manualProspectForm.notes}
	                onChange={(event) =>
	                  setManualProspectForm((prev) => ({
	                    ...prev,
	                    notes: event.target.value,
	                  }))
	                }
	                rows={3}
	                placeholder="Add optional context"
	                className="notes-textarea"
	              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">
                Status
              </label>
              <select
                value={manualProspectForm.status}
                onChange={(event) =>
                  setManualProspectForm((prev) => ({
                    ...prev,
                    status: event.target.value,
                  }))
                }
                className="w-full rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
              >
                {REFERRAL_STATUS_FLOW_SELECT.map((stage) => (
                  <option key={stage.key} value={stage.key}>
                    {stage.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={closeManualProspectModal}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={manualProspectSubmitting}
                className="squircle-sm glass-brand"
              >
                {manualProspectSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </span>
                ) : (
                  "Save Prospect"
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(salesDoctorDetail)}
        onOpenChange={(open) => {
          if (!open) {
            setSalesDoctorDetail(null);
            setSalesDoctorDetailLoading(false);
          }
        }}
	      >
	        <DialogContent className="max-w-2xl">
          {salesDoctorDetailLoading ? (
              <>
                <VisuallyHidden>
                  <DialogTitle>Loading account details</DialogTitle>
                  <DialogDescription>Fetching account details.</DialogDescription>
                </VisuallyHidden>
                {renderSalesDoctorDetailSkeleton()}
              </>
            ) : (
              salesDoctorDetail && (
	            <div className="space-y-4">
			              <DialogHeader>
			                <DialogTitle className="space-y-0.5">
			                  <div className="text-slate-900">{salesDoctorDetail.name}</div>
				                  <div className="text-sm font-normal text-slate-600">
				                    {salesDoctorDetail.email ? (
				                      <a href={`mailto:${salesDoctorDetail.email}`} className="hover:underline">
				                        {salesDoctorDetail.email}
				                      </a>
				                    ) : (
				                      "—"
				                    )}
				                  </div>
					                  {(isAdmin(user?.role) || isSalesLead(user?.role)) &&
					                    isDoctorRole(salesDoctorDetail.role) && (
					                      <div className="text-sm font-normal text-slate-600">
					                        {(() => {
					                          const ownerId = String(
					                            salesDoctorDetail.ownerSalesRepId || "",
					                          ).trim();
				                          if (!ownerId) {
				                            return "Sales Rep: Unassigned";
				                          }
					                          const ownerProfile =
					                            salesDoctorOwnerRepProfiles[ownerId] || null;
					                          const name =
					                            ownerProfile?.name ||
					                            (() => {
					                              const reps = (salesRepDashboard as any)?.salesReps;
					                              if (!Array.isArray(reps)) return null;
					                              const hit = reps.find(
					                                (rep: any) =>
					                                  String(rep?.id || "") === String(ownerId),
					                              );
					                              const repName =
					                                typeof hit?.name === "string" ? hit.name.trim() : "";
					                              return repName.length ? repName : null;
					                            })() ||
					                            null;
					                          const email = ownerProfile?.email || null;
					                          const userId = ownerProfile?.userId || null;
					                          const role = normalizeRole(
					                            ownerProfile?.role || "sales_rep",
					                          );
					                          const content = name || ownerId;
					                          const resolved = Boolean(name);
					                          const canOpen = Boolean(userId);
					                          return (
					                            <span>
					                              <span className="text-slate-600">Sales Rep: </span>
					                              {canOpen ? (
					                                <button
					                                  type="button"
					                                  onClick={() =>
					                                    openLiveUserDetail({
					                                      id: userId,
					                                      name: name || undefined,
					                                      email: email || undefined,
					                                      role: role || "sales_rep",
					                                    })
					                                  }
					                                  className="text-slate-600 hover:underline"
					                                  title="Open sales rep"
					                                >
					                                  {content}
					                                </button>
					                              ) : (
					                                <span className="inline-flex items-center gap-2">
					                                  <span
					                                    className="text-slate-600"
					                                    title="Sales rep user profile unavailable"
					                                  >
					                                    {content}
					                                  </span>
					                                  {!resolved && (
					                                    <button
					                                      type="button"
					                                      onClick={async () => {
					                                        try {
					                                          const doctorId = String(
					                                            salesDoctorDetail?.doctorId || "",
					                                          );
					                                          const doctorMeta =
					                                            (doctorId &&
					                                              salesTrackingDoctors?.get?.(doctorId)) ||
					                                            null;
					                                          const dashboardReps = (salesRepDashboard as any)
					                                            ?.salesReps;
					                                          const dashboardRepsArray = Array.isArray(
					                                            dashboardReps,
					                                          )
					                                            ? dashboardReps
					                                            : null;
					                                          const dashboardHit =
					                                            dashboardRepsArray?.find(
					                                              (rep: any) =>
					                                                String(rep?.id || "") ===
					                                                String(ownerId),
					                                            ) || null;
					                                          const firstOrder =
					                                            Array.isArray(salesDoctorDetail?.orders) &&
					                                            salesDoctorDetail.orders.length > 0
					                                              ? (salesDoctorDetail.orders[0] as any)
					                                              : null;
					                                          const payload = {
					                                            ownerId,
					                                            doctorId,
					                                            salesRepDashboard: {
					                                              hasSalesReps:
					                                                Boolean(dashboardRepsArray),
					                                              salesRepsCount:
					                                                dashboardRepsArray?.length ?? null,
					                                              match: dashboardHit
					                                                ? {
					                                                    id: dashboardHit?.id ?? null,
					                                                    name: dashboardHit?.name ?? null,
					                                                    email: dashboardHit?.email ?? null,
					                                                  }
					                                                : null,
					                                            },
					                                            doctorMeta: doctorMeta
					                                              ? {
					                                                  salesRepId:
					                                                    (doctorMeta as any)?.salesRepId || null,
					                                                  salesRepName:
					                                                    (doctorMeta as any)?.salesRepName || null,
					                                                  salesRepEmail:
					                                                    (doctorMeta as any)?.salesRepEmail || null,
					                                                }
					                                              : null,
					                                            firstOrder: firstOrder
					                                              ? {
					                                                  id: firstOrder?.id || null,
					                                                  number: firstOrder?.number || null,
					                                                  userId: firstOrder?.userId || null,
					                                                  doctorSalesRepId:
					                                                    firstOrder?.doctorSalesRepId ||
					                                                    firstOrder?.doctor_sales_rep_id ||
					                                                    null,
					                                                  doctorSalesRepName:
					                                                    firstOrder?.doctorSalesRepName ||
					                                                    firstOrder?.doctor_sales_rep_name ||
					                                                    null,
					                                                  salesRepId:
					                                                    firstOrder?.salesRepId ||
					                                                    firstOrder?.sales_rep_id ||
					                                                    null,
					                                                  salesRepName:
					                                                    firstOrder?.salesRepName ||
					                                                    firstOrder?.sales_rep_name ||
					                                                    null,
					                                                  salesRep:
					                                                    firstOrder?.salesRep ||
					                                                    firstOrder?.sales_rep ||
					                                                    null,
					                                                }
					                                              : null,
					                                          };
					                                          await navigator.clipboard.writeText(
					                                            JSON.stringify(payload, null, 2),
					                                          );
					                                          toast.success("Copied sales rep debug.");
					                                        } catch (error) {
					                                          toast.error("Could not copy debug.");
					                                          console.warn(
					                                            "[Sales Rep] Copy debug failed",
					                                            error,
					                                          );
					                                        }
					                                      }}
					                                      className="text-[11px] text-slate-400 hover:text-slate-600 hover:underline"
					                                      title="Copy debug info"
					                                    >
					                                      Copy debug
					                                    </button>
					                                  )}
					                                </span>
					                              )}
					                            </span>
					                          );
					                        })()}
					                      </div>
				                    )}
				                </DialogTitle>
				                <DialogDescription>Account details</DialogDescription>
				              </DialogHeader>
		              {salesDoctorDetail && isDoctorRole(salesDoctorDetail.role) && (
		                <div className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 space-y-2 min-h-[240px]">
		                  <p className="text-sm font-semibold justify-center text-slate-800">
                        Shared Notes (Rep and Admin only)
		                  </p>
		                  <Textarea
		                    value={salesDoctorNoteDraft}
		                    onChange={(event) => setSalesDoctorNoteDraft(event.target.value)}
		                    rows={4}
		                    placeholder={
		                      salesDoctorNotesLoading
		                        ? "Loading notes..."
		                        : "Add notes about this doctor"
		                    }
		                    className="text-sm notes-textarea"
		                    disabled={salesDoctorNotesLoading}
		                  />
		                  <div className="mt-2 mb-1 flex items-center justify-end gap-2">
		                    {salesDoctorNotesSaved && (
		                      <CheckSquare className="h-4 w-4 text-emerald-600" />
		                    )}
		                    <Button
		                      type="button"
		                      variant="outline"
		                      onClick={() => void saveSalesDoctorNotes()}
		                      className="h-8 px-3 text-xs"
		                      disabled={salesDoctorNotesLoading}
		                    >
		                      Save
		                    </Button>
		                  </div>
		                </div>
		              )}
		              <div className="flex items-center gap-4">
		                <div
		                  className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm"
			                  style={{
			                    width: 72,
			                    height: 72,
			                    minWidth: 72,
			                    boxShadow: (() => {
			                      const isOnlineNow = salesDoctorDetail?.isOnline === true;
			                      const idleFlag = salesDoctorDetail?.isIdle === true;
			                      const idleMinutes =
			                        typeof salesDoctorDetail?.idleMinutes === "number" &&
			                        Number.isFinite(salesDoctorDetail.idleMinutes)
			                          ? salesDoctorDetail.idleMinutes
			                          : null;
			                      if (!isOnlineNow) {
			                        return undefined;
			                      }
			                      const minutesSinceLastSeen = (() => {
			                        const raw =
			                          salesDoctorDetail?.lastInteractionAt ||
			                          salesDoctorDetail?.lastSeenAt ||
			                          salesDoctorDetail?.lastLoginAt ||
			                          null;
			                        if (!raw) return null;
			                        const ts = new Date(raw).getTime();
			                        if (!Number.isFinite(ts)) return null;
			                        return Math.max(0, (Date.now() - ts) / 60000);
			                      })();
			                      const showIdle =
			                        idleFlag ||
			                        (idleMinutes != null && idleMinutes >= 2) ||
			                        (minutesSinceLastSeen != null && minutesSinceLastSeen >= 2);
			                      return showIdle
			                        ? "0 0 0 1px rgba(255,255,255,1), 0 0 0 4px rgba(148,163,184,1)"
			                        : "0 0 0 1px rgba(255,255,255,1), 0 0 0 4px rgba(95,179,249,1)";
			                    })(),
			                  }}
			                >
                  {salesDoctorDetail.avatar ? (
                    <img
                      src={salesDoctorDetail.avatar}
                      alt={salesDoctorDetail.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-lg font-semibold text-slate-600">
                      {getInitials(salesDoctorDetail.name)}
                    </span>
	                  )}
	                </div>
	                <div className="space-y-1">
		                    {(isRep(salesDoctorDetail.role) ||
	                        typeof salesDoctorDetail.personalRevenue === "number" ||
	                        typeof salesDoctorDetail.salesRevenue === "number") ? (
		                      <>
		                        <p className="text-sm text-slate-600">
		                          Personal Revenue:{" "}
		                          {formatCurrency(
		                            salesDoctorDetail.personalRevenue ?? salesDoctorDetail.revenue,
		                          )}
		                        </p>
		                        <p className="text-sm text-slate-600">
		                          Sales Revenue:{" "}
		                          {formatCurrency(salesDoctorDetail.salesRevenue ?? 0)}
		                        </p>
			                        {(() => {
			                          const role = normalizeRole(salesDoctorDetail.role || "");
			                          const formatPeriodLabel = (
			                            periodStart?: string | null,
			                            periodEnd?: string | null,
			                          ) => {
			                            const start = periodStart ? formatDate(String(periodStart)) : null;
			                            const end = periodEnd ? formatDate(String(periodEnd)) : null;
			                            return start && end && start !== "—" && end !== "—"
			                              ? `${start} to ${end}`
			                              : "All time";
			                          };
			                          const formatDateObject = (date?: Date | null) => {
			                            if (!date) return null;
			                            if (Number.isNaN(date.getTime())) return null;
			                            return date.toLocaleDateString(undefined, {
			                              month: "short",
			                              day: "numeric",
			                              year: "numeric",
			                            });
			                          };
			                          const hasCustomRange =
			                            Boolean(salesDoctorCommissionRange?.from) &&
			                            Boolean(salesDoctorCommissionRange?.to);
			                          const customRangeLabel = hasCustomRange
			                            ? (() => {
			                                const start = formatDateObject(salesDoctorCommissionRange?.from || null);
			                                const end = formatDateObject(salesDoctorCommissionRange?.to || null);
			                                return start && end ? `${start} to ${end}` : null;
			                              })()
			                            : null;
			                          const filterOrdersForRange = (
			                            orders: any[],
			                            range?: DateRange,
			                          ) => {
			                            if (!Array.isArray(orders) || orders.length === 0) return [];
			                            const from = range?.from ? new Date(range.from) : null;
			                            const to = range?.to ? new Date(range.to) : null;
			                            if (!from || !to) return orders;
			                            from.setHours(0, 0, 0, 0);
			                            to.setHours(23, 59, 59, 999);
			                            const fromMs = from.getTime();
			                            const toMs = to.getTime();
			                            return orders.filter((order) => {
			                              const raw =
			                                order?.createdAt ||
			                                (order as any)?.created_at ||
			                                (order as any)?.dateCreated ||
			                                (order as any)?.date_created ||
			                                null;
			                              if (!raw) return false;
			                              const ts = new Date(raw).getTime();
			                              if (!Number.isFinite(ts)) return false;
			                              return ts >= fromMs && ts <= toMs;
			                            });
			                          };
			                          if (role === "admin") {
			                            const adminRow = adminCommissionRows.find(
			                              (row) =>
			                                String(row?.id || "") ===
			                                String(salesDoctorDetail.doctorId || ""),
			                            );
			                            const commissionValue = (() => {
			                              if (
			                                Boolean(salesDoctorCommissionRange?.from) &&
			                                Boolean(salesDoctorCommissionRange?.to)
			                              ) {
			                                return typeof salesDoctorCommissionFromReport === "number" &&
			                                  Number.isFinite(salesDoctorCommissionFromReport)
			                                  ? salesDoctorCommissionFromReport
			                                  : null;
			                              }
			                              return adminRow ? Number(adminRow.amount || 0) : null;
			                            })();
			                            const periodLabel = formatPeriodLabel(
			                              adminProductsCommissionMeta?.periodStart ?? null,
			                              adminProductsCommissionMeta?.periodEnd ?? null,
			                            );
			                            return (
			                              <div className="flex items-center gap-2 flex-wrap">
			                                <p className="text-sm text-slate-600">
			                                  Total Commission:{" "}
			                                  {salesDoctorCommissionFromReportLoading
			                                    ? "Loading..."
			                                    : commissionValue == null
			                                      ? "—"
			                                      : formatCurrency(commissionValue)}
			                                </p>
			                                <Popover.Root
			                                  open={salesDoctorCommissionPickerOpen}
			                                  onOpenChange={setSalesDoctorCommissionPickerOpen}
			                                >
			                                  <Popover.Trigger asChild>
				                                    <Button
				                                      type="button"
				                                      variant="outline"
				                                      size="icon"
					                                      className="header-home-button squircle-sm h-8 w-8"
					                                      aria-label="Select commission date range"
					                                    >
				                                      <CalendarDays aria-hidden="true" />
				                                    </Button>
			                                  </Popover.Trigger>
			                                  <Popover.Portal>
			                                    <Popover.Content
			                                      side="bottom"
			                                      align="start"
			                                      sideOffset={8}
				                                      className="calendar-popover z-[10000] w-[320px] glass-liquid rounded-xl border border-white/60 p-3 shadow-xl"
				                                    >
			                                      <div className="text-sm font-semibold text-slate-800">
			                                        Commission timeframe
			                                      </div>
			                                      <div className="mt-2">
			                                        <DayPicker
			                                          mode="range"
			                                          numberOfMonths={1}
			                                          selected={salesDoctorCommissionRange}
			                                          onSelect={(range) => {
			                                            setSalesDoctorCommissionRange(range);
			                                            if (range?.from && range?.to) {
			                                              setSalesRepPeriodStart(formatDateInputValue(range.from));
			                                              setSalesRepPeriodEnd(formatDateInputValue(range.to));
			                                              applyAdminDashboardPeriod();
			                                            }
			                                          }}
			                                          defaultMonth={salesDoctorCommissionRange?.from ?? undefined}
			                                        />
			                                      </div>
			                                      <div className="mt-3 flex items-center justify-between">
			                                        <Button
			                                          type="button"
			                                          variant="ghost"
			                                          size="sm"
			                                          className="text-slate-700"
			                                          onClick={() => {
			                                            const defaults = getDefaultSalesBySalesRepPeriod();
			                                            setSalesDoctorCommissionRange(undefined);
			                                            setSalesRepPeriodStart(defaults.start);
			                                            setSalesRepPeriodEnd(defaults.end);
			                                            applyAdminDashboardPeriod();
			                                          }}
			                                        >
			                                          Default
			                                        </Button>
				                                      <Button
				                                        type="button"
				                                        variant="outline"
				                                        size="sm"
				                                        className="calendar-done-button text-[rgb(95,179,249)] border-[rgba(95,179,249,0.45)] hover:border-[rgba(95,179,249,0.7)] hover:text-[rgb(95,179,249)]"
				                                        onClick={() => setSalesDoctorCommissionPickerOpen(false)}
				                                      >
				                                        Done
				                                      </Button>
			                                      </div>
			                                      <Popover.Arrow className="calendar-popover-arrow" />
			                                    </Popover.Content>
			                                  </Popover.Portal>
			                                </Popover.Root>
			                                <span className="text-sm text-slate-500">
			                                  ({customRangeLabel || periodLabel})
			                                </span>
			                              </div>
			                            );
			                          }
	
			                          const repRow = salesRepSalesSummary.find(
			                            (row) =>
		                              String(row?.salesRepId || "") ===
		                              String(salesDoctorDetail.doctorId || ""),
		                          );
			                          const dateFilteredOrders = filterOrdersForRange(
			                            salesDoctorDetail.orders as any[],
			                            salesDoctorCommissionRange,
			                          );
			                          const commissionOrders = dateFilteredOrders.filter((order) =>
			                            shouldCountRevenueForStatus(order?.status),
			                          );
			                          const totalsFromOrders =
			                            hasCustomRange || commissionOrders.length > 0
			                              ? commissionOrders.reduce(
			                                  (
			                                    acc: { wholesale: number; retail: number },
			                                    order: any,
			                                  ) => {
                                    const amount =
                                      coerceNumber(order?.grandTotal ?? order?.total) || 0;
			                                    const pricingModeRaw =
			                                      order?.pricingMode ||
			                                      (order as any)?.pricing_mode ||
			                                      (order as any)?.pricing ||
			                                      (order as any)?.priceType ||
			                                      null;
			                                    const pricingMode = String(pricingModeRaw || "")
			                                      .toLowerCase()
			                                      .trim();
			                                    if (pricingMode === "wholesale") {
			                                      acc.wholesale += amount;
			                                    } else if (pricingMode === "retail") {
			                                      acc.retail += amount;
			                                    } else {
			                                      acc.retail += amount;
			                                    }
			                                    return acc;
			                                  },
			                                  { wholesale: 0, retail: 0 },
			                                )
			                              : null;
			                          const wholesale = Number(
			                            totalsFromOrders?.wholesale ??
			                              repRow?.wholesaleRevenue ??
			                              salesDoctorDetail.salesWholesaleRevenue ??
			                              0,
			                          );
			                          const retail = Number(
			                            totalsFromOrders?.retail ??
			                              repRow?.retailRevenue ??
			                              salesDoctorDetail.salesRetailRevenue ??
			                              0,
			                          );
			                          if (!Number.isFinite(wholesale) && !Number.isFinite(retail)) {
			                            return null;
			                          }
			                          const fallbackCommission = wholesale * 0.1 + retail * 0.2;
			                          const totalCommission =
			                            typeof salesDoctorCommissionFromReport === "number" &&
			                            Number.isFinite(salesDoctorCommissionFromReport)
			                              ? salesDoctorCommissionFromReport
			                              : fallbackCommission;
			                          const periodLabel = formatPeriodLabel(
			                            salesRepSalesSummaryMeta?.periodStart ?? null,
			                            salesRepSalesSummaryMeta?.periodEnd ?? null,
			                          );
			                          return (
			                            <div className="flex items-center gap-2 flex-wrap">
			                              <p className="text-sm text-slate-600">
			                                Total Commission:{" "}
			                                {salesDoctorCommissionFromReportLoading
			                                  ? "Loading..."
			                                  : formatCurrency(totalCommission)}
			                              </p>
			                              <Popover.Root
			                                open={salesDoctorCommissionPickerOpen}
			                                onOpenChange={setSalesDoctorCommissionPickerOpen}
			                              >
			                                <Popover.Trigger asChild>
				                                  <Button
				                                    type="button"
				                                    variant="outline"
				                                    size="icon"
					                                    className="header-home-button squircle-sm h-8 w-8"
					                                    aria-label="Select commission date range"
					                                  >
				                                    <CalendarDays aria-hidden="true" />
				                                  </Button>
			                                </Popover.Trigger>
			                                <Popover.Portal>
			                                  <Popover.Content
			                                    side="bottom"
			                                    align="start"
			                                    sideOffset={8}
				                                    className="calendar-popover z-[10000] w-[320px] glass-liquid rounded-xl border border-white/60 p-3 shadow-xl"
				                                  >
			                                    <div className="text-sm font-semibold text-slate-800">
			                                      Commission timeframe
			                                    </div>
			                                    <div className="mt-2">
			                                      <DayPicker
			                                        mode="range"
			                                        numberOfMonths={1}
			                                        selected={salesDoctorCommissionRange}
			                                        onSelect={setSalesDoctorCommissionRange}
			                                        defaultMonth={salesDoctorCommissionRange?.from ?? undefined}
			                                      />
			                                    </div>
			                                    <div className="mt-3 flex items-center justify-between">
			                                      <Button
			                                        type="button"
			                                        variant="ghost"
			                                        size="sm"
			                                        className="text-slate-700"
			                                        onClick={() => setSalesDoctorCommissionRange(undefined)}
			                                      >
			                                        All time
			                                      </Button>
				                                      <Button
				                                        type="button"
				                                        variant="outline"
				                                        size="sm"
				                                        className="calendar-done-button text-[rgb(95,179,249)] border-[rgba(95,179,249,0.45)] hover:border-[rgba(95,179,249,0.7)] hover:text-[rgb(95,179,249)]"
				                                        onClick={() => setSalesDoctorCommissionPickerOpen(false)}
				                                      >
				                                        Done
				                                      </Button>
			                                    </div>
			                                    <Popover.Arrow className="calendar-popover-arrow" />
			                                  </Popover.Content>
			                                </Popover.Portal>
			                              </Popover.Root>
			                              <span className="text-sm text-slate-500">
			                                ({customRangeLabel || periodLabel})
			                              </span>
			                            </div>
			                          );
			                        })()}
		                        {(() => {
		                          // (Total Commission line is rendered above)
		                          return null;
		                        })()}
		                      </>
	                    ) : isDoctorRole(salesDoctorDetail.role) ? (
                      <>
                        <p className="text-sm text-slate-600">
                          Order Quantity:{" "}
                          {salesDoctorDetail.orderQuantity ??
                            salesDoctorDetail.orders.filter((order) =>
                              shouldCountRevenueForStatus(order.status),
                            ).length}
                        </p>
                        <p className="text-sm text-slate-600">
                          Total Order Value:{" "}
                          {formatCurrency(
                            salesDoctorDetail.totalOrderValue ?? salesDoctorDetail.revenue,
                          )}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-slate-600">
                          Orders: {salesDoctorDetail.orders.length}
                        </p>
                        <p className="text-sm text-slate-600">
                          Revenue: {formatCurrency(salesDoctorDetail.revenue)}
                        </p>
                      </>
                    )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-700">
                    Contact
                  </p>
	                  <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm text-slate-700 space-y-1">
	                    <div>
	                      <span className="font-semibold text-slate-800">Email: </span>
	                      {salesDoctorDetail.email ? (
	                        <a href={`mailto:${salesDoctorDetail.email}`}>
	                          {salesDoctorDetail.email}
	                        </a>
	                      ) : (
	                        <span>Unavailable</span>
	                      )}
	                    </div>
	                    <div>
	                      <span className="font-semibold text-slate-800">Phone: </span>
	                      {(() => {
	                        const canEditPhone =
                          Boolean(
                            salesDoctorDetail &&
                              (isAdmin(user?.role) ||
                                (isRep(user?.role) &&
                                  userSalesRepId &&
                                  salesDoctorDetail.ownerSalesRepId &&
                                  userSalesRepId ===
                                    salesDoctorDetail.ownerSalesRepId)),
                          );
                        const trimmedDraft = salesDoctorPhoneDraft.trim();
                        const existingPhone = salesDoctorDetail.phone || "";
                        const hasChanges = trimmedDraft !== existingPhone.trim();
                        if (!canEditPhone) {
                          return (
                            <span>{salesDoctorDetail.phone || "Unavailable"}</span>
                          );
                        }
                        return (
                          <div className="flex flex-col gap-2">
                            <Input
                              type="tel"
                              value={salesDoctorPhoneDraft}
                              onChange={(event) =>
                                setSalesDoctorPhoneDraft(event.target.value)
                              }
                              className="block w-full rounded-md border border-slate-200/80 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-100"
                              placeholder="Enter phone number"
                            />
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              className="self-start whitespace-nowrap"
                              onClick={() => void saveSalesDoctorPhone()}
                              disabled={salesDoctorPhoneSaving || !hasChanges}
                            >
                              {salesDoctorPhoneSaving ? "Saving…" : "Save"}
                            </Button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-700">
                    Address
                  </p>
                  <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm text-slate-700 whitespace-pre-line min-h-[72px]">
                    {salesDoctorDetail.address || "Unavailable"}
                  </div>
                </div>
              </div>

              {(() => {
                const visibleOrdersCount = salesDoctorDetail.orders.filter(
                  (order) => shouldCountRevenueForStatus(order.status),
                ).length;
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Total Orders
                      </p>
                      <p className="text-lg font-semibold text-slate-900">
                        {visibleOrdersCount}
                      </p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Last Order
                      </p>
                      <p className="text-sm font-semibold text-slate-900">
                        {salesDoctorDetail.lastOrderDate
                          ? formatDateTime(salesDoctorDetail.lastOrderDate)
                          : "Unavailable"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Avg Order Value
                      </p>
                      <p className="text-lg font-semibold text-slate-900">
                        {salesDoctorDetail.avgOrderValue
                          ? formatCurrency(salesDoctorDetail.avgOrderValue)
                          : "—"}
                      </p>
                    </div>
                  </div>
                );
              })()}

              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-700">
                  Recent Orders
                </p>
	                {(() => {
	                  const personalOrders = Array.isArray(salesDoctorDetail.personalOrders)
	                    ? salesDoctorDetail.personalOrders
	                    : [];
	                  const salesOrders = Array.isArray(salesDoctorDetail.salesOrders)
	                    ? salesDoctorDetail.salesOrders
	                    : salesDoctorDetail.orders;
	                  const hasSplit =
	                    (typeof salesDoctorDetail.personalRevenue === "number" ||
	                      typeof salesDoctorDetail.salesRevenue === "number") &&
	                    (personalOrders.length > 0 || salesOrders.length > 0);

	                  const renderOrdersList = (orders: AccountOrderSummary[]) => (
	                    <div className="space-y-2">
	                      {orders.map((order) => (
	                        <button
	                          key={order.id}
	                          type="button"
	                          onClick={() => openSalesOrderDetails(order)}
	                          className="w-full text-left flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 cursor-pointer transition hover:shadow-sm hover:border-[rgb(95,179,249)]"
	                        >
	                          <div className="min-w-0 text-sm text-slate-700">
	                            <div className="flex items-center gap-2 min-w-0">
	                              <span className="font-semibold text-slate-800 truncate">
	                                {`Order #${order.number ?? order.id}`}
	                              </span>
	                              <span className="sales-tracking-row-status shrink-0">
	                                {describeSalesOrderStatus(order as any)}
	                              </span>
	                            </div>
	                            <div className="text-xs text-slate-500">
	                              {order.createdAt ? formatDateTime(order.createdAt) : "Date unavailable"}
	                            </div>
	                          </div>
	                          <div className="text-right text-sm font-semibold text-slate-900 whitespace-nowrap">
	                            {formatCurrency(((order as any).grandTotal ?? order.total) || 0)}
	                          </div>
	                        </button>
	                      ))}
	                    </div>
	                  );

	                  if (!hasSplit) {
	                    return (
	                      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
	                        {salesDoctorDetail.orders.length > 0 ? (
	                          renderOrdersList(salesDoctorDetail.orders)
	                        ) : (
	                          <p className="text-xs text-slate-500">No orders available.</p>
	                        )}
	                      </div>
	                    );
	                  }

	                  const personalCount = personalOrders.filter((order) =>
	                    shouldCountRevenueForStatus(order.status),
	                  ).length;
	                  const salesCount = salesOrders.filter((order) =>
	                    shouldCountRevenueForStatus(order.status),
	                  ).length;

	                  return (
	                    <div className="space-y-4 max-h-64 overflow-y-auto pr-1">
	                      <div className="space-y-2">
	                        <div className="flex items-baseline justify-between gap-3">
	                          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
	                            Personal orders ({personalCount})
	                          </p>
	                          <p className="text-xs font-semibold text-slate-700">
	                            {formatCurrency(salesDoctorDetail.personalRevenue ?? 0)}
	                          </p>
	                        </div>
	                        {personalOrders.length > 0 ? (
	                          renderOrdersList(personalOrders)
	                        ) : (
	                          <p className="text-xs text-slate-500">No personal orders.</p>
	                        )}
	                      </div>

	                      <div className="space-y-2">
	                        <div className="flex items-baseline justify-between gap-3">
	                          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
	                            Sales orders ({salesCount})
	                          </p>
	                          <p className="text-xs font-semibold text-slate-700">
	                            {formatCurrency(salesDoctorDetail.salesRevenue ?? 0)}
	                          </p>
	                        </div>
	                        {salesOrders.length > 0 ? (
	                          renderOrdersList(salesOrders)
	                        ) : (
	                          <p className="text-xs text-slate-500">No sales orders.</p>
	                        )}
	                      </div>
	                    </div>
	                  );
	                })()}
	              </div>

	              <div className="mt-2 text-center text-[11px] font-normal text-slate-400">
	                {(() => {
	                  const rawId = String(salesDoctorDetail.doctorId ?? "").trim();
	                  const displayId = rawId.includes(":")
	                    ? rawId.split(":").slice(-1)[0].trim()
	                    : rawId;
	                  return `ID: ${displayId || "—"}`;
	                })()}
	              </div>
	            </div>
	            )
	          )}
	        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(salesOrderDetail)}
        onOpenChange={(open) => {
          if (!open) {
            setSalesOrderDetail(null);
            setSalesOrderDetailLoading(false);
            salesOrderFieldsInitializedForRef.current = null;
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          {salesOrderDetailLoading && (
            <>
              <VisuallyHidden>
                <DialogTitle>Loading order details</DialogTitle>
                <DialogDescription>Fetching order details.</DialogDescription>
              </VisuallyHidden>
              {renderSalesOrderSkeleton()}
            </>
          )}
          {!salesOrderDetailLoading && salesOrderDetail && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {salesOrderDetail.number
                    ? `Order #${salesOrderDetail.number}`
                    : "Order details"}
                </DialogTitle>
                <DialogDescription>
                  {salesOrderDetail.doctorName || salesOrderDetail.doctorEmail || ""}
                </DialogDescription>
              </DialogHeader>
              {(() => {
                const shipping = salesOrderDetail.shippingEstimate || null;
                const shippingAddress =
                  salesOrderDetail.shippingAddress ||
                  (salesOrderDetail as any).shipping ||
                  (salesOrderDetail as any).shipping_address ||
                  null;
                const billingAddress =
                  salesOrderDetail.billingAddress ||
                  (salesOrderDetail as any).billing ||
                  (salesOrderDetail as any).billing_address ||
                  null;
                const lineItems =
                  salesOrderDetail.lineItems ||
                  (salesOrderDetail as any).lineItems ||
                  (salesOrderDetail as any).line_items ||
                  [];
	                const subtotal = lineItems.reduce((sum, line) => {
	                  const lineTotal =
	                    coerceNumber(line.total ?? line.subtotal) ??
	                    (coerceNumber(line.price) ?? 0) * (coerceNumber(line.quantity) ?? 0);
	                  return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
	                }, 0);
	                const shippingTotal =
	                  coerceNumber(
	                    salesOrderDetail.shippingTotal ??
	                      (salesOrderDetail as any).shipping_total ??
	                      (salesOrderDetail as any).shippingTotal,
	                  ) ?? 0;
	                const taxTotal =
	                  coerceNumber(
	                    (salesOrderDetail as any).taxTotal ??
	                      (salesOrderDetail as any).total_tax ??
	                      (salesOrderDetail as any).totalTax,
	                  ) ?? 0;
                const computedGrandTotal = subtotal + shippingTotal + taxTotal;
                const storedGrandTotal =
                  typeof (salesOrderDetail as any).grandTotal === "number"
                    ? (salesOrderDetail as any).grandTotal
                    : null;
                const grandTotal =
                  typeof storedGrandTotal === "number" && Number.isFinite(storedGrandTotal) && storedGrandTotal > 0
                    ? storedGrandTotal
                    : computedGrandTotal;
		                const paymentDisplay =
		                  (() => {
		                    const integrations = (salesOrderDetail as any).integrationDetails || (salesOrderDetail as any).integrations || {};
		                    const stripeMeta = integrations?.stripe || integrations?.Stripe || null;
	                    const last4 =
	                      stripeMeta?.cardLast4 ||
	                      stripeMeta?.card_last4 ||
	                      stripeMeta?.last4 ||
	                      null;
	                    const brand =
	                      stripeMeta?.cardBrand ||
	                      stripeMeta?.card_brand ||
	                      stripeMeta?.brand ||
	                      null;
	                    if (last4) {
	                      return `${brand || "Card"} •••• ${last4}`;
	                    }
		                    const fallback =
		                      salesOrderDetail.paymentDetails ||
		                      salesOrderDetail.paymentMethod ||
		                      null;
		                    if (typeof fallback === "string" && /stripe onsite/i.test(fallback)) {
		                      return "Card payment";
		                    }
		                    if (typeof fallback === "string") {
		                      return formatPepProPaymentMethodLabel(fallback) || fallback;
		                    }
		                    return fallback;
		                  })();
                const renderAddressLines = (address: any) => {
                  if (!address) return <p className="text-sm text-slate-500">—</p>;
                  const lines = [
                    address.name,
                    [address.addressLine1, address.addressLine2]
                      .filter(Boolean)
                      .join(" ")
                      .trim(),
                    [address.city, address.state, address.postalCode]
                      .filter(Boolean)
                      .join(", ")
                      .trim(),
                    address.country,
                    address.phone,
                    address.email,
                  ]
                    .filter((line) => line && String(line).trim().length > 0)
                    .map((line, idx) => (
                      <p key={idx} className="text-sm text-slate-700">
                        {line}
                      </p>
                    ));
                  return lines.length > 0 ? lines : <p className="text-sm text-slate-500">—</p>;
                };

                const placedDate =
                  salesOrderDetail.createdAt ||
                  (salesOrderDetail as any).dateCreated ||
                  (salesOrderDetail as any).date_created ||
                  salesOrderDetail.updatedAt ||
                  null;
                const normalizedStatus = String(
                  (shipping as any)?.status || salesOrderDetail.status || "",
                )
                  .toString()
                  .trim()
                  .toLowerCase();
                const expectedShipmentWindow =
                  (salesOrderDetail as any).expectedShipmentWindow ||
                  (salesOrderDetail as any).expected_shipment_window ||
                  null;
                const isShippedDetail =
                  normalizedStatus === "shipped";
                const expectedDelivery =
                  isShippedDetail && shipping?.estimatedArrivalDate
                    ? formatDate(shipping.estimatedArrivalDate)
                    : "—";

                const formatShippingCode = (value?: string | null) => {
                  if (!value) return null;
                  return value
                    .replace(/^ups_/i, "UPS ")
                    .replace(/_/g, " ")
                    .trim()
                    .replace(/\s+/g, " ")
                    .replace(/\b(\w)/g, (m) => m.toUpperCase());
                };
                const shippingServiceLabel = formatShippingCode(shipping?.serviceType) || shipping?.serviceType || null;
                const shippingCarrierLabel = formatShippingCode(shipping?.carrierId) || shipping?.carrierId || null;
                const trackingLabel = resolveTrackingNumber(salesOrderDetail);
                const integrationsParsed = parseMaybeJson(
                  (salesOrderDetail as any).integrationDetails ||
                    (salesOrderDetail as any).integrations ||
                    {},
                );
                const carrierTracking = parseMaybeJson(
                  (integrationsParsed as any)?.carrierTracking ||
                    (integrationsParsed as any)?.carrier_tracking ||
                    null,
                );
                const carrierTrackingLabel =
                  carrierTracking?.trackingStatusRaw ||
                  carrierTracking?.trackingStatus ||
                  carrierTracking?.status ||
                  null;
                const showExpectedShipmentWindow = Boolean(
                  expectedShipmentWindow && !(normalizedStatus === "shipped" && Boolean(trackingLabel)),
                );
                const trackingHref = trackingLabel
                  ? buildTrackingUrl(
                      trackingLabel,
                      shipping?.carrierId ||
                        shipping?.carrier_id ||
                        (shippingServiceLabel || "").toLowerCase().includes("ups")
                        ? "ups"
                        : null,
                    )
                  : null;

                return (
              <div className="space-y-6">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm text-slate-700">
                      <div>
                        <p className="uppercase text-[11px] tracking-[0.08em] text-slate-500">
                          Order placed
                        </p>
                        <p className="font-semibold text-slate-900">
                          {placedDate
                            ? formatDateTime(placedDate)
                            : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="uppercase text-[11px] tracking-[0.08em] text-slate-500">
                          Total
                        </p>
                        <p className="font-semibold text-slate-900">
                          {formatCurrency(
                            grandTotal,
                            salesOrderDetail.currency || "USD",
                          )}
                        </p>
                      </div>
	                      <div>
	                        <p className="uppercase text-[11px] tracking-[0.08em] text-slate-500">
	                          Status
	                        </p>
	                        <Badge variant="secondary" className="uppercase">
	                          {describeSalesOrderStatus(salesOrderDetail as any)}
	                        </Badge>
	                      </div>
                      <div>
                        <p className="uppercase text-[11px] tracking-[0.08em] text-slate-500">
                          Expected delivery
                        </p>
                        <p className="font-semibold text-slate-900">
                          {expectedDelivery}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
	                      <div className="space-y-2">
	                        <h4 className="text-base font-semibold text-slate-900">
	                          Shipping Information
	                        </h4>
	                        {renderAddressLines(shippingAddress)}
	                        <div className="text-sm text-slate-700 space-y-1">
                          {shippingServiceLabel && (
                            <p>
                              <span className="font-semibold">Service:</span>{" "}
                              {shippingServiceLabel}
                            </p>
                          )}
                          <p>
                            <span className="font-semibold">Tracking:</span>{" "}
                            {trackingHref ? (
                              <a
                                href={trackingHref}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[rgb(26,85,173)] hover:underline"
                              >
                                {trackingLabel}
                              </a>
                            ) : (
                              trackingLabel || "Provided when shipped"
                            )}
                          </p>
                          {carrierTrackingLabel && (
                            <p>
                              <span className="font-semibold">Tracking status:</span>{" "}
                              {humanizeAccountOrderStatus(String(carrierTrackingLabel))}
                            </p>
                          )}
                          {Number.isFinite(shippingTotal) && (
                            <p>
                              <span className="font-semibold">Shipping:</span>{" "}
                              {formatCurrency(
                                shippingTotal,
                                salesOrderDetail.currency || "USD",
                              )}
                            </p>
                          )}
                          {expectedDelivery && expectedDelivery !== "—" && (
                            <p>
                              <span className="font-semibold">Expected:</span>{" "}
                              {expectedDelivery}
                            </p>
                          )}
	                          {showExpectedShipmentWindow && (
	                            <p>
	                              <span className="font-semibold">Estimated ship window:</span>{" "}
	                              {expectedShipmentWindow}
	                            </p>
	                          )}
	                        </div>

	                        {(() => {
	                          const canEdit = Boolean(
	                            user?.role && (isRep(user.role) || isAdmin(user.role)),
	                          );
	                          const normalize = (value: string) => (value || "").trim();
	                          const dirty =
	                            normalize(salesOrderFieldsDraft.trackingNumber) !==
	                              normalize(salesOrderFieldsSaved.trackingNumber) ||
	                            normalize(salesOrderFieldsDraft.shippingCarrier) !==
	                              normalize(salesOrderFieldsSaved.shippingCarrier) ||
	                            normalize(salesOrderFieldsDraft.shippingService) !==
	                              normalize(salesOrderFieldsSaved.shippingService) ||
	                            normalize(salesOrderFieldsDraft.status) !== normalize(salesOrderFieldsSaved.status) ||
	                            normalize(salesOrderFieldsDraft.expectedShipmentWindow) !==
	                              normalize(salesOrderFieldsSaved.expectedShipmentWindow);
	                          if (!canEdit) return null;
	                          return (
	                            <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
	                              <div className="flex items-center justify-between gap-3">
	                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
	                                  Edit (PepPro)
	                                </p>
	                                <p className="text-[11px] text-slate-500">
	                                  {dirty ? "Unsaved changes" : "Saved"}
	                                </p>
	                              </div>
	                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
	                                <label className="text-xs text-slate-600">
	                                  Tracking number
	                                  <input
	                                    value={salesOrderFieldsDraft.trackingNumber}
	                                    onChange={(e) =>
	                                      setSalesOrderFieldsDraft((prev) => ({
	                                        ...prev,
	                                        trackingNumber: e.target.value,
	                                      }))
	                                    }
	                                    placeholder="Enter tracking…"
	                                    className="mt-1 w-full rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
	                                    disabled={salesOrderFieldsSaving}
	                                  />
	                                </label>
	                                <label className="text-xs text-slate-600">
	                                  Status
	                                  <input
	                                    list="peppro-order-status-options"
	                                    value={salesOrderFieldsDraft.status}
	                                    onChange={(e) =>
	                                      setSalesOrderFieldsDraft((prev) => ({
	                                        ...prev,
	                                        status: e.target.value,
	                                      }))
	                                    }
	                                    placeholder="processing / shipped / delivered…"
	                                    className="mt-1 w-full rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
	                                    disabled={salesOrderFieldsSaving}
	                                  />
	                                </label>
	                                <label className="text-xs text-slate-600">
	                                  Carrier
	                                  <input
	                                    list="peppro-order-carrier-options"
	                                    value={salesOrderFieldsDraft.shippingCarrier}
	                                    onChange={(e) =>
	                                      setSalesOrderFieldsDraft((prev) => ({
	                                        ...prev,
	                                        shippingCarrier: e.target.value,
	                                      }))
	                                    }
	                                    placeholder="UPS / USPS / FedEx…"
	                                    className="mt-1 w-full rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
	                                    disabled={salesOrderFieldsSaving}
	                                  />
	                                </label>
	                                <label className="text-xs text-slate-600">
	                                  Service
	                                  <input
	                                    value={salesOrderFieldsDraft.shippingService}
	                                    onChange={(e) =>
	                                      setSalesOrderFieldsDraft((prev) => ({
	                                        ...prev,
	                                        shippingService: e.target.value,
	                                      }))
	                                    }
	                                    placeholder="Ground / 2 Day…"
	                                    className="mt-1 w-full rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
	                                    disabled={salesOrderFieldsSaving}
	                                  />
	                                </label>
	                                <label className="text-xs text-slate-600 sm:col-span-2">
	                                  Estimated ship window
	                                  <input
	                                    value={salesOrderFieldsDraft.expectedShipmentWindow}
	                                    onChange={(e) =>
	                                      setSalesOrderFieldsDraft((prev) => ({
	                                        ...prev,
	                                        expectedShipmentWindow: e.target.value,
	                                      }))
	                                    }
	                                    placeholder="e.g., Ships in 1–2 business days"
	                                    className="mt-1 w-full rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
	                                    disabled={salesOrderFieldsSaving}
	                                  />
	                                </label>
	                              </div>
	                              <div className="flex items-center justify-end gap-3">
	                                <Button
	                                  type="button"
	                                  variant="outline"
	                                  onClick={() => {
	                                    setSalesOrderFieldsDraft(salesOrderFieldsSaved);
	                                  }}
	                                  disabled={salesOrderFieldsSaving || !dirty}
	                                >
	                                  Reset
	                                </Button>
	                                <Button
	                                  type="button"
	                                  onClick={handleSaveSalesOrderFields}
	                                  disabled={salesOrderFieldsSaving || !dirty}
	                                  className="gap-2"
	                                >
	                                  {salesOrderFieldsSaving ? "Saving…" : "Save"}
	                                </Button>
	                              </div>
	                              <datalist id="peppro-order-status-options">
	                                <option value="processing" />
	                                <option value="awaiting_shipment" />
	                                <option value="shipped" />
	                                <option value="in_transit" />
	                                <option value="out_for_delivery" />
	                                <option value="delivered" />
	                                <option value="completed" />
	                                <option value="cancelled" />
	                                <option value="refunded" />
	                              </datalist>
	                              <datalist id="peppro-order-carrier-options">
	                                <option value="ups" />
	                                <option value="usps" />
	                                <option value="fedex" />
	                                <option value="dhl" />
	                              </datalist>
	                              <p className="text-[11px] text-slate-500">
	                                Updates are saved in PepPro for display; this does not push changes to WooCommerce/ShipStation.
	                              </p>
	                            </div>
	                          );
	                        })()}
	                      </div>
                      <div className="space-y-2">
                        <h4 className="text-base font-semibold text-slate-900">
                          Billing Information
                        </h4>
                        {renderAddressLines(billingAddress)}
                        <div className="text-sm text-slate-700 space-y-1">
                          <p>
                            <span className="font-semibold">Payment:</span>{" "}
                            {paymentDisplay || "—"}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h4 className="text-base font-semibold text-slate-900">
                        Items
                      </h4>
                      {lineItems.length ? (
                        <div className="space-y-3">
                          {lineItems.map((line, idx) => (
                            <div
                              key={line.id || `${line.sku}-${idx}`}
                              className="flex items-start gap-3 rounded-lg border border-slate-100 p-3"
                            >
                              <div className="w-16 h-16 aspect-square rounded-md border border-slate-200 bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0">
                                {line.image ? (
                                  <img
                                    src={line.image}
                                    alt={line.name || "Item thumbnail"}
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <Package className="h-5 w-5" />
                                )}
                              </div>
                              <div className="flex-1 min-w-[10rem] space-y-1">
                                <p className="text-slate-900 font-semibold">
                                  {line.name || "Item"}
                                </p>
                                <p className="text-slate-600">
                                  Qty: {line.quantity ?? "—"}
                                </p>
                              </div>
                              <div className="text-sm text-slate-700 text-right min-w-[6rem]">
                                {Number.isFinite(line.total) && (
                                  <p className="font-semibold">
                                    {formatCurrency(
                                      line.total || 0,
                                      salesOrderDetail.currency || "USD",
                                    )}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-600">
                          No line items available.
                        </p>
                      )}
                    </div>

	                    <div className="space-y-2">
	                      <h4 className="text-base font-semibold text-slate-900">
	                        Order Summary
	                      </h4>
	                      <div className="space-y-1 text-sm text-slate-700">
                        <div className="flex justify-between">
                          <span>Subtotal</span>
                          <span>
                            {formatCurrency(subtotal, salesOrderDetail.currency || "USD")}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Shipping</span>
                          <span>
                            {formatCurrency(
                              shippingTotal,
                              salesOrderDetail.currency || "USD",
                            )}
                          </span>
                        </div>
		                        {taxTotal > 0 && (
		                          <div className="flex justify-between">
		                            <span>Tax</span>
		                            <span>
		                              {formatCurrency(
		                                taxTotal,
		                                salesOrderDetail.currency || "USD",
	                              )}
	                            </span>
	                          </div>
	                        )}
	                        <div className="flex justify-between text-base font-semibold text-slate-900 border-t border-slate-100 pt-2">
	                          <span>Total</span>
	                          <span>
	                            {formatCurrency(
	                              grandTotal,
	                              salesOrderDetail.currency || "USD",
	                            )}
	                          </span>
	                        </div>
	                      </div>
	                    </div>

	                    <div className="space-y-2">
	                      <h4 className="text-base font-semibold text-slate-900">
	                        Notes <span className="text-sm font-normal text-slate-500">(Visible to the doctor)</span>
	                      </h4>
	                      {(() => {
	                        const canEdit = Boolean(
	                          user?.role && (isRep(user.role) || isAdmin(user.role)),
	                        );
	                        const saved =
	                          typeof (salesOrderDetail as any)?.notes === "string"
	                            ? String((salesOrderDetail as any).notes)
	                            : "";
	                        const normalizedSaved = normalizeNotesValue(saved);
	                        const normalizedDraft = normalizeNotesValue(salesOrderNotesDraft);
	                        const isDirty = normalizedSaved !== normalizedDraft;
	                        const hasNotes = Boolean((normalizedSaved || normalizedDraft) && String(normalizedSaved || normalizedDraft).trim());

	                        if (!canEdit) {
	                          if (!hasNotes) {
	                            return (
	                              <p className="text-sm text-slate-500">
	                                No notes for this order.
	                              </p>
	                            );
	                          }
	                          return (
	                            <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
	                              <p className="text-sm text-slate-700 whitespace-pre-wrap">
	                                {normalizedSaved || ""}
	                              </p>
	                            </div>
	                          );
	                        }

	                        return (
	                          <div className="space-y-2">
	                            <textarea
	                              value={salesOrderNotesDraft}
	                              onChange={(e) => setSalesOrderNotesDraft(e.target.value)}
	                              placeholder="Add an order note…"
	                              rows={4}
	                              className="w-full rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
	                              disabled={salesOrderNotesSaving}
	                            />
	                            <div className="flex items-center justify-between gap-3">
	                              <p className="text-xs text-slate-500">
	                                {isDirty ? "Unsaved changes" : "Saved"}
	                              </p>
	                              <Button
	                                type="button"
	                                variant="outline"
	                                onClick={handleSaveSalesOrderNotes}
	                                disabled={salesOrderNotesSaving || !isDirty}
	                                className="gap-2"
	                              >
	                                {salesOrderNotesSaving ? "Saving…" : "Save notes"}
	                              </Button>
	                            </div>
	                          </div>
	                        );
	                      })()}
	                    </div>
	                  </div>
	                );
	              })()}
            </>
          )}
        </DialogContent>
      </Dialog>
      <ProductDetailDialog
        product={selectedProduct}
        isOpen={productDetailOpen}
        onClose={handleCloseProductDetail}
        onAddToCart={handleAddToCart}
      />
    </div>
  );
}
