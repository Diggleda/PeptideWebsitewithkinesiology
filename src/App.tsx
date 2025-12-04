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
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
} from "recharts@2.15.2";
import {
  authAPI,
  ordersAPI,
  referralAPI,
  newsAPI,
  quotesAPI,
  checkServerHealth,
  passwordResetAPI,
  settingsAPI,
} from "./services/api";
import physiciansChoiceHtml from "./content/landing/physicians-choice.html?raw";
import careComplianceHtml from "./content/landing/care-compliance.html?raw";
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
} from "./lib/wooClient";
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
  inStockOnly: boolean;
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
}

interface AccountOrderSummary {
  id: string;
  number?: string | null;
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
  integrationDetails?: Record<string, any> | null;
  shippingAddress?: AccountOrderAddress | null;
  billingAddress?: AccountOrderAddress | null;
  shippingEstimate?: AccountShippingEstimate | null;
  shippingTotal?: number | null;
  taxTotal?: number | null;
  physicianCertified?: boolean | null;
}

const VARIATION_CACHE_STORAGE_KEY = "peppro_variation_cache_v1";

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

const WOO_PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%2395C5F9'/%3E%3Cstop offset='100%25' stop-color='%235FB3F9'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='400' height='400' fill='url(%23g)'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='28' fill='rgba(255,255,255,0.75)'%3EWoo Product%3C/text%3E%3C/svg%3E";

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
  const fallbackDate = options?.fallbackDate || null;
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

const normalizeAccountOrdersResponse = (
  payload: any,
  options?: { includeCanceled?: boolean },
): AccountOrderSummary[] => {
  const includeCanceled = options?.includeCanceled ?? false;
  const result: AccountOrderSummary[] = [];
  const shouldIncludeStatus = (status?: string | null) => {
    if (!status) return true;
    const normalized = String(status).trim().toLowerCase();
    if (normalized === "trash") {
      return includeCanceled;
    }
    return true;
  };

  if (payload && Array.isArray(payload.woo)) {
    payload.woo
      .filter((order: any) => shouldIncludeStatus(order?.status))
      .forEach((order: any) => {
        const identifier = order?.id
          ? String(order.id)
          : order?.number
            ? `woo-${order.number}`
            : `woo-${Math.random().toString(36).slice(2, 10)}`;
        result.push({
          id: identifier,
          number: order?.number || identifier,
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
          lineItems: toOrderLineItems(order?.lineItems),
          integrations: order?.integrations || null,
          paymentMethod: order?.paymentMethod || null,
          integrationDetails: order?.integrationDetails || null,
          shippingAddress: sanitizeOrderAddress(
            order?.shippingAddress || order?.shipping,
          ),
          billingAddress: sanitizeOrderAddress(
            order?.billingAddress || order?.billing,
          ),
          shippingEstimate: normalizeShippingEstimateField(
            order?.shippingEstimate,
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
        });
      });
  }

  if (payload && Array.isArray(payload.local)) {
    payload.local
      .filter((order: any) => shouldIncludeStatus(order?.status))
      .forEach((order: any) => {
        const identifier = order?.id
          ? String(order.id)
          : `local-${Math.random().toString(36).slice(2, 10)}`;
        result.push({
          id: identifier,
          number: order?.number || identifier,
          status:
            order?.status === "trash" ? "canceled" : order?.status || "pending",
          currency: order?.currency || "USD",
          total: coerceNumber(order?.total) ?? null,
          createdAt: order?.createdAt || null,
          updatedAt: order?.updatedAt || null,
          source: "peppro",
          lineItems: toOrderLineItems(order?.items),
          integrations: order?.integrations || null,
          paymentMethod: order?.paymentMethod || null,
          integrationDetails: order?.integrationDetails || null,
          shippingAddress: sanitizeOrderAddress(order?.shippingAddress),
          billingAddress: sanitizeOrderAddress(order?.billingAddress),
          shippingEstimate: normalizeShippingEstimateField(
            order?.shippingEstimate,
            { fallbackDate: order?.createdAt || null },
          ),
          shippingTotal: coerceNumber(order?.shippingTotal) ?? null,
          taxTotal: coerceNumber(order?.taxTotal) ?? null,
          physicianCertified: order?.physicianCertified === true,
        });
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
const CATALOG_POLL_INTERVAL_MS = 0.5 * 60 * 1000; // quietly refresh Woo catalog every 5 minutes

const SALES_REP_PIPELINE = [
  {
    key: "pending_combined",
    label: "Pending / Contact Form",
    statuses: ["pending", "contact_form"],
  },
  {
    key: "contacted",
    label: "Contacted",
    statuses: ["contacted"],
  },
  {
    key: "account_created",
    label: "Account Created",
    statuses: ["account_created"],
  },
  {
    key: "nuture",
    label: "Nuture",
    statuses: ["nuture"],
  },
  {
    key: "converted",
    label: "Converted",
    statuses: ["converted"],
  },
];

const REFERRAL_STATUS_FLOW = [
  { key: "pending", label: "Pending" },
  { key: "contacted", label: "Contacted" },
  { key: "account_created", label: "Account Created" },
  { key: "nuture", label: "Nuture" },
  { key: "converted", label: "Converted" },
];
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
  if (REFERRAL_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return "pending";
};

const CONTACT_FORM_STATUS_FLOW = [
  { key: "contact_form", label: "Pending / Contact Form" },
  { key: "contacted", label: "Contacted" },
  { key: "account_created", label: "Account Created" },
  { key: "nuture", label: "Nuture" },
  { key: "converted", label: "Converted" },
];

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

const mapWooProductToProduct = (
  product: WooProduct,
  productVariations: WooVariation[] = [],
): Product => {
  const imageSources = (product.images ?? [])
    .map((image) => image?.src)
    .filter((src): src is string => Boolean(src));
  const rawCategoryName = product.categories?.[0]?.name?.trim() ?? "";
  const categoryName =
    rawCategoryName && !rawCategoryName.toLowerCase().includes("subscription")
      ? rawCategoryName
      : "";
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
      const label =
        attributes.length > 0
          ? attributes
              .map((attr) => attr.value || attr.name)
              .filter(Boolean)
              .join(" • ")
          : variation.sku
            ? variation.sku
            : `Variant ${variation.id}`;
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
        attributes,
        image: variation.image?.src ?? undefined,
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
    parsePrice(product.price) ?? parsePrice(product.regular_price) ?? 0;
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
  const combinedImages = [...variantImages, ...imageSources].filter(
    (src, index, self) => Boolean(src) && self.indexOf(src) === index,
  ) as string[];
  const galleryImages =
    combinedImages.length > 0 ? combinedImages : [WOO_PLACEHOLDER_IMAGE];
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
    inStock: hasVariants
      ? variantList.some((variant) => variant.inStock)
      : (product.stock_status ?? "").toLowerCase() !== "outofstock",
    prescription: false,
    dosage: hasVariants
      ? `${variantList.length} option${variantList.length === 1 ? "" : "s"} available`
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
        }))
      : [
          {
            id: product.id,
            strength: product.dosage || "Standard",
            basePrice: product.price,
            image: product.image,
            weightOz: product.weightOz ?? null,
          },
        ];

  return {
    id: product.id,
    name: product.name,
    category: product.category,
    image: product.image,
    images: product.images,
    inStock: product.inStock,
    manufacturer: product.manufacturer,
    weightOz: product.weightOz ?? null,
    variations,
    bulkPricingTiers: product.bulkPricingTiers ?? [],
  };
};

const CatalogSkeletonCard = forwardRef<HTMLDivElement>((_props, ref) => (
  <div
    ref={ref}
    className="glass-card squircle-xl p-5 flex flex-col gap-3 min-h-[12rem]"
    aria-hidden="true"
  >
    <div className="h-3 w-1/3 rounded-full bg-slate-200" />
    <div className="space-y-2">
      <div className="h-3 w-5/6 rounded-full bg-slate-100 border border-slate-200" />
      <div className="h-3 w-2/3 rounded-full bg-slate-100 border border-slate-200" />
      <div className="h-3 w-1/2 rounded-full bg-slate-100 border border-slate-200" />
    </div>
    <div className="space-y-2 mt-auto">
      <div className="h-3 w-1/3 rounded-full bg-slate-100 border border-slate-200" />
      <div className="h-3 w-1/4 rounded-full bg-slate-100 border border-slate-200" />
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
      <span className="text-xs font-semibold text-slate-500">{product.category || "PepPro Catalog"}</span>
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
  onAddToCart: (productId: string, variationId: string | undefined | null, quantity: number) => void;
}

const LazyCatalogProductCard = ({ product, onAddToCart }: LazyCatalogProductCardProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isVisible) return;
    const node = placeholderRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
          }
        });
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [isVisible]);

  const cardProduct = useMemo(() => {
    if (!isVisible) return null;
    return toCardProduct(product);
  }, [isVisible, product]);

  if (cardProduct) {
    return (
      <ProductCard
        product={cardProduct}
        onAddToCart={(productId, variationId, quantity) =>
          onAddToCart(productId, variationId, quantity)
        }
      />
    );
  }

  return (
    <div ref={placeholderRef}>
      <CatalogTextPreviewCard product={product} />
    </div>
  );
};

type VariationFetchOptions = {
  cache?: Map<number, WooVariation[]>;
  concurrency?: number;
};

const fetchProductVariations = async (
  products: WooProduct[],
  options: VariationFetchOptions = {},
): Promise<Map<number, WooVariation[]>> => {
  const variationMap = new Map<number, WooVariation[]>();
  if (products.length === 0) {
    return variationMap;
  }

  const queue = [...products];
  const cache = options.cache;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 12, queue.length),
  );

  const workers = Array.from({ length: concurrency }, () =>
    (async function worker() {
      while (queue.length > 0) {
        const nextProduct = queue.shift();
        if (!nextProduct) {
          break;
        }
        const cached = cache?.get(nextProduct.id);
        if (cached) {
          variationMap.set(nextProduct.id, cached);
          continue;
        }
        try {
          const variations = await listProductVariations<WooVariation[]>(
            nextProduct.id,
            { per_page: 100, status: "publish" },
          );
          const normalized = Array.isArray(variations) ? variations : [];
          variationMap.set(nextProduct.id, normalized);
          cache?.set(nextProduct.id, normalized);
        } catch (error) {
          console.warn("[Catalog] Failed to load variations", {
            productId: nextProduct.id,
            error,
          });
          variationMap.set(nextProduct.id, []);
          cache?.set(nextProduct.id, []);
        }
      }
    })(),
  );

  await Promise.all(workers);
  return variationMap;
};

declare global {
  interface Window {
    __PEPPRO_STRIPE_PROMISE?: Promise<Stripe | null>;
  }
}

const STRIPE_PUBLISHABLE_KEY =
  (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined)?.trim() ||
  "";

export default function App() {
  const stripeClientPromise = useMemo(() => {
    if (!STRIPE_PUBLISHABLE_KEY) {
      return null;
    }
    if (typeof window !== "undefined") {
      if (!window.__PEPPRO_STRIPE_PROMISE) {
        window.__PEPPRO_STRIPE_PROMISE = loadStripe(STRIPE_PUBLISHABLE_KEY);
      }
      return window.__PEPPRO_STRIPE_PROMISE;
    }
    return loadStripe(STRIPE_PUBLISHABLE_KEY);
  }, []);
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
  const ensureVariationCacheReady = useCallback(() => {
    if (variationCacheLoadedRef.current) {
      return;
    }
    if (typeof window === "undefined") {
      variationCacheLoadedRef.current = true;
      return;
    }
    variationCacheLoadedRef.current = true;
    try {
      const raw = window.sessionStorage.getItem(
        VARIATION_CACHE_STORAGE_KEY,
      );
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
    try {
      const payload: Record<string, WooVariation[]> = {};
      variationCacheRef.current.forEach((value, key) => {
        payload[String(key)] = value;
      });
      window.sessionStorage.setItem(
        VARIATION_CACHE_STORAGE_KEY,
        JSON.stringify({ data: payload, ts: Date.now() }),
      );
    } catch (error) {
      console.debug("[Catalog] Failed to persist variation cache", error);
    }
  }, []);
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
    const explicitMode = (
      import.meta.env.VITE_STRIPE_MODE ||
      import.meta.env.STRIPE_MODE ||
      ""
    ).toLowerCase();
    if (explicitMode === "test") {
      return true;
    }
    const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
    return pk.startsWith("pk_test");
  }, []);
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
  const [accountModalRequest, setAccountModalRequest] = useState<{
    tab: "details" | "orders";
    open?: boolean;
    token: number;
  } | null>(null);
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
        const response = await ordersAPI.getAll();
        const normalized = normalizeAccountOrdersResponse(response, {
          includeCanceled,
        });
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

  const handleCancelOrder = useCallback(
    async (orderId: string) => {
      if (!orderId) {
        return;
      }
      try {
        await ordersAPI.cancelOrder(orderId, "Cancelled via account portal");
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

    const sendKeepAlive = async () => {
      if (cancelled) {
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
      window.clearInterval(intervalId);
    };
  }, [user]);

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
    inStockOnly: false,
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
  const [salesRepStatusFilter, setSalesRepStatusFilter] =
    useState<string>("all");
  const normalizedReferrals = useMemo(
    () =>
      (salesRepDashboard?.referrals ?? []).map((ref) => ({
        ...ref,
        status: sanitizeReferralStatus(ref.status),
      })),
    [salesRepDashboard?.referrals],
  );
  const hasLeadPlacedOrder = useCallback((lead: any) => {
    const orders = coerceNumber(lead?.referredContactTotalOrders) ?? 0;
    return orders > 0;
  }, []);
  const [salesTrackingOrders, setSalesTrackingOrders] = useState<
    AccountOrderSummary[]
  >([]);
  const [salesTrackingDoctors, setSalesTrackingDoctors] = useState<
    Map<
      string,
      {
        name: string;
        email?: string | null;
        profileImageUrl?: string | null;
      }
    >
  >(new Map());
  const [salesTrackingLoading, setSalesTrackingLoading] = useState(false);
  const [salesTrackingError, setSalesTrackingError] = useState<string | null>(
    null,
  );
  const [salesTrackingLastUpdated, setSalesTrackingLastUpdated] = useState<
    number | null
  >(null);
  const [salesRepSalesSummary, setSalesRepSalesSummary] = useState<
    {
      salesRepId: string;
      salesRepName: string;
      salesRepEmail: string | null;
      totalOrders: number;
      totalRevenue: number;
    }[]
  >([]);
  const [salesRepSalesSummaryError, setSalesRepSalesSummaryError] = useState<
    string | null
  >(null);
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
    const directCode = (user?.referralCode || "").trim().toUpperCase();
    const merged = [
      ...normalizedDashboardCodes,
      ...userReferralCodes,
      ...(directCode ? [directCode] : []),
    ];
    return merged.filter(
      (value, index, array) => value.length > 0 && array.indexOf(value) === index,
    );
  }, [normalizedDashboardCodes, userReferralCodes, user?.referralCode]);

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
  const referralRefreshInFlight = useRef(false);
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
  const [catalogCategories, setCatalogCategories] = useState<string[]>([]);
  const [catalogTypes, setCatalogTypes] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const catalogFetchInFlightRef = useRef(false);
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

  const referralFilterStatuses = useMemo(() => {
    const defaults = REFERRAL_STATUS_FLOW.filter(
      (stage) => !REFERRAL_LEAD_STATUS_KEYS.has(stage.key),
    ).map((stage) => stage.key);
    const dynamic = salesRepStatusOptions
      .map((status) => status.toLowerCase())
      .filter((status) => !isLeadStatus(status) && status !== "contact_form");
    return Array.from(new Set([...defaults, ...dynamic]));
  }, [salesRepStatusOptions, isLeadStatus]);

  const leadStatusOptions = useMemo(() => {
    const defaults = REFERRAL_STATUS_FLOW.map((stage) => stage.key);
    const dynamic = salesRepStatusOptions
      .map((status) => status.toLowerCase())
      .filter((status) => status === "pending" || isLeadStatus(status));
    return Array.from(new Set([...defaults, ...dynamic]));
  }, [salesRepStatusOptions, isLeadStatus]);

  const contactFormEntries = useMemo(() => {
    return normalizedReferrals.filter(isContactFormEntry);
  }, [normalizedReferrals, isContactFormEntry]);

  const contactFormQueue = useMemo(() => {
    return contactFormEntries.filter((entry) => !isLeadStatus(entry.status));
  }, [contactFormEntries, isLeadStatus]);

  const contactFormPipeline = useMemo(() => {
    return contactFormEntries.filter(
      (entry) =>
        isLeadStatus(entry.status) &&
        !(entry.referredContactEligibleForCredit === true) &&
        !(sanitizeReferralStatus(entry.status) === "converted" && hasLeadPlacedOrder(entry)),
    );
  }, [contactFormEntries, hasLeadPlacedOrder, isLeadStatus]);

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
      (referral) => !isContactFormEntry(referral),
    );
  }, [normalizedReferrals, isContactFormEntry]);

  const referralLeadEntries = useMemo(() => {
    return referralRecords.filter((referral) => isLeadStatus(referral.status));
  }, [referralRecords, isLeadStatus]);

  const activeReferralEntries = useMemo(() => {
    return referralLeadEntries.filter((referral) => {
      const status = sanitizeReferralStatus(referral.status);
      const hasOrders = hasLeadPlacedOrder(referral);
      if (status === "converted" && hasOrders) {
        return false;
      }
      return !referral.creditIssuedAt;
    });
  }, [hasLeadPlacedOrder, referralLeadEntries]);

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
    [activeReferralEntries, contactFormPipeline],
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

  const filteredSalesRepReferrals = useMemo(() => {
    const normalizedFilter = salesRepStatusFilter.toLowerCase();
    const allReferrals = referralQueue;
    console.debug("[Referral] Filter compute", {
      filter: normalizedFilter,
      total: allReferrals.length,
    });
    if (normalizedFilter === "contact_form") {
      return [];
    }
    if (normalizedFilter === "all") {
      return allReferrals;
    }
    const filtered = allReferrals.filter(
      (referral) => (referral.status || "").toLowerCase() === normalizedFilter,
    );
    console.debug("[Referral] Filter result", {
      filter: normalizedFilter,
      count: filtered.length,
    });
    return filtered;
  }, [referralQueue, salesRepStatusFilter]);

  const salesRepChartData = useMemo(() => {
    const counts = normalizedReferrals.reduce<Record<string, number>>(
      (acc, referral) => {
        const status = (referral.status || "pending").toLowerCase();
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      },
      {},
    );

    return SALES_REP_PIPELINE.map((stage) => ({
      status: stage.key,
      label: stage.label,
      count: stage.statuses.reduce(
        (total, statusKey) => total + (counts[statusKey] || 0),
        0,
      ),
    }));
  }, [normalizedReferrals]);

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

  useEffect(() => {
    if (salesRepStatusFilter === "all") {
      return;
    }
    const available = new Set(
      referralFilterStatuses.map((status) => status.toLowerCase()),
    );
    if (!available.has(salesRepStatusFilter.toLowerCase())) {
      setSalesRepStatusFilter("all");
    }
  }, [salesRepStatusFilter, referralFilterStatuses]);

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

  const resolveOrderDoctorId = useCallback(
    (order: AccountOrderSummary): string | null => {
      const asAny = order as Record<string, any>;
      const integration = (order.integrationDetails ||
        order.integrations) as Record<string, any> | null;
      const candidate =
        asAny.userId ??
        asAny.doctorId ??
        asAny.salesRepDoctorId ??
        integration?.doctorId ??
        integration?.referrerDoctorId ??
        integration?.userId ??
        null;
      if (!candidate) {
        return null;
      }
      return String(candidate);
    },
    [],
  );

  const fetchSalesTrackingOrders = useCallback(async () => {
    if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
      setSalesTrackingOrders([]);
      setSalesTrackingDoctors(new Map());
      setSalesRepSalesSummary([]);
      setSalesTrackingError(null);
      setSalesRepSalesSummaryError(null);
      setSalesTrackingLoading(false);
      return;
    }

    setSalesTrackingLoading(true);
    setSalesTrackingError(null);
    setSalesRepSalesSummaryError(null);

    try {
      console.log("[Sales Tracking] Fetch start", {
        role: user.role || null,
        salesRepId: user.salesRepId || null,
      });
      let orders: AccountOrderSummary[] = [];
      const doctorLookup = new Map<
        string,
        { name: string; email?: string | null; profileImageUrl?: string | null }
      >();

      const response = await ordersAPI.getForSalesRep({
        salesRepId: user.salesRepId || user.id || undefined,
        scope: isAdmin(user.role) ? "mine" : "mine",
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
        const doctors = Array.isArray(respObj.doctors) ? respObj.doctors : [];
        doctors.forEach((doc: any) => {
          const id = doc.id || doc.doctorId || doc.userId;
          if (!id) return;
          doctorLookup.set(String(id), {
            name: doc.name || doc.email || "Doctor",
            email: doc.email || doc.doctorEmail || null,
            profileImageUrl:
              doc.profileImageUrl || doc.profile_image_url || null,
          });
        });
      } else if (Array.isArray(response)) {
        orders = response as AccountOrderSummary[];
      }

      if (isAdmin(user.role)) {
        try {
          const salesSummaryResponse = await ordersAPI.getSalesByRepForAdmin();
          const summaryArray = Array.isArray(salesSummaryResponse)
            ? salesSummaryResponse
            : Array.isArray((salesSummaryResponse as any)?.orders)
              ? (salesSummaryResponse as any).orders
              : [];
          const filteredSummary = summaryArray.filter(
            (rep: any) => rep.salesRepId !== user.id,
          );
          setSalesRepSalesSummary(filteredSummary as any);
        } catch (adminError: any) {
          const message =
            typeof adminError?.message === "string"
              ? adminError.message
              : "Unable to load sales summary";
          setSalesRepSalesSummaryError(message);
        }
      }

      const enriched = orders
        .map((order) => {
          const doctorId = resolveOrderDoctorId(order);
          const doctorInfo = doctorId ? doctorLookup.get(doctorId) : null;
          return {
            order: {
              ...order,
              doctorId: doctorId || order.doctorId || null,
              doctorName:
                doctorInfo?.name ||
                (doctorId ? salesRepDoctorsById.get(doctorId) : null) ||
                order.doctorName ||
                "Doctor",
              doctorEmail: doctorInfo?.email || order.doctorEmail || null,
              doctorProfileImageUrl:
                doctorInfo?.profileImageUrl ||
                (order as any).doctorProfileImageUrl ||
                null,
            },
            doctorId,
          };
        })
        .sort((a, b) => {
          const aTime = a.order.createdAt
            ? new Date(a.order.createdAt).getTime()
            : 0;
          const bTime = b.order.createdAt
            ? new Date(b.order.createdAt).getTime()
            : 0;
          return bTime - aTime;
        })
        .map((entry) => entry.order);

      setSalesTrackingDoctors(doctorLookup);
      setSalesTrackingOrders(enriched);
      setSalesTrackingLastUpdated(Date.now());
      console.log("[Sales Tracking] Orders loaded", {
        count: enriched.length,
        doctors: doctorLookup.size,
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
    }
  }, [user, resolveOrderDoctorId, isRep, isAdmin, salesRepDoctorsById]);

  useEffect(() => {
    if (!user || (!isRep(user.role) && !isAdmin(user.role))) {
      return;
    }
    fetchSalesTrackingOrders();
    const pollHandle = window.setInterval(() => {
      void fetchSalesTrackingOrders();
    }, 30000);
    return () => {
      window.clearInterval(pollHandle);
    };
  }, [fetchSalesTrackingOrders, salesRepDoctorIds, user, isRep, isAdmin]);

  const salesTrackingSummary = useMemo(() => {
    if (salesTrackingOrders.length === 0) {
      return null;
    }
    const revenue = salesTrackingOrders.reduce(
      (sum, order) => sum + (coerceNumber(order.total) ?? 0),
      0,
    );
    return {
      totalOrders: salesTrackingOrders.length,
      totalRevenue: revenue,
      latestOrder: salesTrackingOrders[0],
    };
  }, [salesTrackingOrders]);

  const salesTrackingOrdersByDoctor = useMemo(() => {
    const buckets = new Map<
      string,
      {
        doctorId: string;
        doctorName: string;
        doctorEmail?: string | null;
        doctorAvatar?: string | null;
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
      const bucket =
        buckets.get(doctorId) ||
        (() => {
          const created = {
            doctorId,
            doctorName,
            doctorEmail,
            doctorAvatar,
            orders: [] as AccountOrderSummary[],
            total: 0,
          };
          buckets.set(doctorId, created);
          return created;
        })();
      bucket.orders.push(order);
      bucket.total += coerceNumber(order.total) ?? 0;
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
    try {
      const localToken = localStorage.getItem("auth_token");
      if (localToken && localToken.trim().length > 0) {
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

      const shouldShowLoading = options?.showLoading ?? true;

      if (referralRefreshInFlight.current) {
        if (shouldShowLoading) {
          setReferralDataLoading(true);
        }
        return;
      }

      referralRefreshInFlight.current = true;

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
          notes: manualProspectForm.notes.trim() || undefined,
          status: manualProspectForm.status,
        });
        toast.success("Prospect added successfully.");
        closeManualProspectModal();
        await refreshReferralData({ showLoading: false });
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
      refreshReferralData,
    ],
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
        await refreshReferralData({ showLoading: false });
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
    [refreshReferralData],
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

  useEffect(() => {
    ensureVariationCacheReady();
  }, [ensureVariationCacheReady]);

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
    const scheduleRetry = (background = false) => {
      if (catalogRetryTimeoutRef.current) {
        window.clearTimeout(catalogRetryTimeoutRef.current);
      }
      catalogRetryTimeoutRef.current = window.setTimeout(() => {
        void loadCatalog(background);
      }, CATALOG_RETRY_DELAY_MS);
    };

    const loadCatalog = async (background = false) => {
      if (cancelled || catalogFetchInFlightRef.current) {
        return;
      }

      catalogFetchInFlightRef.current = true;
      catalogRetryTimeoutRef.current = null;
      if (!background) {
        setCatalogLoading(true);
      }
      setCatalogError(null);
      try {
        const [wooProducts, wooCategories] = await Promise.all([
          listProducts<WooProduct[]>({ per_page: 48, status: "publish" }),
          listCategories<WooCategory[]>({ per_page: 100 }),
        ]);

        if (cancelled) {
          return;
        }

        const applyCatalogState = (products: Product[]) => {
          if (!products || products.length === 0) {
            return false;
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
          const categoryNamesFromApi = Array.isArray(wooCategories)
            ? wooCategories
                .map((category) => category?.name?.trim())
                .filter(
                  (name): name is string =>
                    Boolean(name) &&
                    !name.toLowerCase().includes("subscription"),
                )
            : [];
          const nextCategories =
            categoriesFromProducts.length > 0
              ? categoriesFromProducts
              : categoryNamesFromApi.length > 0
                ? categoryNamesFromApi
                : [];
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

        const baseProducts = (wooProducts ?? [])
          .filter((item): item is WooProduct =>
            Boolean(item && typeof item === "object" && "id" in item),
          )
          .map((item) => mapWooProductToProduct(item, []))
          .filter((product): product is Product => Boolean(product && product.name));

        const hadBaseProducts = applyCatalogState(baseProducts);
        if (hadBaseProducts) {
          setCatalogLoading(false);
        }

        const variableProducts = (wooProducts ?? []).filter(
          (item): item is WooProduct =>
            Boolean(
              item && typeof item === "object" && item.type === "variable",
            ),
        );
        ensureVariationCacheReady();
        const variationMap =
          variableProducts.length > 0
            ? await fetchProductVariations(variableProducts, {
                cache: variationCacheRef.current,
                concurrency: 12,
              })
            : new Map<number, WooVariation[]>();
        if (variableProducts.length > 0) {
          persistVariationCache();
        }

        if (cancelled) {
          return;
        }

        const mappedProducts = (wooProducts ?? [])
          .filter((item): item is WooProduct =>
            Boolean(item && typeof item === "object" && "id" in item),
          )
          .map((item) =>
            mapWooProductToProduct(item, variationMap.get(item.id) ?? []),
          )
          .filter((product) => product && product.name);

        if (applyCatalogState(mappedProducts)) {
          setCatalogLoading(false);
          catalogFetchInFlightRef.current = false;
          return;
        }

        if (Array.isArray(wooCategories) && wooCategories.length > 0) {
          const categoryNames = wooCategories
            .map((category) => category?.name?.trim())
            .filter(
              (name): name is string =>
                Boolean(name) && !name.toLowerCase().includes("subscription"),
            );
          if (categoryNames.length > 0) {
            setCatalogCategories(categoryNames);
          }
        }

        setCatalogLoading(false);
        scheduleRetry(background);
      } catch (error) {
        if (!cancelled) {
          console.warn("[Catalog] Catalog fetch failed", error);
          if (!background) {
            setCatalogProducts([]);
            setCatalogCategories([]);
            setCatalogTypes([]);
            setCatalogError(null);
            setCatalogLoading(false);
          }
          scheduleRetry(background);
        }
      } finally {
        catalogFetchInFlightRef.current = false;
      }
    };

    void loadCatalog(false);

    const intervalId = window.setInterval(() => {
      void loadCatalog(true);
    }, CATALOG_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (catalogRetryTimeoutRef.current) {
        window.clearTimeout(catalogRetryTimeoutRef.current);
      }
      window.clearInterval(intervalId);
    };
  }, [ensureVariationCacheReady, persistVariationCache]);

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
      setSalesRepStatusFilter("all");
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
        await refreshReferralData({ showLoading: true });
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
        refreshReferralData({ showLoading: false });
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshIfActive();
      }
    };

    const handleFocus = () => {
      refreshIfActive();
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
    refreshReferralData,
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
  ): Promise<AuthActionResult> => {
    console.debug("[Auth] Login attempt", { email, attempt });
    try {
      const user = await authAPI.login(email, password);
      applyLoginSuccessState(user);
      void storePasswordCredential(email, password, user.name || email);
      console.debug("[Auth] Login success", {
        userId: user.id,
        visits: user.visits,
      });
      return { status: "success" };
    } catch (error: any) {
      console.warn("[Auth] Login failed", { email, error });
      const message = error.message || "LOGIN_ERROR";

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
        normalizedMessage.includes("NETWORKERROR") ||
        normalizedMessage.includes("NETWORK_ERROR");
      const isServerError = statusCode !== null && statusCode >= 500;

      if (attempt === 0 && (isNetworkError || isServerError)) {
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
        return loginWithRetry(email, password, attempt + 1);
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

  const handleLogout = () => {
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
  };

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

      if (sku) {
        for (const product of catalogProducts) {
          const variant = product.variants?.find(
            (v) => v.sku && v.sku.trim() === sku,
          );
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

        if (
          matchedProduct &&
          variantLabel &&
          matchedProduct.variants &&
          matchedProduct.variants.length > 0
        ) {
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

      // If product has variants but none matched, fall back to a sensible default.
      if (
        !matchedVariant &&
        matchedProduct.variants &&
        matchedProduct.variants.length > 0
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
    toast("Order loaded into a new cart.", {
      style: {
        backgroundColor: "rgb(95,179,249)",
        color: "#ffffff",
      },
    });
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
    physicianCertificationAccepted?: boolean;
    taxTotal?: number | null;
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
      const unitWeightOz = variant?.weightOz ?? product.weightOz ?? null;
      const dimensions = variant?.dimensions || product.dimensions || undefined;
      return {
        cartItemId: id,
        productId: resolvedProductId,
        variantId: resolvedVariantId,
        sku: resolvedSku,
        name: variant ? `${product.name} — ${variant.label}` : product.name,
        price: variant?.price ?? product.price,
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
    const total = itemTotal + (options?.shippingTotal || 0) + taxTotal;

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
        {
          physicianCertification:
            options?.physicianCertificationAccepted === true,
        },
        taxTotal,
      );
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
        notes: referralForm.notes.trim() || undefined,
      });
      setReferralStatusMessage({
        type: "success",
        message: "Referral sent to your regional administrator.",
      });
      setReferralForm({
        contactName: "",
        contactEmail: "",
        contactPhone: "",
        notes: "",
      });
      setReferralSearchTerm("");
      await refreshReferralData({ showLoading: true });
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
        await refreshReferralData({ showLoading: false });
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
    [refreshReferralData],
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
                className="h-5 w-5"
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
                    Your regional administrator will credit you $50 each time
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
            <div className="glass squircle-lg p-8 shadow-sm space-y-6 w-full max-w-none">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center squircle-sm bg-emerald-100">
                    <svg
                      className="w-4 h-4 text-emerald-600"
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
                  <h3 className="text-base font-semibold text-slate-800">
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
                        className="animate-spin h-3 w-3"
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
                              return (
                                <div
                                  key={referral.id}
                                  className="referrals-table__row"
                                  role="row"
                                >
                                  <div
                                    className="referrals-table__cell"
                                    role="cell"
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
                                  <div className="referrals-table__cell" role="cell">
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

            <div className="glass squircle-lg p-8 shadow-sm min-w-0 space-y-6 w-full max-w-none">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center squircle-sm bg-amber-100">
                    <svg
                      className="w-4 h-4 text-amber-600"
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
                  <h3 className="text-base font-semibold text-slate-800">
                    Credit Activity
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
                        className="w-3 h-3"
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
      statusChips.push({ key: "stripe", label: "Stripe test mode" });
    }
    if (catalogLoading) {
      statusChips.push({ key: "loading", label: "loading-icon" });
    }
    if (catalogError) {
      statusChips.push({ key: "error", label: "Woo sync issue" });
    }
    const showSkeletonGrid = catalogLoading && filteredProducts.length === 0;
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
            {catalogCategories.length > 0 ? (
              <CategoryFilter
                categories={catalogCategories}
                types={[]}
                filters={filters}
                onFiltersChange={setFilters}
                productCounts={productCounts}
                typeCounts={{}}
              />
            ) : (
              <div className="glass-card squircle-lg px-8 py-6 lg:px-12 lg:py-8 text-sm text-slate-700" aria-live="polite">
                <p className="font-semibold text-slate-900">
                  Fetching Catelogue... Please wait while we load the products
                </p>
              </div>
            )}
          </div>
        )}

        {/* Products Grid */}
        <div className="w-full min-w-0 flex-1">
          <div className="flex flex-wrap lg:flex-nowrap items-center gap-3 mb-6">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
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
                          className="h-3 w-3.1 text-[rgb(30,41,59)]"
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

            <div className="flex flex-wrap items-center gap-2 sm:gap-3 ml-auto min-w-[min(100%,220px)] justify-end">
              {totalCartItems > 0 && (
                <Button
                  variant="ghost"
                  onClick={() => setCheckoutOpen(true)}
                  ref={checkoutButtonRef}
                  className="squircle-sm glass-brand shadow-lg shadow-[rgba(95,179,249,0.4)] transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 px-5 py-2 min-w-[8.5rem] justify-center"
                >
                  <ShoppingCart className="w-4 h-4 mr-2" />
                  Checkout ({totalCartItems})
                </Button>
              )}
            </div>
          </div>

          {showSkeletonGrid ? (
            <div className="grid gap-6 w-full pr-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
              {productSkeletons.map((_, index) => (
                <CatalogSkeletonCard key={`catalog-skeleton-${index}`} />
              ))}
            </div>
          ) : filteredProducts.length > 0 ? (
            <div className="grid gap-6 w-full pr-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
              {filteredProducts.map((product) => (
                <LazyCatalogProductCard
                  key={product.id}
                  product={product}
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
                  {catalogLoading ? "Fetching products…" : "No products found"}
                </h3>
                <p className="text-gray-600">
                  {catalogLoading
                    ? "Please wait while we load the catalog."
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
                Monitor referral progress and keep statuses in sync.
              </p>
            </div>
          </div>

          {adminActionState.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {adminActionState.error}
            </p>
          )}

          {isAdmin(user?.role) && (
            <div className="glass-card squircle-xl p-6 border border-slate-200/70">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Sales by Sales Rep
                  </h3>
                  <p className="text-sm text-slate-600">
                    Orders placed by doctors assigned to each rep.
                  </p>
                </div>
                <span className="text-xs text-slate-500">
                  Fetched{" "}
                  {salesTrackingLastUpdated
                    ? new Date(salesTrackingLastUpdated).toLocaleTimeString()
                    : "—"}
                </span>
              </div>
              <div className="overflow-x-auto">
                {salesRepSalesSummaryError ? (
                  <div className="px-4 py-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md">
                    {salesRepSalesSummaryError}
                  </div>
                ) : salesRepSalesSummary.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-slate-500">
                    No sales recorded yet.
                  </div>
                ) : (
                  <table className="min-w-[640px] w-full divide-y divide-slate-200/70">
                    <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-4 py-2 text-left">Sales Rep</th>
                        <th className="px-4 py-2 text-left">Email</th>
                        <th className="px-4 py-2 text-right">Orders</th>
                        <th className="px-4 py-2 text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {salesRepSalesSummary.map((rep) => (
                        <tr key={rep.salesRepId}>
                          <td className="px-4 py-3 text-sm font-medium text-slate-800">
                            {rep.salesRepName}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600">
                            {rep.salesRepEmail || "—"}
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-slate-800">
                            {rep.totalOrders}
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-semibold text-slate-900">
                            {formatCurrency(rep.totalRevenue || 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
          <div className="sales-rep-combined-chart">
            <div className="sales-rep-chart-header">
              <div>
                <h3>Pipeline</h3>
                <p>Track lead volume as contacts advance through each stage.</p>
              </div>
            </div>
            <div className="sales-rep-chart-body">
              {hasChartData ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={salesRepChartData}
                    margin={{ top: 16, right: 16, left: 0, bottom: 8 }}
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
                      height={90}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 12, fill: "#334155" }}
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
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="sales-rep-chart-empty">
                  <p className="text-sm text-slate-600">
                    No referral activity yet. Keep an eye here as leads arrive.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="sales-rep-dashboard-grid">
            <div className="sales-rep-leads-card sales-rep-combined-card">
              <div className="sales-rep-leads-header">
                <div>
                  <h3>Your Sales</h3>
                  <p className="text-sm text-slate-600">
                    Live orders grouped by your doctors.
                  </p>
                </div>
                <div className="sales-rep-card-controls sales-metric-controls">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fetchSalesTrackingOrders()}
                    disabled={salesTrackingLoading}
                    className="gap-2"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${salesTrackingLoading ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </Button>
                  <div className="sales-metric-pill-group">
                    <div className="sales-metric-pill">
                      <p className="sales-metric-label">Orders</p>
                      <p className="sales-metric-value">
                        {salesTrackingSummary?.totalOrders ?? 0}
                      </p>
                    </div>
                    <div className="sales-metric-pill">
                      <p className="sales-metric-label">Total Revenue</p>
                      <p className="sales-metric-value">
                        {formatCurrency(
                          salesTrackingSummary?.totalRevenue ?? 0,
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="sales-rep-lead-grid">
                {salesTrackingLoading && (
                  <p className="lead-panel-empty text-sm text-slate-500">
                    Loading sales data from your doctors…
                  </p>
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
                    return (
                      <section key={bucket.doctorId} className="lead-panel">
                        <div className="lead-panel-header">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200 shadow-sm">
                              {bucket.doctorAvatar ? (
                                <img
                                  src={bucket.doctorAvatar}
                                  alt={bucket.doctorName}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <span className="text-sm font-semibold text-slate-600">
                                  {getInitials(bucket.doctorName)}
                                </span>
                              )}
                            </div>
                            <div>
                              <p className="lead-list-name">
                                {bucket.doctorName}
                              </p>
                              {bucket.doctorEmail && (
                                <p className="lead-list-detail">
                                  {bucket.doctorEmail}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-slate-500 uppercase tracking-[0.16em]">
                              Revenue
                            </p>
                            <p className="text-base font-semibold text-slate-900">
                              {formatCurrency(bucket.total)}
                            </p>
                          </div>
                        </div>
                        <ul className="lead-list">
                          {bucket.orders.map((order) => (
                            <li key={order.id} className="lead-list-item">
                              <div className="lead-list-meta">
                                <div className="lead-list-name">
                                  Order #{order.number ?? order.id}
                                </div>
                                <div className="lead-list-detail">
                                  {order.createdAt
                                    ? formatDateTime(order.createdAt)
                                    : "Unknown date"}
                                </div>
                              </div>
                              <div className="lead-list-actions">
                                <div className="lead-updated">
                                  {formatCurrency(order.total)}
                                </div>
                                <span className="sales-tracking-row-status">
                                  {order.status ?? "Pending"}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
              </div>
            </div>
            <div className="sales-rep-leads-card sales-rep-combined-card">
              <div className="sales-rep-leads-header">
                <div>
                  <h3>Your Leads</h3>
                  <p>
                    Advance referrals and inbound requests through your
                    pipeline.
                  </p>
                </div>
                <div className="sales-rep-card-controls">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => refreshReferralData({ showLoading: true })}
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
              <div className="sales-rep-lead-grid">
                <section className="lead-panel">
                  <div className="flex justify-end mb-3">
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
                  <div className="lead-panel-header">
                    <div>
                      <h4>Active Prospects</h4>
                      <p className="text-sm text-slate-500">
                        Combination of referral and contact form prospects.
                      </p>
                    </div>
                    <span className="lead-panel-count">
                      {combinedLeadEntries.length}{" "}
                      {combinedLeadEntries.length === 1
                        ? "Prospect"
                        : "Prospects"}
                    </span>
                  </div>
                  {referralDataLoading && combinedLeadEntries.length === 0 ? (
                    <p className="lead-panel-empty text-sm text-slate-500">
                      Loading prospects…
                    </p>
                  ) : combinedLeadEntries.length === 0 ? (
                    <p className="lead-panel-empty text-sm text-slate-500">
                      Nobody yet. Update a referral or contact form status to
                      move it here.
                    </p>
                  ) : (
                    <div className="lead-list-scroll">
                      <ul className="lead-list">
                        {combinedLeadEntries.map(({ kind, record }) => {
                          const isUpdating =
                            adminActionState.updatingReferral === record.id;
                          const normalizedStatus =
                            kind === "contact_form"
                              ? (record.status || "contact_form").toLowerCase()
                              : sanitizeReferralStatus(record.status);
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
                            normalizedStatus === "converted" &&
                            !hasLeadPlacedOrder(record);
                          return (
                            <li key={record.id} className="lead-list-item">
                              <div className="lead-list-meta">
                                <div className="lead-list-name">
                                  {record.referredContactName ||
                                    record.referredContactEmail ||
                                    "—"}
                                </div>
                                {record.referredContactEmail && (
                                  <div className="lead-list-detail">
                                    {record.referredContactEmail}
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
                                  value={normalizedStatus}
                                  disabled={isUpdating}
                                  onChange={(event) => {
                                    const nextValue = event.target.value;
                                    if (
                                      isManualLead &&
                                      nextValue === MANUAL_PROSPECT_DELETE_VALUE
                                    ) {
                                      handleDeleteManualProspect(record.id);
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
                                  {kind === "contact_form"
                                    ? CONTACT_FORM_STATUS_FLOW.map((stage) => (
                                        <option
                                          key={stage.key}
                                          value={stage.key}
                                        >
                                          {stage.label}
                                        </option>
                                      ))
                                    : leadStatusOptions.map((status) => (
                                        <option key={status} value={status}>
                                          {humanizeReferralStatus(status)}
                                        </option>
                                  ))}
                                </select>
                                {awaitingFirstPurchase && (
                                  <div className="text-xs text-amber-600 text-center mt-1">
                                    Awaiting their first purchase
                                  </div>
                                )}
                                {kind === "referral" &&
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
                                  normalizedStatus === "converted" &&
                                  !referralCreditTimestamp &&
                                  !creditEligible && (
                                    <div className="text-xs text-slate-500 text-center mt-1">
                                      Awaiting first order to credit
                                    </div>
                                  )}
                                <div className="flex flex-col items-end gap-1 min-w-[220px]">
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
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </section>
                <section className="lead-panel">
                  <div className="lead-panel-header">
                    <div>
                      <h4>Referrals</h4>
                      <p className="text-sm text-slate-500">
                        Qualify new referrals and update their status.
                      </p>
                    </div>
                    <div className="lead-panel-actions">
                      <select
                        value={salesRepStatusFilter}
                        onChange={(event) =>
                          setSalesRepStatusFilter(event.target.value)
                        }
                        className="rounded-md border border-slate-200/80 bg-white/90 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                      >
                        <option value="all">All statuses</option>
                        {referralFilterStatuses.map((status) => (
                          <option key={status} value={status}>
                            {humanizeReferralStatus(status)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="sales-rep-table-wrapper">
                    <table className="min-w-[720px] divide-y divide-slate-200/70">
                      <thead className="bg-slate-50/70">
                        <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="px-4 py-3">Referrer</th>
                          <th className="px-4 py-3">Lead</th>
                          <th className="px-4 py-3">Notes from Referrer</th>
                          <th className="px-4 py-3 whitespace-nowrap">
                            Submitted
                          </th>
                          <th className="px-4 py-3">Status Tracker</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/60">
                        {referralDataLoading ? (
                          <tr>
                            <td
                              colSpan={5}
                              className="px-4 py-6 text-center text-sm text-slate-500"
                            >
                              Loading referrals…
                            </td>
                          </tr>
                        ) : filteredSalesRepReferrals.length === 0 ? (
                          <tr>
                            <td
                              colSpan={5}
                              className="px-4 py-6 text-center text-sm text-slate-500"
                            >
                              No referrals match this filter.
                            </td>
                          </tr>
                        ) : (
                          filteredSalesRepReferrals.map((referral) => {
                            const isUpdating =
                              adminActionState.updatingReferral === referral.id;
                            const isCrediting =
                              creditingReferralId === referral.id;
                            const referralStatusOptions =
                              REFERRAL_STATUS_FLOW.map((stage) => stage.key);
                            const normalizedStatus = sanitizeReferralStatus(
                              referral.status,
                            );
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
                            const manualLead = isManualEntry(referral);
                            return (
                              <tr key={referral.id} className="align-top">
                                <td className="px-4 py-4">
                                  <div className="font-semibold text-slate-900">
                                    {referral.referrerDoctorName ?? "—"}
                                  </div>
                                  <div className="text-xs text-slate-500">
                                    {referral.referrerDoctorEmail ?? "—"}
                                  </div>
                                  {referral.referrerDoctorPhone && (
                                    <div className="text-xs text-slate-500">
                                      {referral.referrerDoctorPhone}
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-4">
                                  <div className="font-medium text-slate-900">
                                    {referral.referredContactName || "—"}
                                  </div>
                                  {referral.referredContactEmail && (
                                    <div className="text-xs text-slate-500">
                                      {referral.referredContactEmail}
                                    </div>
                                  )}
                                  {referral.referredContactPhone && (
                                    <div className="text-xs text-slate-500">
                                      {referral.referredContactPhone}
                                    </div>
                                  )}
                                  {manualLead && (
                                    <span className="lead-source-pill lead-source-pill--manual mt-2">
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
                                </td>
                                <td className="px-4 py-4">
                                  {referral.notes ? (
                                    <div className="max-w-md text-sm text-slate-600 whitespace-pre-wrap">
                                      {referral.notes}
                                    </div>
                                  ) : (
                                    <span className="text-xs italic text-slate-400">
                                      No notes
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-4 text-sm text-slate-600">
                                  <div>
                                    {formatDateTime(referral.createdAt)}
                                  </div>
                                  <div className="text-xs text-slate-400">
                                    Updated {formatDateTime(referral.updatedAt)}
                                  </div>
                                </td>
                                <td className="px-4 py-4">
                                  <div className="flex flex-col gap-2">
                                    <select
                                      value={normalizedStatus}
                                      onChange={(event) => {
                                        const nextValue = event.target.value;
                                        if (
                                          manualLead &&
                                          nextValue === MANUAL_PROSPECT_DELETE_VALUE
                                        ) {
                                          handleDeleteManualProspect(
                                            referral.id,
                                          );
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
                                        <option key={status} value={status}>
                                          {humanizeReferralStatus(status)}
                                        </option>
                                      ))}
                                    </select>
                                    <div className="flex flex-col gap-2 items-end min-w-[220px]">
                                      {normalizedStatus === "converted" &&
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
                                      <div className="text-xs text-slate-500 text-right">
                                        Updated{" "}
                                        {formatDateTime(referral.updatedAt)}
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
                {isAdmin(user?.role) && (
                  <section className="lead-panel">
                    <div className="lead-panel-header">
                      <div>
                        <h4>House / Contact Form</h4>
                        <p className="text-sm text-slate-500">
                          Inbound submissions captured directly from the site.
                        </p>
                      </div>
                      <span className="lead-panel-count">
                        {contactFormQueue.length}{" "}
                        {contactFormQueue.length === 1
                          ? "submission"
                          : "submissions"}
                      </span>
                    </div>
                    <div className="sales-rep-table-wrapper">
                      <table className="min-w-[720px] divide-y divide-slate-200/70">
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
                        <tbody className="divide-y divide-slate-200/60">
                          {referralDataLoading ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-4 py-6 text-center text-sm text-slate-500"
                              >
                                Loading contact forms…
                              </td>
                            </tr>
                          ) : contactFormQueue.length === 0 ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-4 py-6 text-center text-sm text-slate-500"
                              >
                                No contact form submissions available.
                              </td>
                            </tr>
                          ) : (
                            contactFormQueue.map((lead) => {
                              const isUpdating =
                                adminActionState.updatingReferral === lead.id;
                              const normalizedStatus = (
                                lead.status || "contact_form"
                              ).toLowerCase();
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
                                    <div>{lead.referredContactEmail || "—"}</div>
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
                                      onChange={(event) =>
                                        handleUpdateReferralStatus(
                                          lead.id,
                                          event.target.value,
                                        )
                                      }
                                      className="rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                                    >
                                      {CONTACT_FORM_STATUS_FLOW.map((stage) => (
                                        <option key={stage.key} value={stage.key}>
                                          {stage.label}
                                        </option>
                                      ))}
                                    </select>
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
              {historicProspectEntries.length > 0 && (
                <>
                  <hr className="lead-divider" />
                  <section className="lead-panel">
                    <div className="lead-panel-header">
                      <div>
                        <h4>Historic Prospects</h4>
                      <p className="text-sm text-slate-500">
                        Credited referrals are archived here for easy reference.
                      </p>
                    </div>
                    <span className="lead-panel-count">
                      {historicProspectEntries.length}{" "}
                      {historicProspectEntries.length === 1
                        ? "record"
                        : "records"}
                    </span>
                  </div>
                  <div className="lead-list-scroll">
                    <ul className="lead-list">
                      {historicProspectEntries.map(({ record }) => (
                        <li key={record.id} className="lead-list-item">
                          <div className="lead-list-meta">
                            <div className="lead-list-name">
                              {record.referredContactName ||
                                record.referredContactEmail ||
                                "—"}
                            </div>
                            {record.referredContactEmail && (
                              <div className="lead-list-detail">
                                {record.referredContactEmail}
                              </div>
                            )}
                            {record.referredContactPhone && (
                              <div className="lead-list-detail">
                                {record.referredContactPhone}
                              </div>
                            )}
                            <span
                              className={`lead-source-pill ${
                                isManualEntry(record)
                                  ? "lead-source-pill--manual"
                                  : "lead-source-pill--referral"
                              }`}
                            >
                              {isManualEntry(record) ? "Manual" : "Referral"}
                            </span>
                          </div>
                          <div className="lead-list-actions text-right min-w-[220px]">
                            <div className="text-xs font-semibold text-emerald-600 break-words">
                              {`Credited ${record.referrerDoctorName || "User"} ${formatCurrency(
                                record.creditIssuedAmount ?? 50,
                              )}`}
                            </div>
                            <div className="lead-updated text-right">
                              {record.creditIssuedAt
                                ? `Issued ${formatDateTime(record.creditIssuedAt)}`
                                : record.updatedAt
                                  ? `Updated ${formatDateTime(record.updatedAt)}`
                                  : formatDateTime(record.createdAt)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  </section>
                </>
              )}
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
  };

  const handleCloseProductDetail = () => {
    console.debug("[Product] Close details");
    setProductDetailOpen(false);
    setSelectedProduct(null);
  };

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

    if (filters.inStockOnly) {
      filtered = filtered.filter((product) => product.inStock);
    }

    if (filters.types.length > 0) {
      filtered = filtered.filter(
        (product) => product.type && filters.types.includes(product.type),
      );
    }

    return filtered;
  }, [filteredProductCatalog, searchQuery, filters]);

  // Get product counts by category
  const productCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    catalogCategories.forEach((category) => {
      counts[category] = filteredProductCatalog.filter(
        (product) => product.category === category,
      ).length;
    });
    return counts;
  }, [filteredProductCatalog, catalogCategories]);

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
      className="min-h-screen bg-slate-50 flex flex-col"
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
                        className={`glass-card squircle-lg border border-[var(--brand-glass-border-2)] px-8 py-6 lg:px-10 lg:py-8 shadow-lg transition-all duration-500 flex flex-col justify-center flex-1 ${
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
                          <div className="w-full flex flex-col items-center gap-4">
                            <div className="news-loading-card flex flex-col items-center gap-3 w-full max-w-md">
                              <div
                                className="news-loading-line news-loading-shimmer w-3/4"
                                aria-hidden="true"
                              />
                              <div
                                className="news-loading-line news-loading-shimmer w-1/2"
                                aria-hidden="true"
                              />
                            </div>
                            <p className="text-xs text-slate-500">
                              Loading today&apos;s quote…
                            </p>
                          </div>
                        )}
                        {quoteReady && quoteOfTheDay && (
                          <p
                            className="px-4 sm:px-6 italic text-gray-700 text-center leading-snug break-words"
                            style={{
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
                          className="w-full rounded-lg bg-white/65 px-3 pt-0 pb-2 sm:px-4 sm:py-2 text-center shadow-inner transition-opacity duration-500"
                          aria-live="polite"
                        >
                          {!quoteReady && (
                            <div className="flex flex-col items-center gap-2 w-full">
                              <div
                                className="news-loading-line news-loading-shimmer w-3/4"
                                aria-hidden="true"
                              />
                              <div
                                className="news-loading-line news-loading-shimmer w-2/3"
                                aria-hidden="true"
                              />
                            </div>
                          )}
                          {quoteReady && quoteOfTheDay && (
                            <p
                              className="px-4 sm:px-6 italic text-gray-700 leading-snug break-words"
                              style={{
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
                          {isRep(user?.role) && (
                            <span className="text-[11px] text-slate-600 italic">
                              Shop for physicians:{" "}
                              {shopEnabled ? "Enabled" : "Disabled"}
                            </span>
                          )}
                          {isAdmin(user?.role) && (
                            <label className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={shopEnabled}
                                onChange={(e) =>
                                  handleShopToggle(e.target.checked)
                                }
                                className="h-4 w-4 rounded border-slate-300 text-[rgb(95,179,249)] focus:ring-[rgb(95,179,249)]"
                              />
                              <span>Enable Shop button for users</span>
                            </label>
                          )}
                        </div>
                        {/* Regional contact info for doctors */}
                        {!(isRep(user.role) || isAdmin(user.role)) && (
                          <div className="glass-card squircle-md p-4 space-y-2 border border-[var(--brand-glass-border-2)]">
                            <p className="text-sm font-medium text-slate-700">
                              Please contact your Regional Administrator
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
                                    setLandingLoginError(
                                      "Unable to log in. Please try again.",
                                    );
                                  }
                                }
                              } catch (error) {
                                console.warn("[Landing Login] Failed", error);
                                setLandingLoginError(
                                  "Unable to log in. Please try again.",
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
                                  "We couldn't locate that onboarding code. Please confirm it with your regional administrator.",
                                );
                              } else if (
                                res.status === "referral_code_unavailable"
                              ) {
                                setLandingSignupError(
                                  "This onboarding code has already been used. Ask your regional administrator for a new code.",
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
                                  "An account already exists for this NPI number. Please sign in or contact support.",
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
                                  Suffix
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
                                regional administrator.
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
              className="w-full py-12 mobile-safe-area"
              style={{ marginTop: "2.4rem" }}
            >
              {isRep(user.role) || isAdmin(user.role)
                ? renderSalesRepDashboard()
                : renderDoctorDashboard()}
              {renderProductSection()}
            </main>
          )}
        </div>

        <LegalFooter showContactCTA={!user} />
      </div>

      {/* Checkout Modal */}
      {stripeClientPromise ? (
        <Elements stripe={stripeClientPromise}>
          <CheckoutModal
            isOpen={checkoutOpen}
            onClose={() => setCheckoutOpen(false)}
            cartItems={cartItems}
            onCheckout={handleCheckout}
            onClearCart={() => setCartItems([])}
            onPaymentSuccess={() => {
              const requestToken = Date.now();
              setAccountModalRequest({
                tab: "orders",
                open: true,
                token: requestToken,
              });
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
          />
        </Elements>
      ) : (
        <CheckoutModal
          isOpen={checkoutOpen}
          onClose={() => setCheckoutOpen(false)}
          cartItems={cartItems}
          onCheckout={handleCheckout}
          onClearCart={() => setCartItems([])}
          onPaymentSuccess={() => {
            const requestToken = Date.now();
            setAccountModalRequest({
              tab: "orders",
              open: true,
              token: requestToken,
            });
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
        />
      )}

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
                {REFERRAL_STATUS_FLOW.map((stage) => (
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
      <ProductDetailDialog
        product={selectedProduct}
        isOpen={productDetailOpen}
        onClose={handleCloseProductDetail}
        onAddToCart={handleAddToCart}
      />
    </div>
  );
}
