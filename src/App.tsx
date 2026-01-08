import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  FormEvent,
  ReactNode,
  forwardRef,
} from "react";
import { Elements } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { getStripeMode, getStripePublishableKey } from "./lib/stripeConfig";
import { computeUnitPrice } from "./lib/pricing";
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
		  Loader2,
		  Plus,
			  Package,
			  Upload,
			  Download,
			  NotebookPen,
			  CheckSquare,
			  Trash2,
			} from "lucide-react";
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
	  referralAPI,
	  newsAPI,
	  quotesAPI,
	  wooAPI,
	  checkServerHealth,
	  passwordResetAPI,
	  settingsAPI,
	  API_BASE_URL,
	} from "./services/api";
import physiciansChoiceHtml from "./content/landing/physicians-choice.html?raw";
import careComplianceHtml from "./content/landing/care-compliance.html?raw";
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

const normalizeRole = (role?: string | null) => (role || "").toLowerCase();
const isAdmin = (role?: string | null) => normalizeRole(role) === "admin";
const isRep = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return (
    normalized !== "admin" &&
    (normalized === "sales_rep" || normalized === "rep")
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

interface AccountOrderSummary {
  id: string;
  number?: string | null;
  trackingNumber?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
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
  const shippingStatus =
    (order.shippingEstimate as any)?.status ||
    (order.integrationDetails as any)?.shipStation?.status;
  const candidate = shippingStatus || order.status || null;
  if (!candidate) return null;
  const str = String(candidate).trim();
  return str.length > 0 ? str : null;
};

const describeSalesOrderStatus = (
  order?: AccountOrderSummary | null,
): string => {
  const raw = resolveSalesOrderStatusSource(order);
  const statusRaw = raw ? String(raw) : "";
  const normalized = statusRaw.trim().toLowerCase();
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

  // Match doctor-facing status logic: do not infer tracking from integrations for the status label.
  // (The sales-rep view can still display tracking elsewhere if needed.)
  const tracking =
    typeof (order as any)?.trackingNumber === "string"
      ? String((order as any).trackingNumber).trim()
      : "";
  const eta = (order?.shippingEstimate as any)?.estimatedArrivalDate || null;
  const hasEta = typeof eta === "string" && eta.trim().length > 0;

  if (normalized === "shipped") {
    if (tracking && !hasEta) return "Processing";
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

  if (tracking && !hasEta) {
    return "Processing";
  }
  if (tracking && hasEta) {
    return "Shipped";
  }
  if (normalized === "processing") {
    return "Order Received";
  }
  if (normalized === "completed" || normalized === "complete") {
    return "Completed";
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
          total: coerceNumber(order?.total) ?? null,
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
          total: coerceNumber(order?.total) ?? null,
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
  "v1.9.69";
const CATALOG_PAGE_CONCURRENCY = (() => {
  const raw = String(
    (import.meta as any).env?.VITE_CATALOG_PAGE_CONCURRENCY || "",
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, 1), 4);
  }
  return 2;
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
    label: "Pending / Contact Form",
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
  { key: "contact_form", label: "Pending / Contact Form" },
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
    return "Contact Form";
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

declare global {
  interface Window {
    __PEPPRO_STRIPE_PROMISE?: Promise<Stripe | null>;
    __PEPPRO_STRIPE_PROMISES?: Record<string, Promise<Stripe | null>>;
  }
}

const ENV_STRIPE_PUBLISHABLE_KEY = getStripePublishableKey();

export default function App() {
  const BROWSER_VARIATION_CACHE_ENABLED =
    String((import.meta as any).env?.VITE_BROWSER_VARIATION_CACHE || "")
      .toLowerCase()
      .trim() === "true";
  const [stripeSettings, setStripeSettings] = useState<{
    stripeMode?: "test" | "live";
    stripeTestMode?: boolean;
    onsiteEnabled?: boolean;
    publishableKey?: string;
    publishableKeyLive?: string;
    publishableKeyTest?: string;
  } | null>(null);
  const stripeModeEffective = useMemo(() => {
    const serverMode = (stripeSettings?.stripeMode || "").toLowerCase().trim();
    if (serverMode === "test" || serverMode === "live") {
      return serverMode;
    }
    return getStripeMode();
  }, [stripeSettings?.stripeMode]);
  const stripeDashboardUrl =
    stripeModeEffective === "live"
      ? "https://dashboard.stripe.com/"
      : "https://dashboard.stripe.com/test";
  const shipStationDashboardUrl = "https://ship14.shipstation.com";
	  const stripePublishableKey = useMemo(() => {
	    const candidate = stripeSettings
	      ? (stripeSettings.publishableKey || "").trim()
	      : ENV_STRIPE_PUBLISHABLE_KEY;

	    const mode = (stripeModeEffective || "").toLowerCase().trim();
	    if (mode === "live") {
	      return candidate.startsWith("pk_live") ? candidate : "";
	    }
	    // default to test
	    return candidate.startsWith("pk_test") ? candidate : "";
	  }, [stripeSettings, stripeModeEffective]);
  const stripeClientPromise = useMemo((): Promise<Stripe | null> => {
    if (!stripePublishableKey) {
      return Promise.resolve(null);
    }
    if (typeof window !== "undefined") {
      if (!window.__PEPPRO_STRIPE_PROMISES) {
        window.__PEPPRO_STRIPE_PROMISES = {};
      }
      const cache = window.__PEPPRO_STRIPE_PROMISES;
      if (!cache[stripePublishableKey]) {
        cache[stripePublishableKey] = loadStripe(stripePublishableKey);
      }
      return cache[stripePublishableKey];
    }
    return loadStripe(stripePublishableKey);
  }, [stripePublishableKey]);
  const [user, setUser] = useState<User | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productDetailOpen, setProductDetailOpen] = useState(false);
  const [loginPromptToken, setLoginPromptToken] = useState(0);
  const apiWarmupInFlight = useRef(false);
  const [shouldReopenCheckout, setShouldReopenCheckout] = useState(false);
  const [loginContext, setLoginContext] = useState<"checkout" | null>(null);
  const [landingAuthMode, setLandingAuthMode] = useState<
    "login" | "signup" | "forgot" | "reset"
  >(getInitialLandingMode);
  const [postLoginHold, setPostLoginHold] = useState(false);
  const [isReturningUser, setIsReturningUser] = useState(false);
  const [infoFocusActive, setInfoFocusActive] = useState(false);
  const [shouldAnimateInfoFocus, setShouldAnimateInfoFocus] = useState(false);
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
  const stripeIsTestMode = useMemo(() => {
    if (stripeModeEffective === "test") {
      return true;
    }
    return stripePublishableKey.startsWith("pk_test");
  }, [stripeModeEffective, stripePublishableKey]);
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
  const [showCanceledOrders, setShowCanceledOrders] = useState(false);
  const postCheckoutOrderRef = useRef<{
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
    async (options?: { includeCanceled?: boolean }) => {
      const includeCanceled = options?.includeCanceled ?? showCanceledOrders;
      if (!user?.id) {
        setAccountOrders([]);
        setAccountOrdersSyncedAt(null);
        setAccountOrdersError(null);
        return [];
      }
      setAccountOrdersLoading(true);
      setAccountOrdersError(null);
      try {
        const response = await ordersAPI.getAll({ includeCanceled });
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
            const exists = normalized.some((order) => {
              const orderNumber = order.number ? String(order.number).trim() : "";
              const orderId = order.id ? String(order.id).trim() : "";
              return (
                (optimisticNumber && orderNumber && orderNumber === optimisticNumber) ||
                (optimisticId && orderId && orderId === optimisticId)
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

    const targetWooNumber = postCheckoutOrderRef.current?.wooOrderNumber || null;
    const attempts = [0, 900, 1800, 3500];

    const tryRefresh = async () => {
      try {
        const latest = await loadAccountOrders();
        if (targetWooNumber) {
          const found = latest.some((order) => String(order.number || "").trim() === targetWooNumber);
          if (found) {
            return true;
          }
        }
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
        await ordersAPI.cancelOrder(orderId, "Cancelled via account portal");
        toast.success("Order canceled. A refund is on the way.");
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
    let cancelled = false;
    const fetchSetting = async () => {
      try {
        const data = await settingsAPI.getShopStatus();
        if (!cancelled && data && typeof data.shopEnabled === "boolean") {
          setShopEnabled(data.shopEnabled);
          localStorage.setItem(
            "peppro:shop-enabled",
            data.shopEnabled ? "true" : "false",
          );
        }
      } catch (error) {
        console.warn(
          "[Shop] Unable to load shop setting, using local fallback",
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
    let cancelled = false;
    const fetchStripeSettings = async () => {
      try {
        const data = await settingsAPI.getStripeSettings();
        if (cancelled) return;
        if (data && typeof data === "object") {
          setStripeSettings(data as any);
        }
      } catch (error) {
        console.warn("[Stripe] Failed to load admin Stripe settings", error);
      }
    };
    fetchStripeSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShopToggle = useCallback(
    async (value: boolean) => {
      if (!isAdmin(user?.role)) {
        return;
      }
      setShopEnabled(value);
      try {
        localStorage.setItem("peppro:shop-enabled", value ? "true" : "false");
      } catch {
        // ignore
      }
      try {
        await settingsAPI.updateShopStatus(value);
      } catch (error) {
        console.warn("[Shop] Failed to update shop toggle", error);
      }
    },
    [user?.role],
  );

  const handleStripeTestModeToggle = useCallback(
    async (enabled: boolean) => {
      if (!isAdmin(user?.role)) {
        return;
      }
      const optimisticMode = enabled ? "test" : "live";
      setStripeSettings((prev) => ({
        ...(prev || {}),
        stripeMode: optimisticMode,
        stripeTestMode: enabled,
      }));
      try {
        const updated = await settingsAPI.updateStripeTestMode(enabled);
        if (updated && typeof updated === "object") {
          setStripeSettings(updated as any);
        }
      } catch (error) {
        console.warn("[Stripe] Failed to update Stripe test mode", error);
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
      const email =
        (acct?.email || acct?.referredContactEmail || "").toString().trim();
      const phone =
        acct?.phone ||
        acct?.phoneNumber ||
        acct?.phone_number ||
        acct?.referredContactPhone ||
        null;
      addKey(email);
      addKey(phone ? `phone:${phone}` : null);
      addKey(acct?.id ? `acct:${acct.id}` : null);
      addKey(acct?.userId ? `acct:${acct.userId}` : null);
      addKey(acct?.doctorId ? `acct:${acct.doctorId}` : null);
      addKey(acct?.accountId ? `acct:${acct.accountId}` : null);
      addKey(acct?.account_id ? `acct:${acct.account_id}` : null);
    });
    return keys;
  }, [salesRepDashboard]);

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
      const email =
        (acct?.email || acct?.referredContactEmail || acct?.userEmail || acct?.doctorEmail || "").toString().trim();
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

      if (email) {
        setKey(email.toLowerCase(), profile);
        setKey(`email:${email.toLowerCase()}`, profile);
      }
      if (phone) {
        setKey(`phone:${phone}`, profile);
      }
      if (accountId) {
        setKey(`acct:${accountId}`, profile);
        setKey(`acct:${String(accountId).toLowerCase()}`, profile);
        setKey(String(accountId), profile);
      }
    });

    return map;
  }, [salesRepDashboard]);
  const normalizedReferrals = useMemo(
    () =>
      (salesRepDashboard?.referrals ?? []).map((ref) => {
        const emailKey = ref.referredContactEmail
          ? ref.referredContactEmail.toLowerCase()
          : null;
        const phoneKey = ref.referredContactPhone
          ? `phone:${ref.referredContactPhone}`
          : null;
        const acctKey = ref.referredContactAccountId
          ? `acct:${ref.referredContactAccountId}`
          : null;
        const hasAccountMatch =
          ref.referredContactHasAccount ||
          (emailKey ? accountIdentitySet.has(emailKey) : false) ||
          (phoneKey ? accountIdentitySet.has(phoneKey) : false) ||
          (acctKey ? accountIdentitySet.has(acctKey) : false);
        return {
          ...ref,
          status: sanitizeReferralStatus(ref.status),
          referredContactName: toTitleCase(ref.referredContactName),
          referrerDoctorName: toTitleCase(ref.referrerDoctorName),
          referredContactHasAccount: hasAccountMatch,
        };
      }),
    [accountIdentitySet, salesRepDashboard?.referrals],
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
		      const status = sanitizeReferralStatus(lead?.status);
		      if (status === "nuture") {
		        return true;
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
  const [salesOrderDetail, setSalesOrderDetail] =
    useState<AccountOrderSummary | null>(null);
  const [salesOrderDetailLoading, setSalesOrderDetailLoading] = useState(false);
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
	    orders: AccountOrderSummary[];
	    phone?: string | null;
	    address?: string | null;
	    lastOrderDate?: string | null;
	    avgOrderValue?: number | null;
	  } | null>(null);
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
	
	  useEffect(() => {
	    if (!salesDoctorDetail?.doctorId) {
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
	  }, [salesDoctorDetail?.doctorId, salesDoctorNotes]);

	  useEffect(() => {
	    return () => {
	      if (salesDoctorNotesSavedTimeoutRef.current) {
	        window.clearTimeout(salesDoctorNotesSavedTimeoutRef.current);
	        salesDoctorNotesSavedTimeoutRef.current = null;
	      }
	    };
	  }, []);
	
	  const saveSalesDoctorNotes = useCallback(async () => {
	    if (!salesDoctorDetail?.doctorId) {
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
		    salesDoctorNoteDraft,
		    salesDoctorNotes,
		    normalizeNotesValue,
		    triggerSalesDoctorNotesSaved,
		    user,
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
          mergeSalesOrderDetail(enriched);
        } else if (detail && typeof detail === "object") {
          const enriched = detail as AccountOrderSummary;
          setSalesOrderDetail(enriched);
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
    [mergeSalesOrderDetail],
  );

	  const openSalesDoctorDetail = useCallback(
	    (bucket: {
	      doctorId: string;
	      referralId?: string | null;
	      doctorName: string;
	      doctorEmail?: string | null;
	      doctorAvatar?: string | null;
	      doctorPhone?: string | null;
	      doctorAddress?: string | null;
	      orders: AccountOrderSummary[];
	      total: number;
	    }) => {
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
      const avgOrderValue =
        bucket.orders.length > 0 ? bucket.total / bucket.orders.length : null;

	      setSalesDoctorDetail({
	        doctorId: bucket.doctorId,
	        referralId: bucket.referralId ?? null,
	        name: bucket.doctorName,
	        email: bucket.doctorEmail,
	        avatar: bucket.doctorAvatar ?? null,
	        revenue: bucket.total,
        orders: bucket.orders,
        phone:
          bucket.doctorPhone ||
          (addressSource as any)?.phone ||
          (addressSource as any)?.phoneNumber ||
          null,
        address,
        lastOrderDate,
        avgOrderValue,
      });
    },
    [],
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
    }[]
  >([]);
  const [salesRepSalesSummaryMeta, setSalesRepSalesSummaryMeta] = useState<{
    periodStart?: string | null;
    periodEnd?: string | null;
    totals?: { totalOrders: number; totalRevenue: number } | null;
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
  const [salesRepPeriodStart, setSalesRepPeriodStart] = useState<string>("");
  const [salesRepPeriodEnd, setSalesRepPeriodEnd] = useState<string>("");
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
    if (!user || !isAdmin(user.role)) {
      setSalesRepSalesCsvDownloadedAt(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const reportSettings = await settingsAPI.getReportSettings();
        const downloadedAt =
          typeof (reportSettings as any)?.salesBySalesRepCsvDownloadedAt === "string"
            ? String((reportSettings as any).salesBySalesRepCsvDownloadedAt)
            : null;
        if (!cancelled) {
          setSalesRepSalesCsvDownloadedAt(downloadedAt);
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

      const rows = [
        ["Sales Rep", "Email", "Orders", "Revenue"].join(","),
        ...salesRepSalesSummary.map((rep) =>
          [
            escapeCsv(rep.salesRepName || ""),
            escapeCsv(rep.salesRepEmail || ""),
            escapeCsv(Number(rep.totalOrders || 0)),
            escapeCsv(Number(rep.totalRevenue || 0).toFixed(2)),
          ].join(","),
        ),
      ];

      const csv = rows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = exportedAtIso.replace(/[:.]/g, "-");
      const periodStart = salesRepSalesSummaryMeta?.periodStart
        ? String(salesRepSalesSummaryMeta.periodStart).slice(0, 10)
        : null;
      const periodEnd = salesRepSalesSummaryMeta?.periodEnd
        ? String(salesRepSalesSummaryMeta.periodEnd).slice(0, 10)
        : null;
      const periodLabel =
        periodStart && periodEnd ? `_${periodStart}_to_${periodEnd}` : "";
      link.href = url;
      link.download = `sales-by-sales-rep${periodLabel}_${FRONTEND_BUILD_ID}_${stamp}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSalesRepSalesCsvDownloadedAt(exportedAtIso);
      if (user && isAdmin(user.role)) {
        try {
          await settingsAPI.setSalesBySalesRepCsvDownloadedAt(exportedAtIso);
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

  const refreshSalesBySalesRepSummary = useCallback(async () => {
    if (!user || !isAdmin(user.role)) return;
    setSalesRepSalesSummaryLoading(true);
    setSalesRepSalesSummaryError(null);
    try {
      const salesSummaryResponse = await ordersAPI.getSalesByRepForAdmin({
        periodStart: salesRepPeriodStart || undefined,
        periodEnd: salesRepPeriodEnd || undefined,
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
      const filteredSummary = summaryArray.filter(
        (rep: any) => rep.salesRepId !== user.id,
      );
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

  const salesByRepAutoLoadedRef = useRef(false);
  useEffect(() => {
    if (!user || !isAdmin(user.role)) {
      salesByRepAutoLoadedRef.current = false;
      return;
    }
    if (salesByRepAutoLoadedRef.current) {
      return;
    }
    salesByRepAutoLoadedRef.current = true;
    void refreshSalesBySalesRepSummary();
  }, [refreshSalesBySalesRepSummary, user?.id, user?.role]);

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
  type UserActivityWindow =
    | "hour"
    | "day"
    | "3days"
    | "week"
    | "month"
    | "6months"
    | "year";
  type UserActivityReport = {
    window: UserActivityWindow;
    etag?: string;
    generatedAt: string;
    cutoff: string;
    total: number;
    byRole: Record<string, number>;
    liveUsers?: Array<{
      id: string;
      name: string | null;
      email: string | null;
      role: string;
      isOnline: boolean;
      lastLoginAt: string | null;
      profileImageUrl?: string | null;
    }>;
    users: Array<{
      id: string;
      name: string | null;
      email: string | null;
      role: string;
      isOnline: boolean;
      lastLoginAt: string | null;
      profileImageUrl?: string | null;
    }>;
  };
  const [userActivityWindow, setUserActivityWindow] =
    useState<UserActivityWindow>("day");
  const [userActivityReport, setUserActivityReport] =
    useState<UserActivityReport | null>(null);
  const [userActivityLoading, setUserActivityLoading] = useState(false);
  const [userActivityError, setUserActivityError] = useState<string | null>(
    null,
  );
  const userActivityPollInFlightRef = useRef(false);
  const userActivityEtagRef = useRef<string | null>(null);
  const userActivityLongPollDisabledRef = useRef(false);
  const [userActivityNowTick, setUserActivityNowTick] = useState(0);

  useEffect(() => {
    if (!isAdmin(user?.role)) return;
    const id = window.setInterval(() => {
      setUserActivityNowTick((tick) => (tick + 1) % Number.MAX_SAFE_INTEGER);
    }, 30000);
    return () => window.clearInterval(id);
  }, [user?.role]);

  const formatOnlineDuration = (lastLoginAt?: string | null) => {
    void userActivityNowTick;
    if (!lastLoginAt) return "Online";
    const startedAt = new Date(lastLoginAt).getTime();
    if (!Number.isFinite(startedAt)) return "Online";
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const totalMinutes = Math.floor(elapsedMs / 60000);
    if (totalMinutes < 1) return "Online for <1m";
    if (totalMinutes < 60) return `Online for ${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) {
      return minutes ? `Online for ${hours}h ${minutes}m` : `Online for ${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `Online for ${days}d ${remHours}h` : `Online for ${days}d`;
  };

  useEffect(() => {
    if (!isAdmin(user?.role)) {
      setUserActivityReport(null);
      setUserActivityLoading(false);
      setUserActivityError(null);
      userActivityEtagRef.current = null;
      return;
    }
    let cancelled = false;
    setUserActivityLoading(true);
    setUserActivityError(null);
    const fetchUserActivity = async () => {
      try {
        const report = (await settingsAPI.getUserActivity(
          userActivityWindow,
        )) as any;
        if (cancelled) return;
        userActivityEtagRef.current =
          typeof report?.etag === "string" ? report.etag : null;
        setUserActivityReport(report as UserActivityReport);
      } catch (error) {
        if (cancelled) return;
        setUserActivityReport(null);
        setUserActivityError(
          error instanceof Error
            ? error.message
            : "Unable to load user activity.",
        );
      } finally {
        if (!cancelled) setUserActivityLoading(false);
      }
    };
    fetchUserActivity();
    return () => {
      cancelled = true;
    };
  }, [user?.role, userActivityWindow]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!user || !isAdmin(user.role) || postLoginHold) {
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;
    const pollIntervalMs = 4000;
    const longPollTimeoutMs = 25000;

    const poll = async () => {
      if (cancelled) return;
      if (!isPageVisible()) return;
      if (!isOnline()) return;
      if (userActivityPollInFlightRef.current) return;

      userActivityPollInFlightRef.current = true;
      try {
        const report = (await settingsAPI.getUserActivity(
          userActivityWindow,
        )) as any;
        if (!cancelled) {
          userActivityEtagRef.current =
            typeof report?.etag === "string" ? report.etag : null;
          setUserActivityReport(report as UserActivityReport);
        }
      } catch (error) {
        // Keep the last-known report to avoid UI flicker; next poll will retry.
        if (!cancelled) {
          console.debug("[Admin] User activity poll failed", error);
        }
      } finally {
        userActivityPollInFlightRef.current = false;
      }
    };

    const startIntervalFallback = () => {
      if (intervalId !== null) return;
      void poll();
      intervalId = window.setInterval(() => {
        void poll();
      }, pollIntervalMs);
    };

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const controller = new AbortController();
    const runLongPoll = async () => {
      if (userActivityLongPollDisabledRef.current) {
        startIntervalFallback();
        return;
      }

      while (!cancelled) {
        if (!isPageVisible() || !isOnline()) {
          // Keep the loop frontend-only and responsive.
          // eslint-disable-next-line no-await-in-loop
          await sleep(800);
          continue;
        }
        try {
          const report = (await settingsAPI.getUserActivityLongPoll(
            userActivityWindow,
            userActivityEtagRef.current,
            longPollTimeoutMs,
            controller.signal,
          )) as any;
          if (cancelled) break;
          userActivityEtagRef.current =
            typeof report?.etag === "string" ? report.etag : null;
          setUserActivityReport(report as UserActivityReport);
        } catch (error: any) {
          if (cancelled) break;
          if (typeof error?.status === "number" && error.status === 404) {
            userActivityLongPollDisabledRef.current = true;
            startIntervalFallback();
            return;
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(pollIntervalMs);
        }
      }
    };

    void runLongPoll();

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      controller.abort();
    };
  }, [postLoginHold, user?.id, user?.role, userActivityWindow]);

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
    return contactFormEntries.filter(
      (entry) =>
        isLeadStatus(entry.status) &&
        !hasLeadPlacedOrder(entry) &&
        !isCurrentUserLead(entry) &&
        !(entry.referredContactEligibleForCredit === true) &&
        !(sanitizeReferralStatus(entry.status) === "converted" && hasLeadPlacedOrder(entry)),
    );
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
        !hasLeadPlacedOrder(referral),
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
      if (hasOrders) {
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
      const status = sanitizeReferralStatus(referral.status);
      const hasOrders = hasLeadPlacedOrder(referral);
      return Boolean(referral.creditIssuedAt) || (status === "converted" && hasOrders);
    });
  }, [hasLeadPlacedOrder, referralLeadEntries]);

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

			    const normalizedCombined = combined.map((entry) => {
			      const normalizedStatus = sanitizeReferralStatus(entry.record?.status);
			      if (normalizedStatus === "converted" && hasLeadPlacedOrder(entry.record)) {
			        return {
			          ...entry,
			          record: { ...(entry.record ?? {}), status: "nuture" },
			        };
			      }
			      return entry;
			    });

			    const filtered = normalizedCombined.filter(
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

		    const bestByIdentity = new Map<string, { status: string }>();
		    normalizedReferrals.forEach((referral, index) => {
		      const status = hasLeadPlacedOrder(referral)
		        ? "nuture"
		        : sanitizeReferralStatus(referral.status);
		      const key = identityKeyForReferral(referral, index);
		      const existing = bestByIdentity.get(key);
		      if (!existing) {
		        bestByIdentity.set(key, { status });
		        return;
		      }
		      const nextRank = statusRank.get(status) ?? -1;
		      const prevRank = statusRank.get(existing.status) ?? -1;
		      if (nextRank > prevRank) {
		        bestByIdentity.set(key, { status });
		      }
		    });

		    const counts: Record<string, number> = {};
		    bestByIdentity.forEach(({ status }) => {
		      counts[status] = (counts[status] || 0) + 1;
		    });

	    return SALES_REP_PIPELINE.map((stage) => ({
	      status: stage.key,
	      label: stage.label,
      count: stage.statuses.reduce(
        (total, statusKey) => total + (counts[statusKey] || 0),
        0,
      ),
    }));
	  }, [hasLeadPlacedOrder, normalizedReferrals]);

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
    const fetchKey = `${String(role || "").toLowerCase()}:${String(salesRepId || "")}`;
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
        salesRepId: salesRepId || undefined,
        scope: isAdmin(role) ? "mine" : "mine",
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
	    const shouldCountRevenueForStatus = (status?: string | null) => {
	      const normalized = String(status || "").toLowerCase().trim();
	      return (
	        normalized !== "cancelled" &&
	        normalized !== "canceled" &&
	        normalized !== "on-hold" &&
	        normalized !== "on_hold" &&
	        normalized !== "trash" &&
	        normalized !== "refunded"
	      );
	    };
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
      const bucket =
        buckets.get(doctorId) ||
        (() => {
          const created = {
            doctorId,
            doctorName: doctorNameFromOrder,
            doctorEmail: doctorEmailFromOrder,
            doctorAvatar,
            doctorPhone,
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
      bucket.orders.push(order);
      const status = (order.status || "").toLowerCase();
      if (
        status !== "cancelled" &&
        status !== "canceled" &&
        status !== "trash" &&
        status !== "refunded"
      ) {
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
          showLoading: false,
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
    // No background polling for reps/admins; rely on initial load + manual refresh
    if (
      !user ||
      (!isRep(user.role) && !isAdmin(user.role)) ||
      postLoginHold ||
      referralPollingSuppressed
    ) {
      return undefined;
    }
    return undefined;
  }, [user?.id, user?.role, postLoginHold, referralPollingSuppressed]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    if (
      !user ||
      (!isDoctorRole(user.role) && !isAdmin(user.role)) ||
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
      const unitPrice = computeUnitPrice(product, variant ?? null, quantity);
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
      );
      try {
        const wooNumber =
          response?.integrations?.wooCommerce?.response?.number ||
          response?.order?.wooOrderNumber ||
          null;
        postCheckoutOrderRef.current = {
          wooOrderNumber: wooNumber ? String(wooNumber).trim() : null,
          createdAtMs: Date.now(),
        };
	      } catch {
	        postCheckoutOrderRef.current = { wooOrderNumber: null, createdAtMs: Date.now() };
	      }

        try {
          const created = response?.order as any;
          const wooId =
            response?.integrations?.wooCommerce?.response?.id ||
            created?.wooOrderId ||
            created?.woo_order_id ||
            null;
          const wooNumber =
            response?.integrations?.wooCommerce?.response?.number ||
            created?.wooOrderNumber ||
            created?.woo_order_number ||
            null;
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
          const optimisticOrder: AccountOrderSummary = {
            id: wooId ? String(wooId) : String(created?.id || Date.now()),
            number: wooNumber ? String(wooNumber) : null,
            status: String(created?.status || "pending"),
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
            borderRadius: "24px",
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
          style={{ borderRadius: "24px" }}
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
	    if (stripeIsTestMode) {
	      statusChips.push({ key: "stripe", label: "Payment test mode" });
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
	    if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
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

    return (
      <section className="glass-card squircle-xl p-6 shadow-[0_30px_80px_-55px_rgba(95,179,249,0.6)] w-full sales-rep-dashboard">
	        <div className="flex flex-col gap-6">
	          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
	            <div>
	              <h2 className="text-xl font-semibold text-slate-900">
	                {isAdmin(user?.role)
	                  ? "Admin Dashboard"
	                  : "Sales Rep Dashboard"}
	              </h2>
	              <p className="text-sm text-slate-600">
	                Monitor PepPro business activities, sales resp, and keep track of your sales.
	              </p>
	            </div>
	            {isAdmin(user?.role) && (
	              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
	                <a
	                  href="https://shop.peppro.net/wp-admin/"
	                  target="_blank"
	                  rel="noopener noreferrer"
	                  className="inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-900 transition-colors hover:border-[rgba(95,179,249,0.65)] hover:bg-white sm:w-auto"
	                  title="Open PepPro WooCommerce Dashboard"
	                >
                    <img
                      src="/logos/woocommerce.svg"
                      alt=""
                      aria-hidden="true"
                      className="h-5 w-5"
                      loading="lazy"
                      decoding="async"
                    />
	                  <span className="hidden sm:inline">PepPro WooCommerce Dashboard</span>
	                  <span className="sm:hidden">WooCommerce Dashboard</span>
	                </a>
                  <a
                    href={stripeDashboardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-900 transition-colors hover:border-[rgba(95,179,249,0.65)] hover:bg-white sm:w-auto"
                    title="Open Stripe Dashboard"
                  >
                    <img
                      src="/logos/stripe.svg"
                      alt=""
                      aria-hidden="true"
                      className="h-5 w-5"
                      loading="lazy"
                      decoding="async"
                    />
                    <span>Stripe Dashboard</span>
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

          {adminActionState.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {adminActionState.error}
            </p>
          )}

	          {isAdmin(user?.role) && (
	          <div className="glass-card squircle-xl p-6 border border-slate-200/70">
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

	                  <div className="sales-rep-table-wrapper">
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
                          if (mins < 60) return `Uptime: ${mins}m`;
                          const hours = Math.floor(mins / 60);
                          const remMins = mins % 60;
                          if (hours < 24) return `Uptime: ${hours}h ${remMins}m`;
                          const days = Math.floor(hours / 24);
                          const remHours = hours % 24;
                          return `Uptime: ${days}d ${remHours}h`;
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
			                    Configure storefront availability and payment mode.
			                  </p>
		                </div>
	                </div>

                <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                  <span>
                    Shop: {shopEnabled ? "Enabled" : "Disabled"}
                  </span>
                  <span>
                    Payments: {stripeModeEffective === "test" ? "Test" : "Live"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-700">
		                  <input
		                    type="checkbox"
                        aria-label="Enable Shop for users"
		                    checked={shopEnabled}
		                    onChange={(e) => handleShopToggle(e.target.checked)}
		                    className="brand-checkbox"
		                  />
		                  <span className="cursor-default select-none">Enable Shop button for users</span>
		                </div>
		                <div className="flex items-center gap-2 text-sm text-slate-700">
			                  <input
			                    type="checkbox"
	                        aria-label="Payment test mode"
			                    checked={stripeModeEffective === "test"}
			                    onChange={(e) =>
			                      handleStripeTestModeToggle(e.target.checked)
			                    }
			                    className="brand-checkbox"
			                  />
			                  <span className="cursor-default select-none">Payment test mode</span>
			                </div>
		              </div>

                <div className="mt-6 pt-6 border-t border-slate-200/70 space-y-6">
                  <div>
                    <h4 className="text-base font-semibold text-slate-900">
                      Live users
                    </h4>
                    <p className="text-sm text-slate-600">
                      Users currently online.
                    </p>
                  </div>

                  {userActivityError && (
                    <div className="px-4 py-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md">
                      {userActivityError}
                    </div>
                  )}

                  {userActivityLoading ? (
                    <div className="px-4 py-3 text-sm text-slate-500">
                      Loading user activity…
                    </div>
                  ) : userActivityReport ? (
                    (() => {
                      const liveUsers =
                        Array.isArray(userActivityReport.liveUsers) &&
                        userActivityReport.liveUsers.length > 0
                          ? userActivityReport.liveUsers
                          : (userActivityReport.users || []).filter(
                              (entry) => entry.isOnline,
                            );

                      if (liveUsers.length === 0) {
                        return (
                          <div className="px-4 py-3 text-sm text-slate-500">
                            No users are online right now.
                          </div>
                        );
                      }

                      return (
                        <div className="flex flex-col gap-2">
                          {liveUsers.map((entry) => {
                            const avatarUrl = entry.profileImageUrl || null;
                            const displayName =
                              entry.name || entry.email || "User";
                            return (
                              <div
                                key={entry.id}
                                className="flex items-center gap-3 rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2"
                              >
                                <div
                                  className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm shrink-0"
                                  style={{
                                    width: 34,
                                    height: 34,
                                    minWidth: 34,
                                  }}
                                >
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
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-semibold text-slate-800 truncate">
                                      {displayName}
                                    </span>
                                    <span className="inline-flex items-center rounded-full bg-[rgba(95,179,249,0.16)] px-2 py-0.5 text-[11px] font-semibold text-[rgb(95,179,249)] shrink-0">
                                      Online
                                    </span>
                                  </div>
                                  <div className="text-xs text-slate-500 truncate">
                                    {entry.email || "—"}
                                  </div>
                                </div>
                                <div className="text-xs text-slate-600 whitespace-nowrap">
                                  {formatOnlineDuration(entry.lastLoginAt)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()
                  ) : (
                    <div className="px-4 py-3 text-sm text-slate-500">
                      No user activity loaded.
                    </div>
                  )}

                  <div className="pt-6 border-t border-slate-200/70 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-slate-900">
                          Recent Logins
                        </h4>
                        <p className="text-sm text-slate-600">
                          Users who logged in within the selected window.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <label
                          htmlFor="admin-user-activity-window"
                          className="text-xs text-slate-500 uppercase tracking-wide"
                        >
                          Window
                        </label>
                        <select
                          id="admin-user-activity-window"
                          value={userActivityWindow}
                          onChange={(e) =>
                            setUserActivityWindow(
                              e.target.value as UserActivityWindow,
                            )
                          }
                          className="recent-logins-select w-auto text-sm"
                        >
                          <option value="hour">Last hour</option>
                          <option value="day">Last day</option>
                          <option value="3days">Last 3 days</option>
                          <option value="week">Last week</option>
                          <option value="month">Last month</option>
                          <option value="6months">Last 6 months</option>
                          <option value="year">Last year</option>
                        </select>
                      </div>
                    </div>

                    {userActivityLoading ? (
                      <div className="px-4 py-3 text-sm text-slate-500">
                        Loading user activity…
                      </div>
                    ) : userActivityReport ? (
                      <>
                        <div className="flex flex-wrap gap-2 text-xs">
                          {[
                            { key: "admin", label: "Admins" },
                            { key: "sales_rep", label: "Sales reps" },
                            { key: "doctor", label: "Doctors" },
                            { key: "test_doctor", label: "Test doctors" },
                          ].map((role) => (
                            <span
                              key={role.key}
                              className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-slate-700"
                            >
                              {role.label}:{" "}
                              {userActivityReport.byRole?.[role.key] || 0}
                            </span>
                          ))}
                        </div>

                        {userActivityReport.users.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-slate-500">
                            No logins in this window.
                          </div>
                        ) : (
                          <div className="sales-rep-table-wrapper">
                            <div className="max-h-[320px] overflow-y-auto pb-3">
                              <table className="min-w-[720px] w-full mb-2 divide-y divide-slate-200/70">
                                <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-600">
                                  <tr>
                                    <th className="px-4 py-2 text-center">
                                      Online
                                    </th>
                                    <th className="px-4 py-2 text-center">
                                      Name
                                    </th>
                                    <th className="px-4 py-2 text-center">
                                      Email
                                    </th>
                                    <th className="px-4 py-2 text-center">
                                      Role
                                    </th>
                                    <th className="px-4 py-2 text-center">
                                      Last login
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 bg-white/70">
                                  {userActivityReport.users.map((entry) => (
                                    <tr key={entry.id}>
                                      <td className="px-4 py-3 text-sm text-slate-700 text-center">
                                        {entry.isOnline ? (
                                          <span className="inline-flex items-center rounded-full bg-[rgba(95,179,249,0.16)] px-2 py-0.5 text-[11px] font-semibold text-[rgb(95,179,249)]">
                                            Online
                                          </span>
                                        ) : (
                                          "—"
                                        )}
                                      </td>
                                      <td className="px-4 py-3 text-sm font-medium text-slate-800 text-center">
                                        {entry.name || "—"}
                                      </td>
                                      <td className="px-4 py-3 text-sm text-slate-600 text-center">
                                        {entry.email ? (
                                          <a href={`mailto:${entry.email}`}>
                                            {entry.email}
                                          </a>
                                        ) : (
                                          "—"
                                        )}
                                      </td>
                                      <td className="px-4 py-3 text-sm text-slate-700 text-center">
                                        {entry.role}
                                      </td>
                                      <td className="px-4 py-3 text-sm text-slate-700 text-center">
                                        {entry.lastLoginAt
                                          ? new Date(
                                              entry.lastLoginAt,
                                            ).toLocaleString()
                                          : "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        <div className="text-xs text-slate-500 pl-3">
                          Cutoff:{" "}
                          {userActivityReport.cutoff
                            ? new Date(
                                userActivityReport.cutoff,
                              ).toLocaleString()
                            : "—"}
                        </div>
                      </>
                    ) : (
                      <div className="px-4 py-3 text-sm text-slate-500">
                        No user activity loaded.
                      </div>
                    )}
                  </div>
                </div>
	            </div>
	          )}

			          {isAdmin(user?.role) && (
			            <div className="glass-card squircle-xl p-6 border border-slate-200/70">
			              <div className="flex flex-col gap-3 mb-4">
                <div className="sales-rep-header-row flex w-full flex-col gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-slate-900">
                      Sales by Sales Rep
                    </h3>
                    <p className="text-sm text-slate-600">
                      Orders placed by doctors assigned to each rep.
                    </p>
                    <form
                      className="sales-rep-period-form mt-2 flex flex-col gap-2 text-sm sm:flex-row sm:items-end"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void refreshSalesBySalesRepSummary();
                      }}
                    >
                      <label className="flex w-full flex-col gap-1 text-xs font-semibold text-slate-700 sm:w-auto">
                        Start
                        <Input
                          type="date"
                          value={salesRepPeriodStart}
                          onChange={(event) => setSalesRepPeriodStart(event.target.value)}
                          placeholder="YYYY-MM-DD"
                          className="block w-full min-w-0 text-slate-900"
                          style={{ colorScheme: "light" }}
                        />
                      </label>
                      <label className="flex w-full flex-col gap-1 text-xs font-semibold text-slate-700 sm:w-auto">
                        End
                        <Input
                          type="date"
                          value={salesRepPeriodEnd}
                          onChange={(event) => setSalesRepPeriodEnd(event.target.value)}
                          placeholder="YYYY-MM-DD"
                          className="block w-full min-w-0 text-slate-900"
                          style={{ colorScheme: "light" }}
                        />
                      </label>
                      <div className="sales-rep-period-actions flex items-center gap-2 self-start sm:self-end">
                        <Button
                          type="submit"
                          size="sm"
                          variant="outline"
                          disabled={salesRepSalesSummaryLoading}
                          className="whitespace-nowrap"
                        >
                          Apply
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="whitespace-nowrap"
                          onClick={() => {
                            setSalesRepPeriodStart("");
                            setSalesRepPeriodEnd("");
                            void refreshSalesBySalesRepSummary();
                          }}
                        >
                          Clear
                        </Button>
                      </div>
                    </form>
                  </div>
                  <div className="sales-rep-header-actions flex flex-row flex-wrap justify-end gap-4">
                    <div className="sales-rep-action flex min-w-0 flex-col items-end gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={downloadSalesBySalesRepCsv}
                        disabled={salesRepSalesSummary.length === 0}
                        title="Download CSV"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download CSV
                      </Button>
                      <span className="sales-rep-action-meta block text-[11px] text-slate-500 leading-tight text-right">
                        <span className="sales-rep-action-meta-label block">
                          Last downloaded
                        </span>
                        <span className="sales-rep-action-meta-value block">
                          {salesRepSalesCsvDownloadedAt
                            ? new Date(
                                salesRepSalesCsvDownloadedAt,
                              ).toLocaleString()
                            : "—"}
                        </span>
                      </span>
                    </div>
                    <div className="sales-rep-action flex min-w-0 flex-col items-end gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="sales-rep-refresh-button gap-2"
                        onClick={() => void refreshSalesBySalesRepSummary()}
                        disabled={salesRepSalesSummaryLoading}
                        aria-busy={salesRepSalesSummaryLoading}
                        title="Refresh sales summary"
                      >
                        <RefreshCw
                          className={`h-4 w-4 ${
                            salesRepSalesSummaryLoading ? "animate-spin" : ""
                          }`}
                          aria-hidden="true"
                        />
                        {salesRepSalesSummaryLoading ? "Refreshing..." : "Refresh"}
                      </Button>
                      <span className="sales-rep-action-meta block text-[11px] text-slate-500 leading-tight text-right">
                        <span className="sales-rep-action-meta-label block">
                          Last fetched
                        </span>
                        <span className="sales-rep-action-meta-value block">
                          {(() => {
                            const ts =
                              salesRepSalesSummaryLastFetchedAt ??
                              salesTrackingLastUpdated ??
                              null;
                            return ts ? new Date(ts).toLocaleTimeString() : "—";
                          })()}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
			
                {/* Totals shown inline above list below */}
			              </div>
	              <div className="sales-rep-table-wrapper" role="region" aria-label="Sales by sales rep list">
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
                  <div className="px-4 py-3 text-sm mb-3 text-slate-500">
                    No sales recorded yet.
                  </div>
                ) : (
	                  <div className="w-full" style={{ minWidth: 780 }}>
	                    <div className="overflow-hidden rounded-xl">
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
                              };
                          const hasTotals =
                            typeof totals.totalOrders === "number" &&
                            typeof totals.totalRevenue === "number";
                          if (!hasTotals) return null;
                          return (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-xl border border-slate-200/70 bg-white/70 px-4 py-2 text-sm font-semibold text-slate-900">
                              <span>Total Orders: {totals.totalOrders}</span>
                              <span>Total Revenue: {formatCurrency(totals.totalRevenue)}</span>
                            </div>
                          );
                        })()}
	                      <div
	                        className="grid items-center gap-3 border-x border-slate-200/70 bg-[rgba(95,179,249,0.08)] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-700"
	                        style={{
	                          gridTemplateColumns:
	                            "minmax(200px,1.3fr) minmax(260px,1.8fr) minmax(90px,0.6fr) minmax(120px,0.6fr)",
	                        }}
	                      >
	                        <div className="whitespace-nowrap">Sales Rep</div>
	                        <div className="whitespace-nowrap">Email</div>
	                        <div className="whitespace-nowrap text-right">Orders</div>
	                        <div className="whitespace-nowrap text-right">Revenue</div>
	                      </div>
                      <ul className="divide-y divide-slate-200/70 border-x border-b border-slate-200/70 rounded-b-xl">
                        {salesRepSalesSummary.map((rep) => (
                          <li
                            key={rep.salesRepId}
                            className="grid items-center gap-3 px-4 py-3"
                            style={{
                              gridTemplateColumns:
                                "minmax(200px,1.3fr) minmax(260px,1.8fr) minmax(90px,0.6fr) minmax(120px,0.6fr)",
                            }}
                          >
                            <div className="text-sm font-semibold text-slate-900">
                              {rep.salesRepName}
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
                              {formatCurrency(rep.totalRevenue || 0)}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
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
                      formatter={(value: number) => [
                        `${value} referral${value === 1 ? "" : "s"}`,
                        "Leads",
                      ]}
                    />
                    <Bar
                      dataKey="count"
                      radius={[10, 10, 6, 6]}
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
                  <div className="flex items-start justify-between gap-3 flex-wrap">
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
	                                    openSalesDoctorDetail({
	                                      ...bucket,
	                                      referralId: resolveReferralIdForDoctorNotes(
	                                        bucket.doctorId,
	                                        bucket.doctorEmail,
	                                      ),
	                                    });
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      e.stopPropagation();
	                                      openSalesDoctorDetail({
	                                        ...bucket,
	                                        referralId: resolveReferralIdForDoctorNotes(
	                                          bucket.doctorId,
	                                          bucket.doctorEmail,
	                                        ),
	                                      });
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
	                            <li key={record.id} className="lead-list-item">
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
	                                    openSalesDoctorDetail({
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
	                                      });
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
	                                        openSalesDoctorDetail({
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
	                                        });
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
			                              <div className="lead-list-actions">
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
                                    handleUpdateReferralStatus(
                                      record.id,
                                      nextValue,
                                    );
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
                                      disabled={isCrediting}
                                      onClick={() =>
                                        handleReferralCredit(
                                          record as ReferralRecord,
                                        )
                                      }
                                      className="mt-2 w-full squircle-sm glass-brand btn-hover-lighter justify-center"
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
                                            disabled={isCrediting}
                                            onClick={() =>
                                              handleReferralCredit(referral)
                                            }
                                            className="w-full squircle-sm glass-brand btn-hover-lighter justify-center"
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
                    <div className="sales-rep-table-wrapper">
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
          Send dashboard recommendations and ideas that will improve your
          productivity to{" "}
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
	        {user && !postLoginHold && (
	          <Header
	            user={user}
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
	            onBuyOrderAgain={handleBuyOrderAgain}
	            onCancelOrder={handleCancelOrder}
	            referralCodes={referralCodesForHeader}
	            catalogLoading={catalogLoading}
	          />
	        )}

        <div className="flex-1 w-full flex flex-col">
          {/* Landing Page - Show when not logged in */}
          {(!user || postLoginHold) && (
            <div className="min-h-screen flex flex-col items-center pt-20 px-4 py-12">
              {/* Logo with Welcome and Quote Containers */}
              {postLoginHold && user ? (
                <div className="w-full max-w-7xl mb-6 px-4">
                  {isDesktopLandingLayout ? (
                    <div className="flex flex-row items-stretch justify-between gap-4 lg:gap-6 mb-8">
                      <div
                        className={`glass-card squircle-lg border border-[var(--brand-glass-border-2)] px-8 py-6 lg:px-10 lg:py-8 shadow-lg transition-all duration-500 flex items-center justify-center flex-1 info-highlight-card ${infoFocusActive ? "info-focus-active" : ""} ${
                          showWelcome
                            ? "opacity-100 translate-y-0"
                            : "opacity-0 -translate-y-4"
                        }`}
                        style={{
                          backdropFilter: "blur(20px) saturate(1.4)",
                          minHeight: "min(140px, 12.5vh)",
                        }}
                      >
                        <p
                          className={`font-semibold text-[rgb(95,179,249)] text-center shimmer-text ${infoFocusActive ? "is-shimmering" : "shimmer-text--cooldown"}`}
                          style={{
                            color: "rgb(95,179,249)",
                            fontSize: infoFocusActive
                              ? "clamp(1.1rem, 2vw, 2rem)"
                              : "clamp(1rem, 1.6vw, 1.75rem)",
                            lineHeight: 1.15,
                            transition: "font-size 800ms ease",
                          }}
                        >
                          Welcome{user.visits && user.visits > 1 ? " back" : ""}
                          , {user.name}!
                        </p>
                      </div>

                      <div className="flex-shrink-0 px-6 lg:px-8">
                        <div className="brand-logo brand-logo--landing">
                          <img
                            src="/Peppro_fulllogo.png"
                            alt="PepPro"
                            style={{
                              display: "block",
                              width: "auto",
                              height: "auto",
                              maxWidth: "min(320px, 35vw)",
                              maxHeight: "min(280px, 25vh)",
                              objectFit: "contain",
                            }}
                          />
                        </div>
                      </div>

                      <div
                        className={`glass-card ${quoteLoading && !quoteReady ? "quote-container-shimmer" : ""} squircle-lg border border-[var(--brand-glass-border-2)] px-8 py-6 lg:px-10 lg:py-8 shadow-lg transition-all duration-500 flex flex-col justify-center flex-1 ${
                          showWelcome
                            ? "opacity-100 translate-y-0"
                            : "opacity-0 translate-y-4 pointer-events-none"
                        }`}
                        style={{
                          backdropFilter: "blur(20px) saturate(1.4)",
                          minHeight: "min(140px, 12.5vh)",
                        }}
                        aria-live="polite"
                      >
                        {quoteLoading && !quoteReady && (
                          <div className="flex w-full flex-1 items-center justify-center">
                            <p className="text-sm font-semibold text-center shimmer-text is-shimmering" style={{ color: "rgb(95,179,249)" }}>
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
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-6 mb-8">
                      <div className="flex justify-center px-4">
                        <div className="brand-logo brand-logo--landing">
                          <img
                            src="/Peppro_fulllogo.png"
                            alt="PepPro"
                            style={{
                              display: "block",
                              width: "auto",
                              height: "auto",
                              maxWidth: "min(320px, 35vw)",
                              maxHeight: "min(280px, 25vh)",
                              objectFit: "contain",
                            }}
                          />
                        </div>
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
                          Welcome{user.visits && user.visits > 1 ? " back" : ""}
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
                      className="post-login-info glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-6 sm:p-8 shadow-xl"
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
                            onClick={handleLogout}
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
                        {/* Regional contact info for doctors */}
                        {!(isRep(user.role) || isAdmin(user.role)) && (
                          <div className="glass-card squircle-md p-4 space-y-2 border border-[var(--brand-glass-border-2)]">
                            <p className="text-sm font-medium text-slate-700">
                              Please contact your Representative
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

                            <div className="mb-4">
                              <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm mb-4">
                                <div
                                  className="landing-richtext text-sm text-gray-700 leading-relaxed"
                                  dangerouslySetInnerHTML={{
                                    __html: physiciansChoiceHtml,
                                  }}
                                />
                              </section>
                            </div>

                            <section className="squircle glass-strong landing-glass-strong border border-[var(--brand-glass-border-3)] p-6 text-slate-900 shadow-sm">
                              <div
                                className="landing-richtext text-sm"
                                dangerouslySetInnerHTML={{
                                  __html: careComplianceHtml,
                                }}
                              />
                            </section>
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
                                Check your inbox for the reset link. If it
                                doesn&rsquo;t arrive within a few minutes,
                                please check your spam folder.
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
      <Elements stripe={stripeClientPromise} key={stripePublishableKey || "stripe"}>
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
          stripeAvailable={Boolean(stripePublishableKey)}
          stripeOnsiteEnabled={stripeSettings?.onsiteEnabled}
        />
      </Elements>

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
        <DialogContent className="max-w-lg">
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
              <Button type="submit" disabled={manualProspectSubmitting}>
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
          }
        }}
	      >
	        <DialogContent className="max-w-2xl">
	          {salesDoctorDetail && (
	            <div className="space-y-4">
	              <DialogHeader>
	                <DialogTitle>{salesDoctorDetail.name}</DialogTitle>
	                <DialogDescription>
	                  {salesDoctorDetail.email ? (
	                    <a href={`mailto:${salesDoctorDetail.email}`}>
	                      {salesDoctorDetail.email}
	                    </a>
	                  ) : (
	                    "Doctor details"
	                  )}
	                </DialogDescription>
	              </DialogHeader>
			              <div className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 space-y-2 min-h-[240px]">
			                <p className="text-sm font-semibold text-slate-800">Notes</p>
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
		              <div className="flex items-center gap-4">
		                <div
		                  className="rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm"
		                  style={{ width: 72, height: 72, minWidth: 72 }}
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
	                  <p className="text-sm text-slate-600">
	                    Orders: {salesDoctorDetail.orders.length}
	                  </p>
	                  <p className="text-sm text-slate-600">
                    Revenue: {formatCurrency(salesDoctorDetail.revenue)}
                  </p>
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
                      <span>{salesDoctorDetail.phone || "Unavailable"}</span>
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

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Total Orders
                  </p>
                  <p className="text-lg font-semibold text-slate-900">
                    {salesDoctorDetail.orders.length}
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

              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-700">
                  Recent Orders
                </p>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {salesDoctorDetail.orders.map((order) => (
                    <div
                      key={order.id}
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <div className="text-sm text-slate-700">
                        {`Order #${order.number ?? order.id}`}
                        <div className="text-xs text-slate-500">
                          {order.createdAt
                            ? formatDateTime(order.createdAt)
                            : "Date unavailable"}
                        </div>
                      </div>
                      <div className="text-right text-sm font-semibold text-slate-900">
                        {formatCurrency(((order as any).grandTotal ?? order.total) || 0)}
                      </div>
                    </div>
                  ))}
                  {salesDoctorDetail.orders.length === 0 && (
                    <p className="text-xs text-slate-500">
                      No orders available.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(salesOrderDetail)}
        onOpenChange={(open) => {
          if (!open) {
            setSalesOrderDetail(null);
            setSalesOrderDetailLoading(false);
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          {salesOrderDetailLoading && (
            <>
              <VisuallyHidden>
                <DialogTitle>Loading order details</DialogTitle>
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
