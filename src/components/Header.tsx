import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo, FormEvent, MouseEvent, WheelEvent, TouchEvent, ReactNode, CSSProperties } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from './ui/dialog';
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Search, User, Gift, ShoppingCart, LogOut, Home, Copy, X, Check, Eye, EyeOff, Pencil, Loader2, Info, Package, Box, Users, RefreshCw, WifiOff, Maximize2, Minimize2, Link2, Upload, Trash2 } from 'lucide-react';
import { toast } from '../lib/toast';
import { AuthActionResult } from '../types/auth';
import clsx from 'clsx';
import { proxifyWooMediaUrl } from '../lib/mediaProxy';
import { isTabLeader, releaseTabLeadership } from '../lib/tabLocks';
import { withStaticAssetStamp } from '../lib/assetUrl';
import { formatTimestampedNotesForDisplay } from '../lib/timestampedNotes';
import { parseBackendTimestamp, parseBackendTimestampAsPacificWallTime } from '../lib/timezoneDate';
import {
  buildResearchSupplyLinkUrl,
} from '../lib/researchSupplyLinks';

const normalizeRole = (role?: string | null) => (role || '').toLowerCase();
const isAdmin = (role?: string | null) => normalizeRole(role) === 'admin';
const isSalesLead = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized !== 'admin' && (normalized === 'sales_lead' || normalized === 'saleslead' || normalized === 'sales-lead');
};
const isRep = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized !== 'admin' && (normalized === 'sales_rep' || normalized === 'test_rep' || normalized === 'rep' || normalized === 'sales_lead' || normalized === 'saleslead' || normalized === 'sales-lead');
};
const isDoctorRole = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized === 'doctor' || normalized === 'test_doctor';
};

type PatientLinkPaymentMethod = 'none' | 'zelle';

const patientLinkPaymentMethodOptions: Array<{ value: PatientLinkPaymentMethod; label: string }> = [
  { value: 'none', label: '-' },
  { value: 'zelle', label: 'Zelle' },
];

const buildPatientLinkDefaultInstructions = (
  method: PatientLinkPaymentMethod,
  zelleContact?: string | null,
  doctorName?: string | null,
) => {
  if (method !== 'zelle') return '';
  const contact = typeof zelleContact === 'string' ? zelleContact.trim() : '';
  const doctor = typeof doctorName === 'string' ? doctorName.trim() : '';
  return contact
    ? `Please send payment to ${contact}.`
    : `Reach out to ${doctor || 'your physician'} for Zelle payment details.`;
};

const normalizePatientLinkPaymentMethod = (value: unknown): PatientLinkPaymentMethod => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'zelle') return 'zelle';
  if (raw === 'zelle_ach' || raw === 'zelle/ach' || raw === 'zelle-ach' || raw === 'zelleach') return 'zelle';
  if (raw === 'insurance') return 'none';
  return 'none';
};

const createNodeDummyPatientLink = (zelleContact?: string | null, doctorName?: string | null) => {
  const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() + 71 * 60 * 60 * 1000).toISOString();
  return {
    token: 'node-ui-dummy-link',
    referenceLabel: 'Subject A104',
    patientReference: 'RS-UI-001',
    patientId: 'Subject A104',
    subjectLabel: 'Subject A104',
    studyLabel: 'GH response pilot',
    createdAt,
    expiresAt,
    usageLimit: 5,
    usageCount: 0,
    status: 'active',
    markupPercent: 15,
    paymentMethod: 'zelle',
    paymentInstructions: buildPatientLinkDefaultInstructions('zelle', zelleContact, doctorName),
    receivedPayment: false,
    lastUsedAt: null,
    revokedAt: null,
  };
};

const createNodeDummyPatientLinks = (zelleContact?: string | null, doctorName?: string | null) => {
  const base = createNodeDummyPatientLink(zelleContact, doctorName);
  const proposalCreatedAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  return [
    base,
    {
      ...base,
      token: 'node-ui-dummy-link-2',
      referenceLabel: 'Subject B205',
      patientReference: 'RS-UI-002',
      patientId: 'Subject B205',
      subjectLabel: 'Subject B205',
      studyLabel: 'GH response pilot',
      createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      lastUsedAt: proposalCreatedAt,
      delegateSharedAt: proposalCreatedAt,
      delegateReviewStatus: 'pending',
      receivedPayment: false,
    },
  ];
};

const DEFAULT_DELEGATE_SECONDARY_COLOR = '#5fb3f9';

const normalizeDelegateSecondaryColor = (value?: string | null) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const raw = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw.split('').map((char) => `${char}${char}`).join('').toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return `#${raw.toLowerCase()}`;
  }
  return null;
};

const hexToRgbCss = (hex: string) => {
  const normalized = normalizeDelegateSecondaryColor(hex) || DEFAULT_DELEGATE_SECONDARY_COLOR;
  const raw = normalized.slice(1);
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
};

const hexToRgbaCss = (hex: string, alpha: number) => {
  const normalized = normalizeDelegateSecondaryColor(hex) || DEFAULT_DELEGATE_SECONDARY_COLOR;
  const raw = normalized.slice(1);
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const isNodePatientLinkDummyMode = (() => {
  const env = (import.meta as any)?.env ?? {};
  const configuredApiUrl = String(env?.VITE_API_URL || '').trim();
  const forceDummy = String(env?.VITE_DUMMY_PATIENT_LINK || '').trim();
  if (forceDummy === '1') {
    return true;
  }
  if (forceDummy === '0') {
    return false;
  }
  if (env?.DEV && !configuredApiUrl) {
    return true;
  }
  try {
    const candidate = configuredApiUrl
      || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
    if (!candidate) return false;
    const parsed = new URL(candidate, typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost');
    const host = String(parsed.hostname || '').toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return isLocal;
  } catch {
    return false;
  }
})();

type NetworkQuality = 'good' | 'fair' | 'poor' | 'offline';
type AccountTabId = 'details' | 'orders' | 'research' | 'patient_links';

const NetworkBarsIcon = ({ activeBars }: { activeBars: number }) => {
  const active = Math.max(0, Math.min(activeBars, 3));
  const activeFill = 'rgb(30, 41, 59)'; // slate-800
  const inactiveFill = 'rgb(203, 213, 225)'; // slate-300
  const bars = [
    { x: 2, y: 9, w: 4, h: 4 },
    { x: 8, y: 6, w: 4, h: 7 },
    { x: 14, y: 3, w: 4, h: 10 },
  ];

  return (
    <svg
      width="22"
      height="14"
      viewBox="0 0 20 14"
      fill="none"
      aria-hidden="true"
    >
      {bars.map((bar, index) => {
        const isActive = index < active;
        return (
          <rect
            key={index}
            x={bar.x}
            y={bar.y}
            width={bar.w}
            height={bar.h}
            rx="1"
            fill={isActive ? activeFill : inactiveFill}
          />
        );
      })}
    </svg>
  );
};

const ClipboardDocumentListIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    viewBox="0 0 24 24"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M7.502 6h7.128A3.375 3.375 0 0 1 18 9.375v9.375a3 3 0 0 0 3-3V6.108c0-1.505-1.125-2.811-2.664-2.94a48.972 48.972 0 0 0-.673-.05A3 3 0 0 0 15 1.5h-1.5a3 3 0 0 0-2.663 1.618c-.225.015-.45.032-.673.05C8.662 3.295 7.554 4.542 7.502 6ZM13.5 3A1.5 1.5 0 0 0 12 4.5h4.5A1.5 1.5 0 0 0 15 3h-1.5Z"
      clipRule="evenodd"
    />
    <path
      fillRule="evenodd"
      d="M3 9.375C3 8.339 3.84 7.5 4.875 7.5h9.75c1.036 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-9.75A1.875 1.875 0 0 1 3 20.625V9.375ZM6 12a.75.75 0 0 1 .75-.75h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V12Zm2.25 0a.75.75 0 0 1 .75-.75h3.75a.75.75 0 0 1 0 1.5H9a.75.75 0 0 1-.75-.75ZM6 15a.75.75 0 0 1 .75-.75h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V15Zm2.25 0a.75.75 0 0 1 .75-.75h3.75a.75.75 0 0 1 0 1.5H9a.75.75 0 0 1-.75-.75ZM6 18a.75.75 0 0 1 .75-.75h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V18Zm2.25 0a.75.75 0 0 1 .75-.75h3.75a.75.75 0 0 1 0 1.5H9a.75.75 0 0 1-.75-.75Z"
      clipRule="evenodd"
    />
  </svg>
);

const triggerBrowserDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
};

// Downscale/compress images before uploading to avoid proxy/body limits.
const compressImageToDataUrl = (file: File, opts?: { maxSize?: number; quality?: number }): Promise<string> => {
  const maxSize = opts?.maxSize ?? 1600; // max width/height in px
  const quality = opts?.quality ?? 0.82; // JPEG quality

  const loadImage = () => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });

  return loadImage().then((img) => {
    const { naturalWidth: width, naturalHeight: height, src } = img;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      URL.revokeObjectURL(src);
      throw new Error('Unable to get canvas context');
    }
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    URL.revokeObjectURL(src);
    return dataUrl;
  });
};

interface HeaderUserSalesRep {
  id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

type DirectShippingField =
  | 'officeAddressLine1'
  | 'officeAddressLine2'
  | 'officeCity'
  | 'officeState'
  | 'officePostalCode';

interface HeaderUser {
  id?: string;
  name: string;
  profileImageUrl?: string | null;
  delegateLogoUrl?: string | null;
  delegateSecondaryColor?: string | null;
  zelleContact?: string | null;
  role?: string | null;
  referralCode?: string | null;
  visits?: number;
  hasPasskeys?: boolean;
  email?: string | null;
  phone?: string | null;
  salesRep?: HeaderUserSalesRep | null;
  officeAddressLine1?: string | null;
  officeAddressLine2?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
  officePostalCode?: string | null;
  researchTermsAgreement?: boolean;
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
  estimatedArrivalDate?: string | null;
  packageCode?: string | null;
  packageDimensions?: { length?: number | null; width?: number | null; height?: number | null } | null;
  weightOz?: number | null;
  meta?: Record<string, any> | null;
}

interface AccountOrderSummary {
  id: string;
  asDelegate?: string | null;
  as_delegate?: string | null;
  number?: string | null;
  trackingNumber?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  source: 'local' | 'woocommerce' | 'peppro';
  lineItems?: AccountOrderLineItem[];
  integrations?: Record<string, string | null> | null;
  paymentMethod?: string | null;
  paymentDetails?: string | null;
  shippingAddress?: AccountOrderAddress | null;
  billingAddress?: AccountOrderAddress | null;
  shippingEstimate?: AccountShippingEstimate | null;
  shippingTotal?: number | null;
  taxTotal?: number | null;
  physicianCertified?: boolean | null;
  expectedShipmentWindow?: string | null;
}

interface HeaderProps {
  user: HeaderUser | null;
  delegateMode?: boolean;
  delegateLogoUrl?: string | null;
  delegateSecondaryColor?: string | null;
  delegateDoctorName?: string | null;
  researchDashboardEnabled?: boolean;
  patientLinksEnabled?: boolean;
  patientLinksDoctorUserIds?: string[];
  onLogin?: (email: string, password: string) => Promise<AuthActionResult> | AuthActionResult;
  onLogout?: () => void;
  cartItems: number;
  onSearch: (query: string, options?: { submitted?: boolean }) => void;
  onCreateAccount?: (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    code: string;
  }) => Promise<AuthActionResult> | AuthActionResult;
  onCartClick?: (source?: 'cart_button') => void;
  loginPromptToken?: number;
  loginContext?: 'checkout' | null;
  onShowInfo?: () => void;
  onUserUpdated?: (user: HeaderUser) => void;
  accountOrders?: AccountOrderSummary[];
  accountOrdersLoading?: boolean;
  accountOrdersError?: string | null;
  ordersLastSyncedAt?: string | null;
  onRefreshOrders?: (options?: { force?: boolean }) => Promise<unknown> | void;
  accountModalRequest?: { tab: 'details' | 'orders'; open?: boolean; token: number; order?: AccountOrderSummary } | null;
  onAccountModalRequestHandled?: (token: number) => void;
  suppressAccountHomeButton?: boolean;
  showCanceledOrders?: boolean;
  onToggleShowCanceled?: () => void;
  onBuyOrderAgain?: (order: AccountOrderSummary) => void;
  onCancelOrder?: (orderId: string) => Promise<unknown>;
  referralCodes?: string[] | null;
  catalogLoading?: boolean;
  onLoadDelegateProposal?: (payload: {
    token: string;
    items: any[];
    markupPercent?: number | null;
    delegateOrderId?: string | null;
    sharedAt?: string | null;
    shippingAddress?: any | null;
    shippingRate?: any | null;
  }) => void;
  patientLinksRefreshToken?: number;
  onAccountIndicatorTotalChange?: (count: number) => void;
}

const formatOrderDate = (value?: string | null) => {
  if (!value) return 'Pending';
  const date = parseBackendTimestamp(value);
  if (!date) {
    return value;
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
};

const resolveOrderPlacedAt = (order?: AccountOrderSummary | null): string | null => {
  if (!order || typeof order !== 'object') return null;
  const sourceToken = String((order as any)?.source || '').trim().toLowerCase();
  const isMysqlSource =
    sourceToken === 'mysql'
    || sourceToken === 'peppro'
    || sourceToken === 'local'
    || Boolean((order as any)?.created_at);
  if (!isMysqlSource) return null;

  const parseObject = (value: unknown): Record<string, any> | null => {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, any>)
        : null;
    } catch {
      return null;
    }
  };

  const payload = parseObject((order as any).payload);
  const payloadOrder = parseObject(payload?.order) || payload;
  const rawCandidate =
    (typeof (order as any)?.created_at === 'string' && (order as any).created_at.trim())
    || (typeof payloadOrder?.created_at === 'string' && payloadOrder.created_at.trim())
    || (typeof (order as any)?.createdAt === 'string' && (order as any).createdAt.trim())
    || null;
  if (!rawCandidate) return null;

  const parsed = parseBackendTimestampAsPacificWallTime(rawCandidate, {
    ignoreExplicitTimezone: true,
  });
  return parsed ? parsed.toISOString() : null;
};

const formatLinkDateTime = (value?: string | null) => {
  if (!value) return null;
  const date = parseBackendTimestamp(value);
  if (!date) {
    return value;
  }
  const datePart = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart} @ ${timePart}`;
};

const formatCurrency = (amount?: number | null, currency = 'USD') => {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return '—';
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
};

const parseWooMoney = (value: any, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
};

const titleCase = (value?: string | null) => {
  if (!value) return null;
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return null;
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
};

const getInitials = (value?: string | null) => {
  if (!value) return 'PP';
  const honorifics = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'prof.', 'sir', 'madam']);
  const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  const tokens = value
    .split(/\s+/)
    .map((token) => token.replace(/[.,]/g, '').trim())
    .filter(Boolean);
  const filtered = tokens.filter((token, idx) => {
    const lower = token.toLowerCase();
    if (honorifics.has(lower)) return false;
    if (idx === tokens.length - 1 && suffixes.has(lower)) return false;
    return true;
  });
  if (filtered.length === 0) return 'PP';
  const first = filtered[0]?.[0] || '';
  const last = filtered.length > 1 ? filtered[filtered.length - 1]?.[0] || '' : '';
  return (first + last).toUpperCase() || 'PP';
};

const parseMaybeJson = (value: any) => {
  if (typeof value === 'string') {
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
  const code = (carrier || '').toLowerCase();
  const encoded = encodeURIComponent(tracking);
  if (code.includes('ups')) return `https://www.ups.com/track?loc=en_US&tracknum=${encoded}`;
  if (code.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  if (code.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (code.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
};

const resolveTrackingNumber = (order: any): string | null => {
  if (!order) return null;

  const orderLabel =
    order?.number ||
    order?.id ||
    order?.wooOrderNumber ||
    order?.orderNumber ||
    'unknown';

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
    console.info('[Tracking] Resolved tracking number', { order: orderLabel, tracking });
    return tracking;
  }

  return null;
};

const SHIPPED_STATUS_KEYWORDS = [
  'processing',
  'completed',
  'complete',
  'shipped',
  'in-transit',
  'in_transit',
  'out-for-delivery',
  'out_for_delivery',
  'delivered',
  'fulfilled',
];

const isShipmentInTransit = (status?: string | null) => {
  if (!status) {
    return false;
  }
  const normalized = status.toLowerCase();
  return SHIPPED_STATUS_KEYWORDS.some((token) => normalized.includes(token));
};

const formatExpectedDelivery = (order: AccountOrderSummary) => {
  const estimate = order.shippingEstimate;
  if (!estimate) {
    return null;
  }
  if (estimate.estimatedArrivalDate) {
    const arrival = new Date(estimate.estimatedArrivalDate);
    if (!Number.isNaN(arrival.getTime())) {
      return arrival.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  if (estimate.deliveryDateGuaranteed) {
    const date = new Date(estimate.deliveryDateGuaranteed);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  if (estimate.estimatedDeliveryDays && Number.isFinite(estimate.estimatedDeliveryDays)) {
    const baseDateRaw = resolveOrderPlacedAt(order) || order.createdAt || null;
    const baseDate = baseDateRaw ? new Date(baseDateRaw) : new Date();
    if (!Number.isNaN(baseDate.getTime())) {
      const projected = new Date(baseDate.getTime());
      projected.setDate(projected.getDate() + Number(estimate.estimatedDeliveryDays));
      return projected.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  return null;
};

const formatShippingMethod = (estimate?: AccountShippingEstimate | null) => {
  if (!estimate) {
    return null;
  }
  return titleCase(estimate.serviceType || estimate.serviceCode) || null;
};

const CANCELLABLE_ORDER_STATUSES = new Set(['pending', 'on-hold', 'on_hold']);

const parseAddress = (address: any): AccountOrderAddress | null => {
  if (!address) return null;
  if (typeof address === 'string') {
    try {
      return JSON.parse(address);
    } catch {
      return null;
    }
  }
  if (typeof address === 'object') {
    return address as AccountOrderAddress;
  }
  return null;
};

const convertWooAddress = (addr: any): AccountOrderAddress | null => {
  if (!addr) return null;
  const first = addr.first_name || '';
  const last = addr.last_name || '';
  const name = [first, last].filter(Boolean).join(' ').trim() || addr.name || null;
  return {
    name,
    company: addr.company || null,
    addressLine1: addr.address_1 || addr.addressLine1 || null,
    addressLine2: addr.address_2 || addr.addressLine2 || null,
    city: addr.city || null,
    state: addr.state || null,
    postalCode: addr.postcode || addr.postal_code || addr.postalCode || null,
    country: addr.country || null,
    phone: addr.phone || null,
    email: addr.email || null,
  };
};

const renderAddressLines = (address?: AccountOrderAddress | null) => {
  if (!address) {
    return <p className="text-sm text-slate-500">No address available.</p>;
  }
  const lineItems: Array<{ key: string; node: ReactNode }> = [];

  const pushLine = (value: string | null) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    lineItems.push({ key: trimmed, node: trimmed });
  };

  pushLine(address.name || null);
  pushLine(address.company || null);
  pushLine(
    [address.addressLine1, address.addressLine2]
      .filter(Boolean)
      .join(' ')
      .trim() || null,
  );
  pushLine(
    [address.city, address.state, address.postalCode]
      .filter(Boolean)
      .join(', ')
      .replace(/, ,/g, ', ')
      .replace(/^,/, '')
      .trim() || null,
  );
  pushLine(address.country || null);
  pushLine(address.phone ? `Phone: ${address.phone}` : null);

  const email = typeof address.email === 'string' ? address.email.trim() : '';
  if (email) {
    lineItems.push({
      key: `email-${email}`,
      node: (
        <>
          Email: <a href={`mailto:${email}`}>{email}</a>
        </>
      ),
    });
  }

  if (!lineItems.length) {
    return <p className="text-sm text-slate-500">No address available.</p>;
  }

  return (
    <div className="text-sm text-slate-700 space-y-1 text-left">
      {lineItems.map((line, index) => (
        <p key={`${line.key}-${index}`}>{line.node}</p>
      ))}
    </div>
  );
};

const stripWooSizeSuffix = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const [base, query = ''] = trimmed.split('?');
  const match = base.match(/^(.*)-(\d{2,4})x(\d{2,4})(\.[a-zA-Z0-9]+)$/);
  if (!match) {
    return trimmed;
  }
  const stripped = `${match[1]}${match[4]}`;
  return query ? `${stripped}?${query}` : stripped;
};

const normalizeImageSource = (value: any): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return proxifyWooMediaUrl(stripWooSizeSuffix(value));
  }
  if (value && typeof value === 'object') {
    const source = value.src || value.url || value.href || value.source;
    if (typeof source === 'string' && source.trim().length > 0) {
      return proxifyWooMediaUrl(stripWooSizeSuffix(source));
    }
  }
  return null;
};

const normalizeIdValue = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const matchWooLineItemForImage = (
  line: AccountOrderLineItem,
  wooLineItems: any[] = [],
) => {
  if (!Array.isArray(wooLineItems) || wooLineItems.length === 0) {
    return null;
  }
  const lineSku = line.sku?.trim();
  const lineName = line.name?.trim().toLowerCase();
  const lineProductId =
    normalizeIdValue(line.productId) ||
    normalizeIdValue((line as any)?.product_id);
  const lineVariantId =
    normalizeIdValue(line.variantId) ||
    normalizeIdValue((line as any)?.variation_id);

  return wooLineItems.find((candidate) => {
    if (!candidate) {
      return false;
    }
    const candidateSku =
      typeof candidate.sku === 'string' ? candidate.sku.trim() : null;
    if (lineSku && candidateSku && lineSku === candidateSku) {
      return true;
    }

    const candidateProductId = normalizeIdValue(candidate.product_id);
    if (
      lineProductId &&
      candidateProductId &&
      lineProductId === candidateProductId
    ) {
      return true;
    }

    const candidateVariationId = normalizeIdValue(candidate.variation_id);
    if (
      lineVariantId &&
      candidateVariationId &&
      lineVariantId === candidateVariationId
    ) {
      return true;
    }

    const candidateName =
      typeof candidate.name === 'string'
        ? candidate.name.trim().toLowerCase()
        : null;
    if (lineName && candidateName && lineName === candidateName) {
      return true;
    }
    return false;
  });
};

const resolveOrderLineImage = (
  line: AccountOrderLineItem,
  wooLineItems: any[] = [],
): string | null => {
  const inlineImage =
    normalizeImageSource((line as any)?.image) ||
    normalizeImageSource((line as any)?.imageUrl) ||
    normalizeImageSource((line as any)?.thumbnail);
  if (inlineImage) {
    return inlineImage;
  }
  const match = matchWooLineItemForImage(line, wooLineItems);
  if (!match) {
    return null;
  }
  const fromMatch =
    normalizeImageSource(match?.image) ||
    normalizeImageSource(match?.product_image) ||
    normalizeImageSource(match?.image_url);
  if (fromMatch) {
    return fromMatch;
  }
  const metaData = Array.isArray(match?.meta_data) ? match.meta_data : [];
  for (const entry of metaData) {
    const candidate = normalizeImageSource(entry?.value);
    if (candidate) {
      return candidate;
    }
    if (
      typeof entry?.value === 'string' &&
      entry.value.trim().length > 0
    ) {
      return entry.value.trim();
    }
  }
  return null;
};

const humanizeOrderStatus = (status?: string | null) => {
  if (!status) return 'Pending';
  const normalized = status.trim().toLowerCase();
  if (normalized === 'trash') return 'Canceled';
  return status
    .split(/[_\s]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
};

const normalizeStringField = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const isTerminalOrderStatus = (status?: string | null) => {
  const normalized = String(status || '').trim().toLowerCase();
  return (
    normalized === 'refunded' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'trash'
  );
};

const resolveOrderStatusSource = (order: AccountOrderSummary | null | undefined): string | null => {
  if (!order) return null;
  const orderStatusRaw = order.status ? String(order.status) : '';
  const orderStatus = orderStatusRaw.trim();
  const orderStatusNormalized = orderStatus.toLowerCase();

  const carrierTracking =
    (order.integrationDetails as any)?.carrierTracking ||
    (order.integrationDetails as any)?.carrier_tracking ||
    null;
  const carrierTrackingStatusRaw =
    carrierTracking?.trackingStatusRaw ||
    carrierTracking?.trackingStatus ||
    carrierTracking?.tracking_status ||
    carrierTracking?.status ||
    carrierTracking?.deliveryStatus ||
    carrierTracking?.delivery_status ||
    null;
  const carrierTrackingStr = carrierTrackingStatusRaw ? String(carrierTrackingStatusRaw).trim() : '';
  const carrierTrackingNormalized = carrierTrackingStr.toLowerCase();
  const carrierTrackingMeaningful =
    carrierTrackingNormalized.includes('in_transit') ||
    carrierTrackingNormalized.includes('in-transit') ||
    carrierTrackingNormalized.includes('out_for_delivery') ||
    carrierTrackingNormalized.includes('out-for-delivery') ||
    carrierTrackingNormalized.includes('delivered');
  if (carrierTrackingStr && carrierTrackingMeaningful) {
    return carrierTrackingStr;
  }

  // Always prefer the authoritative order status for terminal or explicit states.
  // Shipping provider statuses are best used to improve display only when the order
  // isn't already in a definitive state (e.g., Completed).
  if (
    isTerminalOrderStatus(orderStatus) ||
    orderStatusNormalized === 'completed' ||
    orderStatusNormalized === 'complete' ||
    orderStatusNormalized === 'processing' ||
    orderStatusNormalized === 'pending' ||
    orderStatusNormalized === 'on-hold' ||
    orderStatusNormalized === 'on_hold' ||
    orderStatusNormalized === 'failed'
  ) {
    return orderStatus.length > 0 ? orderStatus : null;
  }

  const shippingStatus =
    (order.shippingEstimate as any)?.status ||
    carrierTrackingStatusRaw ||
    (order.integrationDetails as any)?.shipStation?.status;

  // Only override when the shipping provider has a meaningful "in-flight" status.
  const shippingStr = shippingStatus ? String(shippingStatus).trim() : '';
  const shippingNormalized = shippingStr.toLowerCase();
  const shippingLooksMeaningful =
    shippingNormalized.includes('in_transit') ||
    shippingNormalized.includes('in-transit') ||
    shippingNormalized.includes('out_for_delivery') ||
    shippingNormalized.includes('out-for-delivery') ||
    shippingNormalized.includes('delivered') ||
    shippingNormalized.includes('awaiting_shipment') ||
    shippingNormalized.includes('awaiting shipment') ||
    shippingNormalized.includes('shipped');

  if (shippingStr && shippingLooksMeaningful) {
    return shippingStr;
  }

  return orderStatus.length > 0 ? orderStatus : null;
};

const describeOrderStatus = (order: AccountOrderSummary | null | undefined): string => {
  const raw = resolveOrderStatusSource(order);
  const statusRaw = raw ? String(raw) : '';
  const normalized = statusRaw.trim().toLowerCase();
  if (normalized === 'trash' || normalized === 'canceled' || normalized === 'cancelled') {
    return 'Canceled';
  }
  if (normalized === 'refunded') {
    return 'Refunded';
  }

  const tracking = typeof order?.trackingNumber === 'string' ? order.trackingNumber.trim() : '';
  const eta = (order?.shippingEstimate as any)?.estimatedArrivalDate || null;
  const hasEta = typeof eta === 'string' && eta.trim().length > 0;

  if (normalized === 'shipped') {
    if (tracking && !hasEta) return 'Processing';
    return tracking ? 'Shipped' : 'Shipped';
  }
  if (normalized.includes('out_for_delivery') || normalized.includes('out-for-delivery')) {
    return 'Out for Delivery';
  }
  if (normalized.includes('in_transit') || normalized.includes('in-transit')) {
    return 'In Transit';
  }
  if (normalized.includes('delivered')) {
    return 'Delivered';
  }

  if (tracking && !hasEta) {
    return 'Processing';
  }
  if (tracking && hasEta) {
    return 'Shipped';
  }
  if (normalized === 'processing') {
    return 'Processing';
  }
  if (normalized === 'completed' || normalized === 'complete') {
    return 'Completed';
  }
  if (normalized === 'awaiting_shipment' || normalized === 'awaiting shipment') {
    return 'Order Received';
  }

  if (!raw) return 'Pending';
  return humanizeOrderStatus(raw);
};

const formatRelativeMinutes = (value?: string | null) => {
  if (!value) return 'Updated a few moments ago';
  const date = new Date(value);
  const now = Date.now();
  const target = date.getTime();
  if (Number.isNaN(target)) return `Updated ${value}`;
  const diffMs = Math.max(0, now - target);
  if (diffMs < 90_000) return 'Updated a few moments ago';
  const totalSeconds = Math.floor(diffMs / 1000);
  const units = [
    { label: 'y', seconds: 365 * 24 * 60 * 60 },
    { label: 'mo', seconds: 30 * 24 * 60 * 60 },
    { label: 'd', seconds: 24 * 60 * 60 },
    { label: 'h', seconds: 60 * 60 },
    { label: 'm', seconds: 60 },
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
  if (!parts.length) return 'Updated a few moments ago';
  return `Updated ${parts.join(' ')} ago`;
};

export function Header({
  user,
  delegateMode = false,
  delegateLogoUrl = null,
  delegateSecondaryColor = null,
  delegateDoctorName = null,
  researchDashboardEnabled = false,
  patientLinksEnabled = false,
  patientLinksDoctorUserIds = [],
  onLogin,
  onLogout,
  cartItems,
  onSearch,
  onCreateAccount,
  onCartClick,
  loginPromptToken,
  loginContext = null,
  onShowInfo,
  onUserUpdated,
  accountOrders = [],
  accountOrdersLoading = false,
  accountOrdersError = null,
  ordersLastSyncedAt,
  onRefreshOrders,
  accountModalRequest = null,
  onAccountModalRequestHandled,
  suppressAccountHomeButton = false,
  showCanceledOrders = false,
  onToggleShowCanceled,
	  onBuyOrderAgain,
	  onCancelOrder,
	  referralCodes = [],
	  catalogLoading = false,
  onLoadDelegateProposal,
  patientLinksRefreshToken = 0,
  onAccountIndicatorTotalChange,
	}: HeaderProps) {
  const delegateSessionSecondaryHex =
    normalizeDelegateSecondaryColor(delegateSecondaryColor) || DEFAULT_DELEGATE_SECONDARY_COLOR;
  const secondaryColor = delegateMode ? hexToRgbCss(delegateSessionSecondaryHex) : 'rgb(95, 179, 249)';
  const translucentSecondary = delegateMode ? hexToRgbaCss(delegateSessionSecondaryHex, 0.18) : 'rgba(95, 179, 249, 0.18)';
  const elevatedShadow = delegateMode
    ? `0 32px 60px -28px ${hexToRgbaCss(delegateSessionSecondaryHex, 0.55)}`
    : '0 32px 60px -28px rgba(95, 179, 249, 0.55)';
  const logoHaloBackground = delegateMode ? hexToRgbaCss(delegateSessionSecondaryHex, 0.08) : 'rgba(95, 179, 249, 0.08)';
  const [loginOpen, setLoginOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [ordersSearchQuery, setOrdersSearchQuery] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [signupName, setSignupName] = useState('');
  const [signupSuffix, setSignupSuffix] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const lastLoginPromptToken = useRef<number | null>(null);
  const [loginError, setLoginError] = useState('');
  const [signupError, setSignupError] = useState('');
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [legalModalOpen, setLegalModalOpen] = useState(false);
  const [deleteAccountModalOpen, setDeleteAccountModalOpen] = useState(false);
  const [deleteAccountHoldCount, setDeleteAccountHoldCount] = useState(0);
  const [deleteAccountDeleting, setDeleteAccountDeleting] = useState(false);
  const [accountTab, setAccountTab] = useState<AccountTabId>('details');
  const [patientLinksLoading, setPatientLinksLoading] = useState(false);
  const [patientLinksError, setPatientLinksError] = useState<string | null>(null);
  const [patientLinks, setPatientLinks] = useState<any[]>([]);
  const [pendingPatientLinkScrollTarget, setPendingPatientLinkScrollTarget] = useState<{
    delegateTokens: string[];
    orderIds: string[];
    referenceLabels: string[];
  } | null>(null);
  const patientLinksPrefetchedRef = useRef(false);
  const patientLinksLoadInFlightRef = useRef(false);
  const patientLinkRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const patientLinkHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [patientLinkMarkupDraft, setPatientLinkMarkupDraft] = useState('0');
  const [patientLinkSubjectLabelDraft, setPatientLinkSubjectLabelDraft] = useState('');
  const [patientLinkStudyLabelDraft, setPatientLinkStudyLabelDraft] = useState('');
  const [patientLinkReferenceDraft, setPatientLinkReferenceDraft] = useState('');
  const [patientLinkExpiryHoursDraft, setPatientLinkExpiryHoursDraft] = useState('72');
  const [patientLinkUsageLimitDraft, setPatientLinkUsageLimitDraft] = useState('');
  const [patientLinkResearchNoteDraft, setPatientLinkResearchNoteDraft] = useState('');
  const [patientLinkTermsAccepted, setPatientLinkTermsAccepted] = useState(false);
  const [patientLinkPaymentMethodDraft, setPatientLinkPaymentMethodDraft] = useState<PatientLinkPaymentMethod>('zelle');
  const [patientLinkInstructionsDraft, setPatientLinkInstructionsDraft] = useState<string>('');
  const [patientLinksCreating, setPatientLinksCreating] = useState(false);
  const [patientLinksUpdatingToken, setPatientLinksUpdatingToken] = useState<string | null>(null);
  const [patientLinksDeletingToken, setPatientLinksDeletingToken] = useState<string | null>(null);
  const [patientLinksSavingPaymentToken, setPatientLinksSavingPaymentToken] = useState<string | null>(null);
  const [patientLinksPaymentReceivedToken, setPatientLinksPaymentReceivedToken] = useState<string | null>(null);
  const [patientLinksSavingReviewNotesToken, setPatientLinksSavingReviewNotesToken] = useState<string | null>(null);
  const patientLinkTrackedFieldsRef = useRef<Set<string>>(new Set());
  const [patientLinkPaymentMethodDraftByToken, setPatientLinkPaymentMethodDraftByToken] = useState<Record<string, PatientLinkPaymentMethod>>({});
  const [patientLinkInstructionsDraftByToken, setPatientLinkInstructionsDraftByToken] = useState<Record<string, string>>({});
  const [patientLinkReviewNotesDraftByToken, setPatientLinkReviewNotesDraftByToken] = useState<Record<string, string>>({});
  const [researchDashboardExpanded, setResearchDashboardExpanded] = useState(false);
  const [researchOverlayExpanded, setResearchOverlayExpanded] = useState(false);
  const [researchOverlayRect, setResearchOverlayRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const referralCopyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLargeScreen, setIsLargeScreen] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirmPassword, setShowSignupConfirmPassword] = useState(false);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [logoutThanksOpen, setLogoutThanksOpen] = useState(false);
  const [logoutThanksOpacity, setLogoutThanksOpacity] = useState(0);
  const [logoutThanksTransitionMs, setLogoutThanksTransitionMs] = useState(250);
  const logoutThanksSequenceRef = useRef(0);
  const logoutThanksTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const logoutThanksRafRef = useRef<number | null>(null);
  const logoutThanksLogoutTriggeredRef = useRef(false);
  const logoutThanksPendingFadeOutRef = useRef(false);
  const logoutThanksLogoutPromiseRef = useRef<Promise<void> | null>(null);
  const deleteAccountHoldTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const deleteAccountHoldTriggeredRef = useRef(false);
  const [trackingForm, setTrackingForm] = useState({ orderId: '', email: '' });
  const [trackingPending, setTrackingPending] = useState(false);
  const [trackingMessage, setTrackingMessage] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>('fair');
  const [networkSpeedSummary, setNetworkSpeedSummary] = useState<{
    downloadMbps: number | null;
    uploadMbps: number | null;
    latencyMs: number | null;
    measuredAt: number | null;
  }>({ downloadMbps: null, uploadMbps: null, latencyMs: null, measuredAt: null });
  const [localUser, setLocalUser] = useState<HeaderUser | null>(user);
  const lastZelleContactRef = useRef<string | null>(null);
  const [zelleContactDraft, setZelleContactDraft] = useState('');
  const loginFormRef = useRef<HTMLFormElement | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<AccountOrderSummary | null>(null);
  const trackingStatusCacheRef = useRef<Map<string, any>>(new Map());
  const [cachedAccountOrders, setCachedAccountOrders] = useState<AccountOrderSummary[]>(Array.isArray(accountOrders) ? accountOrders : []);
  const cachedAccountOrdersRef = useRef<AccountOrderSummary[]>(Array.isArray(accountOrders) ? accountOrders : []);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [orderLineImageCache, setOrderLineImageCache] = useState<Record<string, string | null>>({});
  const orderLineImageCacheRef = useRef<Record<string, string | null>>({});
  const orderLineImageInflightRef = useRef<Set<string>>(new Set());
  const orderLineImagePrefetchRef = useRef<{
    active: number;
    queue: Array<() => void>;
  }>({ active: 0, queue: [] });
  const researchPanelRef = useRef<HTMLDivElement | null>(null);
  const accountModalShellRef = useRef<HTMLDivElement | null>(null);
  const accountModalScrollRef = useRef<HTMLDivElement | null>(null);
  const accountTabScrollTopRef = useRef<Partial<Record<AccountTabId, number>>>({});
  const restoreAccountTabScrollRef = useRef<Partial<Record<AccountTabId, boolean>>>({});
  const researchOverlayTimeoutRef = useRef<number | null>(null);
  const isResearchFullscreen = accountTab === 'research' && researchDashboardExpanded;
  const modalFullscreenHeight =
    "calc(var(--viewport-height, 100dvh) - var(--modal-header-offset, 6rem) - clamp(1.5rem, 6vh, 3rem))";

  const clearResearchOverlayTimeout = useCallback(() => {
    if (researchOverlayTimeoutRef.current !== null) {
      clearTimeout(researchOverlayTimeoutRef.current);
      researchOverlayTimeoutRef.current = null;
    }
  }, []);

  const collapseResearchOverlay = useCallback(
    (immediate = false) => {
      clearResearchOverlayTimeout();
      setResearchOverlayExpanded(false);
      if (immediate) {
        setResearchDashboardExpanded(false);
        setResearchOverlayRect(null);
        return;
      }
      researchOverlayTimeoutRef.current = window.setTimeout(() => {
        setResearchDashboardExpanded(false);
        setResearchOverlayRect(null);
        researchOverlayTimeoutRef.current = null;
      }, 320);
    },
    [clearResearchOverlayTimeout],
  );

  const expandResearchOverlay = useCallback(() => {
    clearResearchOverlayTimeout();
    const panel = researchPanelRef.current;
    const shell = accountModalShellRef.current;
    if (panel && shell) {
      const panelRect = panel.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      setResearchOverlayRect({
        top: panelRect.top - shellRect.top,
        left: panelRect.left - shellRect.left,
        width: panelRect.width,
        height: panelRect.height,
      });
    } else {
      setResearchOverlayRect(null);
    }
    setResearchOverlayExpanded(false);
    setResearchDashboardExpanded(true);
    requestAnimationFrame(() => setResearchOverlayExpanded(true));
  }, [clearResearchOverlayTimeout]);

  const toggleResearchOverlay = useCallback(() => {
    if (researchDashboardExpanded) {
      collapseResearchOverlay();
      return;
    }
    expandResearchOverlay();
  }, [collapseResearchOverlay, expandResearchOverlay, researchDashboardExpanded]);

  useEffect(() => {
    if (accountTab !== 'research') {
      collapseResearchOverlay(true);
    }
  }, [accountTab, collapseResearchOverlay]);

  useEffect(() => {
    if (!welcomeOpen) {
      collapseResearchOverlay(true);
      setDeleteAccountModalOpen(false);
    }
  }, [welcomeOpen, collapseResearchOverlay]);

  useEffect(() => () => clearResearchOverlayTimeout(), [clearResearchOverlayTimeout]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const className = "account-modal-open";
    document.body.classList.toggle(className, welcomeOpen);
    return () => {
      document.body.classList.remove(className);
    };
  }, [welcomeOpen]);
  const loginEmailRef = useRef<HTMLInputElement | null>(null);
  const loginPasswordRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchQueryRef = useRef('');
  const pendingLoginPrefill = useRef<{ email?: string; password?: string }>({});
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUploadPercent, setAvatarUploadPercent] = useState(0);
  const [showAvatarControls, setShowAvatarControls] = useState(false);
  const accountModalRequestTokenRef = useRef<number | null>(null);

  useEffect(() => {
    const rank: Record<NetworkQuality, number> = {
      offline: 0,
      poor: 1,
      fair: 2,
      good: 3,
    };

	    let mounted = true;
	    const connQualityRef = { current: null as NetworkQuality | null };
	    const apiQualityRef = { current: null as NetworkQuality | null };
	    const apiLastOkAtRef = { current: 0 };
	    const apiConsecutiveFailuresRef = { current: 0 };
	    const pingQualityRef = { current: null as NetworkQuality | null };
	    const throughputQualityRef = { current: null as NetworkQuality | null };
	    const combinedQualityRef = { current: 'fair' as NetworkQuality };
	    const lastThroughputRef = { current: 0 };
	    const consecutiveUnreachableRef = { current: 0 };
	    const consecutiveTimeoutRef = { current: 0 };
	    const lastOkAtRef = { current: 0 };
	    const lastLatencyMsRef = { current: null as number | null };
	    let pingTimer: ReturnType<typeof window.setInterval> | null = null;
	    let throughputTimer: ReturnType<typeof window.setInterval> | null = null;
	    let visibilityTimer: ReturnType<typeof window.setTimeout> | null = null;
	    let pingAbort: AbortController | null = null;
	    let throughputAbort: AbortController | null = null;
	    let pingRequestId = 0;
	    let throughputRequestId = 0;

	    const getErrorText = (error: unknown) => {
	      if (!error) return '';
	      const message = (error as any)?.message;
	      if (typeof message === 'string') return message;
	      try {
	        return String(error);
	      } catch {
	        return '';
	      }
	    };

	    const isLikelyOfflineError = (error: unknown) => {
	      const text = getErrorText(error).toLowerCase();
	      if (!text) return false;
	      return (
	        text.includes('appears to be offline') ||
	        text.includes('internet connection') ||
	        text.includes('not connected to the internet') ||
	        text.includes('network request failed') ||
	        text.includes('fetch api cannot load') ||
	        text.includes('failed to fetch') ||
	        text.includes('load failed') ||
	        text.includes('access-control-allow-origin') ||
	        text.includes('origin https://') ||
	        text.includes('offline')
	      );
	    };

	    const markReachable = () => {
	      lastOkAtRef.current = Date.now();
	      consecutiveTimeoutRef.current = 0;
	      consecutiveUnreachableRef.current = 0;
	    };

	    const shouldTimeoutsCountAsOffline = () => {
	      if (consecutiveTimeoutRef.current < 2) return false;
	      if (!lastOkAtRef.current) return true;
	      return Date.now() - lastOkAtRef.current > 9_000;
	    };

	    const computeConservative = (values: Array<NetworkQuality | null>) => {
	      let best: NetworkQuality | null = null;
	      for (const value of values) {
	        if (!value) continue;
        if (!best || rank[value] < rank[best]) {
          best = value;
        }
      }
      return best ?? 'fair';
    };

	    const updateCombined = () => {
	      const next = (() => {
	        if (connQualityRef.current === 'offline') return 'offline';
	        if (apiQualityRef.current === 'offline') return 'offline';
	        const hasThroughput = Boolean(throughputQualityRef.current);
	        return computeConservative(
	          hasThroughput
	            ? [
	                connQualityRef.current,
	                apiQualityRef.current,
	                pingQualityRef.current,
	                throughputQualityRef.current,
	              ]
	            : [
	                connQualityRef.current,
	                apiQualityRef.current,
	                pingQualityRef.current,
	              ],
	        );
	      })();
	      combinedQualityRef.current = next;
	      if (mounted) setNetworkQuality(next);
	    };

	    const updateApiQuality = (next: { ok: boolean; status?: number | null; message?: string | null; at?: number | null }) => {
	      const now = typeof next.at === 'number' ? next.at : Date.now();
	      if (next.ok) {
	        apiLastOkAtRef.current = now;
	        apiConsecutiveFailuresRef.current = 0;
	        apiQualityRef.current = null;
	        updateCombined();
	        return;
	      }

	      apiConsecutiveFailuresRef.current += 1;
	      const status = typeof next.status === 'number' ? next.status : null;
	      const message = typeof next.message === 'string' ? next.message.toLowerCase() : '';
	      const looksLikeBackendDown =
	        status === 429 ||
	        status === 500 ||
	        status === 502 ||
	        status === 503 ||
	        status === 504 ||
	        message.includes('fetch api cannot load') ||
	        message.includes('failed to fetch') ||
	        message.includes('load failed') ||
	        message.includes('access-control-allow-origin') ||
	        message.includes('origin https://');
	      if (!looksLikeBackendDown) {
	        return;
	      }

	      const recentOk = apiLastOkAtRef.current > 0 && now - apiLastOkAtRef.current < 9_000;
	      apiQualityRef.current =
	        apiConsecutiveFailuresRef.current >= 2 && !recentOk ? 'offline' : 'poor';
	      updateCombined();
	    };

    const deriveFromConnection = (): NetworkQuality | null => {
      if (typeof navigator === 'undefined') return null;
      if (navigator.onLine === false) return 'offline';

      const conn =
        (navigator as any).connection ||
        (navigator as any).mozConnection ||
        (navigator as any).webkitConnection;
      if (!conn) return null;

      const effectiveType = String(conn.effectiveType || '').toLowerCase();
      const downlink = typeof conn.downlink === 'number' ? conn.downlink : null;
      const rtt = typeof conn.rtt === 'number' ? conn.rtt : null;
      const saveData = Boolean(conn.saveData);

      if (saveData) return 'poor';

      if (effectiveType === 'slow-2g' || effectiveType === '2g') return 'poor';
      if (effectiveType === '3g') return 'fair';
      if (effectiveType === '4g') return 'good';

      if (typeof downlink === 'number' && downlink > 0) {
        if (downlink < 1) return 'poor';
        if (downlink < 2) return 'fair';
        if (downlink >= 8) return 'good';
      }

      if (typeof rtt === 'number') {
        if (rtt > 900) return 'poor';
        if (rtt > 450) return 'fair';
        if (rtt <= 200) return 'good';
      }

      return 'fair';
    };

	    const measureHealthPing = async (): Promise<NetworkQuality | null> => {
	      if (typeof navigator === 'undefined') return null;
	      if (navigator.onLine === false) return 'offline';

	      const requestId = (pingRequestId += 1);
	      const startedAt = performance.now();
	      const timeoutMs = 1800;

	      if (pingAbort) pingAbort.abort();
	      const controller = new AbortController();
	      pingAbort = controller;
      const timeoutHandle = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Frontend-only ping: hit the static index.html instead of `/api/*` so the
        // indicator does not depend on the backend being online.
        const resp = await fetch(`/index.html?ping=1&t=${Date.now()}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Cache-Control': 'no-cache' },
        });
        // Ensure the request actually transfers data (not just headers).
	        await resp.text();
	        const elapsed = performance.now() - startedAt;
	        if (!mounted || requestId !== pingRequestId) return null;

	        markReachable();
	        lastLatencyMsRef.current = Math.round(elapsed);
	        setNetworkSpeedSummary((prev) => ({
	          ...prev,
	          latencyMs: Math.round(elapsed),
          measuredAt: Date.now(),
        }));

        if (!resp.ok) {
          return elapsed > 1400 ? 'poor' : 'fair';
        }

	        if (elapsed > 2200) return 'poor';
	        if (elapsed > 900) return 'fair';
	        return 'good';
	      } catch (error: any) {
	        if (!mounted || requestId !== pingRequestId) return null;
	        if (error?.name === 'AbortError') {
	          consecutiveTimeoutRef.current += 1;
	          return shouldTimeoutsCountAsOffline() ? 'offline' : 'poor';
	        }
	        if (error instanceof TypeError) {
	          if (isLikelyOfflineError(error)) return 'offline';
	          consecutiveUnreachableRef.current += 1;
	          if (consecutiveUnreachableRef.current >= 2) return 'offline';
	        }
	        return isLikelyOfflineError(error) ? 'offline' : 'poor';
	      } finally {
	        window.clearTimeout(timeoutHandle);
	      }
	    };

	    const measureThroughput = async (): Promise<{
	      downloadMbps: number | null;
	      quality: NetworkQuality | null;
	    }> => {
      if (typeof navigator === 'undefined') {
        return { downloadMbps: null, quality: null };
      }
      if (navigator.onLine === false) {
        return { downloadMbps: null, quality: 'offline' };
      }

      const requestId = (throughputRequestId += 1);
	      const timeoutMs = 5200;

      if (throughputAbort) throughputAbort.abort();
      const controller = new AbortController();
      throughputAbort = controller;
      const timeoutHandle = window.setTimeout(() => controller.abort(), timeoutMs);

	      const measureFetchMbps = async (options: { url: string }) => {
	        const startedAt = performance.now();
	        const resp = await fetch(options.url, {
	          method: 'GET',
	          cache: 'no-store',
	          signal: controller.signal,
	          headers: {
	            'Cache-Control': 'no-cache',
	          },
	        });
	        if (!mounted || requestId !== throughputRequestId) return null;
	        if (!resp.ok) return null;

	        const targetBytes = choosePayloadBytes();
	        let bytesTransferred = 0;
	        let elapsedMs = 0;

	        if (resp.body && typeof (resp.body as any).getReader === 'function') {
	          const reader = (resp.body as any).getReader();
	          try {
	            while (bytesTransferred < targetBytes) {
	              const { done, value } = await reader.read();
	              if (done) break;
	              bytesTransferred += value?.byteLength ?? 0;
	            }
	            elapsedMs = performance.now() - startedAt;
	          } catch {
	            elapsedMs = performance.now() - startedAt;
	          } finally {
	            try {
	              await reader.cancel();
	            } catch {
	              // ignore
	            }
	          }
	        } else {
	          const buffer = await resp.arrayBuffer();
	          bytesTransferred = Math.min(buffer.byteLength, targetBytes);
	          elapsedMs = performance.now() - startedAt;
	        }

        if (!bytesTransferred || elapsedMs <= 0) return null;
        const mbps = (bytesTransferred * 8) / (elapsedMs / 1000) / 1_000_000;
        return mbps;
      };

      const choosePayloadBytes = () => {
        const latency = lastLatencyMsRef.current;
        if (typeof latency === 'number' && latency > 1400) {
          return 140_000;
        }
        return 320_000;
      };

      try {
        // Frontend-only throughput: fetch a static asset from `/public` so this does not
        // rely on the backend. Use a cache-busting query param to avoid cached responses.
        const downloadMbps = await measureFetchMbps({
          url: `/leafTexture.jpg?networkTest=1&t=${Date.now()}`,
        });

        if (!mounted || requestId !== throughputRequestId) {
          return { downloadMbps: null, quality: null };
        }

	        const hasDown = typeof downloadMbps === 'number' && Number.isFinite(downloadMbps);

	        if (!hasDown) {
	          consecutiveUnreachableRef.current += 1;
	          const offlineLikely = consecutiveUnreachableRef.current >= 2;
	          return { downloadMbps: null, quality: offlineLikely ? 'offline' : 'poor' };
	        }

	        markReachable();

	        const down = hasDown ? downloadMbps! : null;
	        const latencyMs = lastLatencyMsRef.current;

        setNetworkSpeedSummary({
          downloadMbps: down ? Math.round(down * 10) / 10 : null,
          uploadMbps: null,
          latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
          measuredAt: Date.now(),
        });

        const slowDown = typeof down === 'number' && down < 0.8;
        const highLatency = typeof latencyMs === 'number' && latencyMs > 2500;
        if (slowDown || highLatency) return { downloadMbps: down, quality: 'poor' };

        const fairDown = typeof down === 'number' && down < 2.0;
        const fairLatency = typeof latencyMs === 'number' && latencyMs > 900;
        if (fairDown || fairLatency) return { downloadMbps: down, quality: 'fair' };

        return { downloadMbps: down, quality: 'good' };
	      } catch (error: any) {
	        if (!mounted || requestId !== throughputRequestId) {
	          return { downloadMbps: null, quality: null };
	        }
	        if (error?.name === 'AbortError') {
	          consecutiveTimeoutRef.current += 1;
	          return { downloadMbps: null, quality: shouldTimeoutsCountAsOffline() ? 'offline' : 'poor' };
	        }
	        if (error instanceof TypeError) {
	          if (isLikelyOfflineError(error)) return { downloadMbps: null, quality: 'offline' };
	          consecutiveUnreachableRef.current += 1;
	          if (consecutiveUnreachableRef.current >= 2) return { downloadMbps: null, quality: 'offline' };
	        }
	        return { downloadMbps: null, quality: isLikelyOfflineError(error) ? 'offline' : 'poor' };
	      } finally {
	        window.clearTimeout(timeoutHandle);
	      }
	    };

    const updateFromConnection = () => {
      connQualityRef.current = deriveFromConnection();
      updateCombined();
    };

    const runPing = async () => {
      const pingQuality = await measureHealthPing();
      if (!mounted) return;
      pingQualityRef.current = pingQuality;
      updateCombined();
    };

	    const runThroughput = async () => {
	      const now = Date.now();
	      const ttlMs =
	        combinedQualityRef.current === 'poor' || combinedQualityRef.current === 'offline'
	          ? 30_000
	          : 75_000;
	      if (now - lastThroughputRef.current < ttlMs) return;
	      lastThroughputRef.current = now;
	      const result = await measureThroughput();
	      if (!mounted) return;
      throughputQualityRef.current = result.quality;
      updateCombined();
    };

    const onVisibilityChange = () => {
      if (visibilityTimer) window.clearTimeout(visibilityTimer);
      if (document.visibilityState !== 'visible') return;
      visibilityTimer = window.setTimeout(() => {
        void runPing();
        void runThroughput();
      }, 50);
    };

    updateFromConnection();
    void runPing();
    void runThroughput();

    window.addEventListener('online', updateFromConnection);
    window.addEventListener('offline', updateFromConnection);
    const apiListener = (event: Event) => {
      const detail = (event as CustomEvent)?.detail as any;
      if (detail && typeof detail.ok === 'boolean') {
        updateApiQuality(detail);
      } else {
        updateApiQuality({ ok: false });
      }
    };
    window.addEventListener('peppro:api-reachability', apiListener as any);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const conn = (navigator as any)?.connection;
    if (conn && typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', updateFromConnection);
    }

	    pingTimer = window.setInterval(() => {
	      if (document.visibilityState === 'visible') void runPing();
	    }, 5000);
	    throughputTimer = window.setInterval(() => {
	      if (document.visibilityState === 'visible') void runThroughput();
	    }, 30000);

    return () => {
      mounted = false;
      if (pingTimer) window.clearInterval(pingTimer);
      if (throughputTimer) window.clearInterval(throughputTimer);
      if (visibilityTimer) window.clearTimeout(visibilityTimer);
      if (pingAbort) pingAbort.abort();
      if (throughputAbort) throughputAbort.abort();
      window.removeEventListener('online', updateFromConnection);
      window.removeEventListener('offline', updateFromConnection);
      window.removeEventListener('peppro:api-reachability', apiListener as any);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (conn && typeof conn.removeEventListener === 'function') {
        conn.removeEventListener('change', updateFromConnection);
      }
    };
  }, []);
  const mergeOrderIntoCache = useCallback(
    (order: AccountOrderSummary | null | undefined) => {
      if (!order) return;
      const normalize = (value?: string | null) => (value ? String(value).trim() : null);
      setCachedAccountOrders((prev) => {
        if (
          prev.some(
            (entry) =>
              normalize(entry.id) === normalize(order.id) ||
              normalize(entry.wooOrderId) === normalize(order.wooOrderId) ||
              normalize(entry.wooOrderNumber) === normalize(order.wooOrderNumber) ||
              normalize(entry.number) === normalize(order.number),
          )
        ) {
          return prev;
        }
        return [order, ...prev];
      });
    },
    [],
  );
  const applyPendingLoginPrefill = useCallback(() => {
    const pending = pendingLoginPrefill.current;
    if (pending.email !== undefined && loginEmailRef.current) {
      loginEmailRef.current.value = pending.email;
      pending.email = undefined;
    }
    if (pending.password !== undefined && loginPasswordRef.current) {
      loginPasswordRef.current.value = pending.password;
      pending.password = undefined;
    }
  }, []);
  const queueLoginPrefill = useCallback(
    (values: { email?: string; password?: string }) => {
      if (values.email !== undefined) {
        pendingLoginPrefill.current.email = values.email;
      }
      if (values.password !== undefined) {
        pendingLoginPrefill.current.password = values.password;
      }
      applyPendingLoginPrefill();
    },
    [applyPendingLoginPrefill]
  );
  useEffect(() => {
    if (!accountModalRequest) {
      return;
    }
    if (accountModalRequest.token && accountModalRequest.token === accountModalRequestTokenRef.current) {
      return;
    }
    const token = accountModalRequest.token ?? Date.now();
    accountModalRequestTokenRef.current = token;
    console.debug('[Header] Processing account modal request', accountModalRequest);
    if (accountModalRequest.order) {
      mergeOrderIntoCache(accountModalRequest.order);
      setSelectedOrder(accountModalRequest.order);
    }
    if (accountModalRequest.tab) {
      setAccountTab(accountModalRequest.tab);
    }
    if (accountModalRequest.open || accountModalRequest.order) {
      setWelcomeOpen(true);
    }
    onAccountModalRequestHandled?.(token);
  }, [accountModalRequest, mergeOrderIntoCache, onAccountModalRequestHandled]);
  useEffect(() => { setLocalUser(user); }, [user]);
  useEffect(() => {
    const raw = typeof localUser?.zelleContact === 'string' ? localUser.zelleContact : '';
    setZelleContactDraft(raw ? raw.trim() : '');
  }, [localUser?.zelleContact]);
  useEffect(() => {
    const nextZelleContact = zelleContactDraft.trim();
    const prevZelleContact = typeof lastZelleContactRef.current === 'string' ? lastZelleContactRef.current : '';

    if (patientLinkPaymentMethodDraft === 'zelle') {
      const prevDefault = buildPatientLinkDefaultInstructions('zelle', prevZelleContact, localUser?.name ?? user?.name ?? null);
      const nextDefault = buildPatientLinkDefaultInstructions('zelle', nextZelleContact, localUser?.name ?? user?.name ?? null);
      const shouldReplace =
        !patientLinkInstructionsDraft.trim()
        || patientLinkInstructionsDraft.trim() === prevDefault.trim();
      if (shouldReplace && nextDefault.trim() !== patientLinkInstructionsDraft.trim()) {
        setPatientLinkInstructionsDraft(nextDefault);
      }
    }

    setPatientLinkInstructionsDraftByToken((prev) => {
      const next = { ...prev };
      for (const link of patientLinks || []) {
        const token = typeof (link as any)?.token === 'string' ? String((link as any).token).trim() : '';
        if (!token) continue;
        const method = normalizePatientLinkPaymentMethod(
          patientLinkPaymentMethodDraftByToken[token] ?? (link as any)?.paymentMethod ?? (link as any)?.payment_method ?? null,
        );
        if (method !== 'zelle') continue;
        const existing = typeof prev[token] === 'string' ? prev[token] : '';
        const prevDefault = buildPatientLinkDefaultInstructions('zelle', prevZelleContact, localUser?.name ?? user?.name ?? null);
        const shouldReplace = !existing.trim() || existing.trim() === prevDefault.trim();
        if (shouldReplace) {
          next[token] = buildPatientLinkDefaultInstructions('zelle', nextZelleContact, localUser?.name ?? user?.name ?? null);
        }
      }
      return next;
    });

    lastZelleContactRef.current = nextZelleContact || null;
  }, [
    localUser?.name,
    patientLinkInstructionsDraft,
    patientLinkPaymentMethodDraft,
    patientLinkPaymentMethodDraftByToken,
    patientLinks,
    user?.name,
    zelleContactDraft,
  ]);
  const accountDetailsRefreshSeqRef = useRef(0);
  useEffect(() => {
    if (!welcomeOpen) return;
    if (accountTab !== 'details') return;
    if (!user) return;
    const seq = ++accountDetailsRefreshSeqRef.current;
    (async () => {
      try {
        const api = await import('../services/api');
        const fresh = await api.authAPI.getCurrentUser();
        if (seq !== accountDetailsRefreshSeqRef.current) return;
        if (!fresh) return;
        setLocalUser((prev) => {
          const nextUserState: HeaderUser = {
            ...(prev || {}),
            ...(fresh as any),
          };
          onUserUpdated?.(nextUserState);
          return nextUserState;
        });
      } catch (error) {
        console.warn('[Header] Failed to refresh account details', error);
      }
    })();
  }, [welcomeOpen, accountTab, user, onUserUpdated]);
  useEffect(() => {
    if (!loginOpen || authMode !== 'login') {
      return;
    }
    const raf = requestAnimationFrame(() => {
      applyPendingLoginPrefill();
    });
    return () => cancelAnimationFrame(raf);
  }, [loginOpen, authMode, applyPendingLoginPrefill]);
  useEffect(() => {
    if (!welcomeOpen) {
      setAccountTab('details');
    }
  }, [welcomeOpen]);
  const accountRole = localUser?.role ?? user?.role ?? null;
  const accountIsAdmin = isAdmin(accountRole);
  const accountIsSalesRep = isRep(accountRole) || isSalesLead(accountRole);
  const headerDisplayName = localUser
    ? accountIsAdmin
      ? `Admin: ${localUser.name}`
      : isSalesLead(accountRole)
        ? `Lead: ${localUser.name}`
      : accountIsSalesRep
        ? `Rep: ${localUser.name}`
        : localUser.name
    : '';
  const profileImageUrl = localUser
    ? (localUser.profileImageUrl ?? null)
    : (user?.profileImageUrl ?? null);
  const userInitials = getInitials(localUser?.name || user?.name || headerDisplayName);
  const normalizedReferralCodes = Array.isArray(referralCodes)
    ? referralCodes
        .map((code) => {
          if (code === null || code === undefined) {
            return '';
          }
          return String(code).trim().toUpperCase();
        })
        .filter((code, index, array) => code.length > 0 && array.indexOf(code) === index)
    : [];
  const primaryReferralCode = normalizedReferralCodes[0] || null;
  const canShowReferralCode = (accountIsAdmin || accountIsSalesRep) && Boolean(primaryReferralCode);

  // Account tab underline indicator (shared bar that moves to active tab)
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const [indicatorLeft, setIndicatorLeft] = useState<number>(0);
  const [indicatorWidth, setIndicatorWidth] = useState<number>(0);
  const [indicatorOpacity, setIndicatorOpacity] = useState<number>(0);
  const tabScrollDragStateRef = useRef<{ isDragging: boolean; startX: number; scrollLeft: number }>({
    isDragging: false,
    startX: 0,
    scrollLeft: 0,
  });

  const renderAvatar = (size = 32, className = '') => {
    const dimension = typeof size === 'number' ? `${size}px` : size;
    const numericSize = typeof size === 'number' ? size : null;
    const fallbackFontSize = numericSize ? `${Math.max(12, Math.round(numericSize * 0.45))}px` : undefined;
    if (profileImageUrl) {
	      return (
	        <img
	          src={profileImageUrl}
	          alt={`${headerDisplayName || localUser?.name || user?.name || 'User'} avatar`}
	          className={clsx('header-avatar-image', className)}
	          style={{ width: dimension, height: dimension }}
	          onError={() => {
	            if (onUserUpdated && localUser) {
              onUserUpdated({ ...localUser, profileImageUrl: null });
            }
          }}
        />
      );
    }
    return (
      <div
        className={clsx('header-avatar-image header-avatar-fallback', className)}
        style={{ width: dimension, height: dimension, fontSize: fallbackFontSize }}
        aria-hidden="true"
      >
        {userInitials}
      </div>
    );
  };

  const updateTabIndicator = useCallback(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    const activeBtn = container.querySelector<HTMLButtonElement>(`button[data-tab="${accountTab}"]`);
    if (!activeBtn) return;
    const inset = 8; // match left/right padding for a tidy fit
    const scrollLeft = container.scrollLeft || 0;
    const left = Math.max(0, activeBtn.offsetLeft - scrollLeft + inset);
    const width = Math.max(0, activeBtn.offsetWidth - inset * 2);
    setIndicatorLeft(left);
    setIndicatorWidth(width);
    setIndicatorOpacity(1);
  }, [accountTab]);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      updateTabIndicator();
    });
    return () => cancelAnimationFrame(raf);
  }, [updateTabIndicator, welcomeOpen, accountTab]);

  useEffect(() => {
    const onResize = () => updateTabIndicator();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateTabIndicator]);

  useEffect(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      updateTabIndicator();
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [updateTabIndicator]);

  const handleTabScrollMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = tabsContainerRef.current;
    if (!container) return;
    tabScrollDragStateRef.current.isDragging = true;
    tabScrollDragStateRef.current.startX = event.clientX;
    tabScrollDragStateRef.current.scrollLeft = container.scrollLeft;
    container.classList.add('is-dragging');
  };

  const handleTabScrollMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const container = tabsContainerRef.current;
    if (!container) return;
    if (!tabScrollDragStateRef.current.isDragging) return;
    event.preventDefault();
    const deltaX = event.clientX - tabScrollDragStateRef.current.startX;
    container.scrollLeft = tabScrollDragStateRef.current.scrollLeft - deltaX;
  };

  const endTabScrollDrag = () => {
    const container = tabsContainerRef.current;
    tabScrollDragStateRef.current.isDragging = false;
    if (container) {
      container.classList.remove('is-dragging');
    }
  };

  const handleTabScrollMouseUp = () => {
    endTabScrollDrag();
  };

  const handleTabScrollMouseLeave = () => {
    endTabScrollDrag();
  };

  const handleTabScrollTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const container = tabsContainerRef.current;
    if (!container || event.touches.length !== 1) return;
    const touch = event.touches[0];
    tabScrollDragStateRef.current.isDragging = true;
    tabScrollDragStateRef.current.startX = touch.clientX;
    tabScrollDragStateRef.current.scrollLeft = container.scrollLeft;
  };

  const handleTabScrollTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const container = tabsContainerRef.current;
    if (!container) return;
    if (!tabScrollDragStateRef.current.isDragging) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - tabScrollDragStateRef.current.startX;
    container.scrollLeft = tabScrollDragStateRef.current.scrollLeft - deltaX;
  };

  const handleTabScrollTouchEnd = () => {
    endTabScrollDrag();
  };

  const handleTabScrollWheel = (event: WheelEvent<HTMLDivElement>) => {
    const container = tabsContainerRef.current;
    if (!container) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      container.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  };

  useEffect(() => {
    if (!welcomeOpen) return;
    const timer = setTimeout(() => {
      updateTabIndicator();
    }, 80);
    return () => clearTimeout(timer);
  }, [welcomeOpen, updateTabIndicator, accountTab]);

	  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
	    event.preventDefault();

	    if (loginSubmitting) {
	      return;
	    }

	    setLoginError('');
	    setSignupError('');
	    setLoginSubmitting(true);

	    const formElement = event.currentTarget;
	    const emailValue = loginEmailRef.current?.value ?? '';
	    const passwordValue = loginPasswordRef.current?.value ?? '';

	    const classifyNetworkIssue = (message?: string | null): 'offline' | 'network' | null => {
	      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
	        return 'offline';
	      }
	      if (networkQuality === 'offline') {
	        return 'offline';
	      }
	      if (networkQuality === 'poor') {
	        return 'network';
	      }
	      const text = String(message || '').toLowerCase();
	      if (!text) return null;
	      if (text.includes('offline') || text.includes('no internet') || text.includes('internet connection')) {
	        return 'offline';
	      }
	      return (
	        text.includes('failed to fetch') ||
	        text.includes('networkerror') ||
	        text.includes('network request failed') ||
	        text.includes('load failed') ||
	        text.includes('timeout') ||
	        text.includes('econnrefused') ||
	        text.includes('enotfound') ||
	        text.includes('eai_again')
	      )
	        ? 'network'
	        : null;
	    };

	    const issueAtSubmit = classifyNetworkIssue(null);
	    if (issueAtSubmit === 'offline') {
	      setLoginError('No internet connection detected. Please turn on Wi-Fi or cellular data and try again.');
	      setLoginSubmitting(false);
	      return;
	    }

	    let result: AuthActionResult;
	    try {
        if (!onLogin) {
          throw new Error('LOGIN_UNAVAILABLE');
        }
	      result = await onLogin(emailValue, passwordValue);
	    } catch (error: any) {
	      const message = typeof error?.message === 'string' ? error.message : null;
	      const issue = classifyNetworkIssue(message);
	      setLoginError(
	        issue === 'offline'
	          ? 'No internet connection detected. Please turn on Wi-Fi or cellular data and try again.'
	          : issue === 'network'
	            ? "Can't reach PepPro right now. This usually means your internet is offline or very slow. Please check your connection and try again."
	          : 'Unable to log in. Please try again.',
	      );
	      setLoginSubmitting(false);
	      return;
	    }

    if (result.status === 'success') {
      queueLoginPrefill({ email: '', password: '' });
      formElement.reset();
      setLoginOpen(false);
      setAuthMode('login');
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginError('');
      setSignupError('');
      if (loginContext !== 'checkout') {
        setWelcomeOpen(true);
      }
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'sales_rep_signup_required') {
      setLoginError('Your sales rep profile needs to be activated before you can sign in. Please finish setting up your account or contact support for help.');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'invalid_password') {
      setLoginError('Incorrect password. Please try again.');
      queueLoginPrefill({ password: '' });
      setAuthMode('login');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'email_not_found') {
      setLoginError('');
      setSignupError('We couldn\'t find that email. Please create your account below.');
      setAuthMode('signup');
      setSignupEmail(emailValue);
      setSignupSuffix('');
      setSignupPassword(passwordValue);
      setSignupConfirmPassword(passwordValue);
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginSubmitting(false);
      return;
    }

	    if (result.status === 'error') {
	      const issue = classifyNetworkIssue(result.message);
	      setLoginError(
	        issue === 'offline'
	          ? 'No internet connection detected. Please turn on Wi-Fi or cellular data and try again.'
	          : issue === 'network'
	            ? "Can't reach PepPro right now. This usually means your internet is offline or very slow. Please check your connection and try again."
	          : 'Unable to log in. Please try again.',
	      );
	    }

    setLoginSubmitting(false);
  };

  useEffect(() => {
    if (loginPromptToken === undefined || loginPromptToken === null || loginPromptToken === 0) {
      return;
    }
    if (lastLoginPromptToken.current === loginPromptToken) {
      return;
    }
    lastLoginPromptToken.current = loginPromptToken;
    setAuthMode('login');
    setLoginError('');
    setSignupError('');
    setSignupSuffix('');
    setSignupName('');
    setSignupEmail('');
    setSignupPassword('');
    setSignupConfirmPassword('');
    setSignupCode('');
    setShowLoginPassword(false);
    setShowSignupPassword(false);
    setShowSignupConfirmPassword(false);
    if (!user) {
      setLoginOpen(true);
    }
    setWelcomeOpen(false);
  }, [loginPromptToken, user]);

  useEffect(() => {
    if (user && loginOpen) {
      setLoginOpen(false);
    }
  }, [user, loginOpen]);

  useEffect(() => {
    if (!user) {
      setWelcomeOpen(false);
    }
  }, [user]);

  // Preserve last known orders so UI doesn't clear while refresh runs in background
  useEffect(() => {
    const incoming = Array.isArray(accountOrders) ? accountOrders : [];
    if (incoming.length > 0) {
      setCachedAccountOrders(incoming);
      return;
    }
    if (!accountOrdersLoading) {
      setCachedAccountOrders(incoming);
    }
  }, [accountOrders, accountOrdersLoading]);
  useEffect(() => {
    cachedAccountOrdersRef.current = cachedAccountOrders;
  }, [cachedAccountOrders]);

  // Keep the open order details view in sync with refreshed order data.
  // Without this, the list can refresh (showing a new status) while the modal
  // continues to display a stale `selectedOrder` snapshot.
  useEffect(() => {
    if (!selectedOrder || !cachedAccountOrders.length) {
      return;
    }
    const normalize = (value: any) => String(value ?? '').trim().toLowerCase();
    const selectedKeys = [
      selectedOrder.id,
      selectedOrder.wooOrderId,
      selectedOrder.wooOrderNumber,
      selectedOrder.number,
      selectedOrder.cancellationId,
    ]
      .map(normalize)
      .filter(Boolean);
    if (!selectedKeys.length) return;

    const match = cachedAccountOrders.find((order) => {
      const keys = [
        order.id,
        order.wooOrderId,
        order.wooOrderNumber,
        order.number,
        order.cancellationId,
      ]
        .map(normalize)
        .filter(Boolean);
      return keys.some((key) => selectedKeys.includes(key));
    });
    if (!match) return;

    const statusChanged = String(match.status ?? '') !== String(selectedOrder.status ?? '');
    const updatedAtChanged = String(match.updatedAt ?? '') !== String(selectedOrder.updatedAt ?? '');
    if (statusChanged || updatedAtChanged) {
      setSelectedOrder(match);
    }
  }, [
    cachedAccountOrders,
    selectedOrder?.id,
    selectedOrder?.wooOrderId,
    selectedOrder?.wooOrderNumber,
    selectedOrder?.number,
    selectedOrder?.cancellationId,
    selectedOrder?.status,
    selectedOrder?.updatedAt,
  ]);
  useEffect(() => {
    orderLineImageCacheRef.current = orderLineImageCache;
  }, [orderLineImageCache]);

  useEffect(() => {
    if (!cancellingOrderId) {
      return;
    }
    const matchesCancellationKey = (order: AccountOrderSummary) => {
      const key = order?.cancellationId || order?.wooOrderId || order?.id;
      return key ? String(key) === String(cancellingOrderId) : false;
    };
    const match = cachedAccountOrders.find(matchesCancellationKey);
    if (match && isTerminalOrderStatus(match.status ? String(match.status) : null)) {
      const selectedCancellationId = selectedOrder
        ? selectedOrder.cancellationId || selectedOrder.wooOrderId || selectedOrder.id
        : null;
      if (selectedCancellationId && String(selectedCancellationId) === String(cancellingOrderId)) {
        setSelectedOrder(null);
      }
      setCancellingOrderId((current) => (current === cancellingOrderId ? null : current));
    }
  }, [cancellingOrderId, cachedAccountOrders, selectedOrder]);

  // Auto-refresh orders when the orders tab is open
  useEffect(() => {
		    if (!welcomeOpen || accountTab !== 'orders' || !onRefreshOrders || !user) {
		      return undefined;
		    }
	    let cancelled = false;
	    let inFlight = false;
	    const leaderKey = 'orders-auto-refresh';
	    const leaderTtlMs = 45_000;

    const shouldRefresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
      return true;
    };

		    const runRefresh = async () => {
		      if (cancelled || inFlight) return;
		      if (!shouldRefresh()) return;
		      if (!isTabLeader(leaderKey, leaderTtlMs)) return;
		      inFlight = true;
		      try {
		        await Promise.resolve(onRefreshOrders());
		      } finally {
		        inFlight = false;
		      }
		    };

    void runRefresh();
    const intervalId = window.setInterval(() => {
      void runRefresh();
    }, 20000);
	    return () => {
	      cancelled = true;
	      releaseTabLeadership(leaderKey);
	      window.clearInterval(intervalId);
	    };
	  }, [welcomeOpen, accountTab, onRefreshOrders, user]);

  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined') {
        const isLarge = window.innerWidth >= 1024;
        setIsLargeScreen(isLarge);
        if (isLarge) {
          setMobileSearchOpen(false);
        }
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    return () => {
      logoutThanksTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      logoutThanksTimeoutsRef.current = [];
      if (logoutThanksRafRef.current !== null) {
        window.cancelAnimationFrame(logoutThanksRafRef.current);
        logoutThanksRafRef.current = null;
      }
    };
  }, []);

  const clearDeleteAccountHoldTimers = useCallback(() => {
    deleteAccountHoldTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    deleteAccountHoldTimeoutsRef.current = [];
  }, []);

  const resetDeleteAccountHold = useCallback(() => {
    deleteAccountHoldTriggeredRef.current = false;
    clearDeleteAccountHoldTimers();
    setDeleteAccountHoldCount(0);
  }, [clearDeleteAccountHoldTimers]);

  useEffect(() => {
    return () => {
      clearDeleteAccountHoldTimers();
    };
  }, [clearDeleteAccountHoldTimers]);

  const executeDeleteAccount = useCallback(async () => {
    if (deleteAccountDeleting || deleteAccountHoldTriggeredRef.current) {
      return;
    }
    deleteAccountHoldTriggeredRef.current = true;
    setDeleteAccountDeleting(true);
    try {
      const api = await import('../services/api');
      await api.authAPI.deleteMe();
      if (onLogout) {
        await Promise.resolve(onLogout());
      } else {
        api.authAPI.logout();
      }
      setWelcomeOpen(false);
      setLoginOpen(false);
      setDeleteAccountModalOpen(false);
      toast.success('Account deleted');
    } catch (error: any) {
      const message = typeof error?.message === 'string' && error.message.trim().length > 0
        ? error.message.trim()
        : 'Unable to delete account';
      toast.error(message);
      deleteAccountHoldTriggeredRef.current = false;
    } finally {
      setDeleteAccountDeleting(false);
      resetDeleteAccountHold();
    }
  }, [deleteAccountDeleting, onLogout, resetDeleteAccountHold]);

  const beginDeleteAccountHold = useCallback(() => {
    if (deleteAccountDeleting) {
      return;
    }
    clearDeleteAccountHoldTimers();
    deleteAccountHoldTriggeredRef.current = false;
    setDeleteAccountHoldCount(1);
    deleteAccountHoldTimeoutsRef.current.push(
      window.setTimeout(() => {
        if (deleteAccountHoldTriggeredRef.current) return;
        setDeleteAccountHoldCount(2);
      }, 1000),
    );
    deleteAccountHoldTimeoutsRef.current.push(
      window.setTimeout(() => {
        if (deleteAccountHoldTriggeredRef.current) return;
        setDeleteAccountHoldCount(3);
      }, 2000),
    );
    deleteAccountHoldTimeoutsRef.current.push(
      window.setTimeout(() => {
        void executeDeleteAccount();
      }, 3000),
    );
  }, [clearDeleteAccountHoldTimers, deleteAccountDeleting, executeDeleteAccount]);

  const handleDeleteAccountModalOpenChange = useCallback((open: boolean) => {
    setDeleteAccountModalOpen(open);
    if (!open) {
      resetDeleteAccountHold();
    }
  }, [resetDeleteAccountHold]);

  const clearLogoutThanksTimers = useCallback(() => {
    logoutThanksTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    logoutThanksTimeoutsRef.current = [];
    if (logoutThanksRafRef.current !== null) {
      window.cancelAnimationFrame(logoutThanksRafRef.current);
      logoutThanksRafRef.current = null;
    }
  }, []);

  const triggerLogoutOnce = useCallback(() => {
    if (logoutThanksLogoutPromiseRef.current) {
      return logoutThanksLogoutPromiseRef.current;
    }
    if (!onLogout) {
      return Promise.resolve();
    }
    logoutThanksLogoutTriggeredRef.current = true;
    const promise = Promise.resolve(onLogout()).finally(() => {
      // Keep the promise ref cleared so future logouts can run if needed.
      logoutThanksLogoutPromiseRef.current = null;
    });
    logoutThanksLogoutPromiseRef.current = promise;
    return promise;
  }, [onLogout]);

  const finishLogoutModalClose = useCallback(() => {
    setLogoutThanksOpen(false);
    logoutThanksPendingFadeOutRef.current = false;
  }, []);

  const beginLogoutFadeOut = useCallback(
    (sequence: number, durationMs: number) => {
      if (logoutThanksPendingFadeOutRef.current) return;
      logoutThanksPendingFadeOutRef.current = true;
      setLogoutThanksTransitionMs(durationMs);

      // Keep the modal visible while logout runs. Fade out only once logout completes.
      void triggerLogoutOnce()
        .catch(() => undefined)
        .finally(() => {
          if (logoutThanksSequenceRef.current !== sequence) return;
          setLogoutThanksOpacity(0);
          logoutThanksTimeoutsRef.current.push(
            window.setTimeout(() => {
              if (logoutThanksSequenceRef.current !== sequence) return;
              finishLogoutModalClose();
            }, durationMs),
          );
        });
    },
    [finishLogoutModalClose, triggerLogoutOnce],
  );

  const handleLogoutClick = useCallback(() => {
    const fadeInMs = 350;
    const fadeOutMs = 350;
    clearLogoutThanksTimers();
    logoutThanksLogoutTriggeredRef.current = false;
    logoutThanksPendingFadeOutRef.current = false;
    logoutThanksSequenceRef.current += 1;
    const sequence = logoutThanksSequenceRef.current;
    setWelcomeOpen(false);
    setLoginOpen(false);
    setLogoutThanksTransitionMs(fadeInMs);
    setLogoutThanksOpacity(0);
    setLogoutThanksOpen(true);
    logoutThanksRafRef.current = window.requestAnimationFrame(() => {
      if (logoutThanksSequenceRef.current !== sequence) return;
      setLogoutThanksOpacity(1);
    });
    logoutThanksTimeoutsRef.current.push(
      window.setTimeout(() => {
        if (logoutThanksSequenceRef.current !== sequence) return;
        beginLogoutFadeOut(sequence, fadeOutMs);
      }, 5000),
    );
  }, [beginLogoutFadeOut, clearLogoutThanksTimers]);

  const handleLogoutThanksOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setLogoutThanksOpen(true);
        return;
      }

      if (logoutThanksLogoutTriggeredRef.current) return;
      clearLogoutThanksTimers();
      logoutThanksSequenceRef.current += 1;
      const sequence = logoutThanksSequenceRef.current;
      setLogoutThanksOpen(true);
      beginLogoutFadeOut(sequence, 350);
    },
    [beginLogoutFadeOut, clearLogoutThanksTimers],
  );

  useEffect(() => {
    const handleLogoutWithThanks = () => {
      handleLogoutClick();
    };
    window.addEventListener(
      "peppro:logout-with-thanks",
      handleLogoutWithThanks as EventListener,
    );
    return () => {
      window.removeEventListener(
        "peppro:logout-with-thanks",
        handleLogoutWithThanks as EventListener,
      );
    };
  }, [handleLogoutClick]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const headerElement = headerRef.current;
    if (!headerElement) {
      return;
    }

    const updateHeightVariable = () => {
      const { height } = headerElement.getBoundingClientRect();
      document.documentElement.style.setProperty('--app-header-height', `${Math.round(height)}px`);
    };

    updateHeightVariable();

    let resizeObserver: ResizeObserver | null = null;

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => updateHeightVariable());
      resizeObserver.observe(headerElement);
    } else {
      window.addEventListener('resize', updateHeightVariable);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener('resize', updateHeightVariable);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (referralCopyTimeout.current) {
        clearTimeout(referralCopyTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleGlobalClose = () => {
      setWelcomeOpen(false);
      setLoginOpen(false);
    };
    window.addEventListener('peppro:close-dialogs', handleGlobalClose);
    return () => {
      window.removeEventListener('peppro:close-dialogs', handleGlobalClose);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleLegalState = (event: Event) => {
      const custom = event as CustomEvent<{ open?: boolean }>;
      setLegalModalOpen(Boolean(custom.detail?.open));
    };
    window.addEventListener('peppro:legal-state', handleLegalState);
    return () => {
      window.removeEventListener('peppro:legal-state', handleLegalState);
    };
  }, []);

  useLayoutEffect(() => {
    if (!welcomeOpen) {
      accountTabScrollTopRef.current = {};
      restoreAccountTabScrollRef.current = {};
      return;
    }
    if (legalModalOpen) {
      if (accountModalScrollRef.current) {
        accountTabScrollTopRef.current[accountTab] = accountModalScrollRef.current.scrollTop;
        restoreAccountTabScrollRef.current[accountTab] = true;
      }
      return;
    }
    if (!restoreAccountTabScrollRef.current[accountTab]) {
      return;
    }
    const scrollContainer = accountModalScrollRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollTop = accountTabScrollTopRef.current[accountTab] ?? 0;
    restoreAccountTabScrollRef.current[accountTab] = false;
  }, [accountTab, legalModalOpen, welcomeOpen]);

  const handleSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSearch(searchQuery, { submitted: true });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileSearchOpen(false);
    }
  };


  const handleSearchChange = (value: string) => {
    console.debug('[Header] Search change', { value });
    setSearchQuery(value);
    onSearch(value, { submitted: false });
  };

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  const focusSearchInput = useCallback(() => {
    const node = searchInputRef.current;
    if (!node) return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      node.focus();
    }
  }, []);

  const toggleMobileSearch = () => {
    setMobileSearchOpen((prev) => {
      const next = !prev;

      if (typeof window !== 'undefined') {
        if (next) {
          window.setTimeout(() => focusSearchInput(), 0);
        } else {
          searchInputRef.current?.blur();
        }
      }

      return next;
    });
  };

  useEffect(() => {
    if (!mobileSearchOpen) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => focusSearchInput(), 0);
  }, [focusSearchInput, mobileSearchOpen]);

  useEffect(() => {
    if (!mobileSearchOpen) {
      return undefined;
    }
    if (typeof window === 'undefined') {
      return undefined;
    }

    const isEditableTarget = (target: EventTarget | null) => {
      if (!target || !(target as any).tagName) return false;
      const el = target as HTMLElement;
      if (el === searchInputRef.current) return true;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      return Boolean((el as any).isContentEditable);
    };

    const handler = (event: KeyboardEvent) => {
      if (!mobileSearchOpen) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileSearchOpen(false);
        searchInputRef.current?.blur();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      // If the user is already typing into an input (including the search field), let it behave normally.
      if (isEditableTarget(event.target)) {
        return;
      }

      // Redirect typing into the search bar after it has been opened.
      if (event.key === 'Backspace') {
        event.preventDefault();
        const current = searchQueryRef.current || '';
        handleSearchChange(current.slice(0, Math.max(0, current.length - 1)));
        focusSearchInput();
        return;
      }

      if (event.key.length === 1) {
        event.preventDefault();
        const current = searchQueryRef.current || '';
        handleSearchChange(current + event.key);
        focusSearchInput();
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focusSearchInput, handleSearchChange, mobileSearchOpen]);

  const handleSignup = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fullName = signupSuffix ? `${signupSuffix} ${signupName}`.trim() : signupName;

    const details = {
      name: fullName,
      email: signupEmail,
      password: signupPassword,
      confirmPassword: signupConfirmPassword,
      code: signupCode,
    };

    setSignupError('');
    setLoginError('');

    const result = onCreateAccount
      ? await onCreateAccount(details)
      : onLogin
        ? await onLogin(signupEmail, signupPassword)
        : ({ status: 'error', message: 'LOGIN_UNAVAILABLE' } as any);

    if (result.status === 'success') {
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setAuthMode('login');
      setLoginOpen(false);
      setSignupError('');
      setLoginError('');
      if (loginContext !== 'checkout') {
        setWelcomeOpen(true);
      }
      return;
    }

    if (result.status === 'email_exists') {
      setSignupError('');
      setLoginError('An account with this email already exists. Please log in.');
      setAuthMode('login');
      queueLoginPrefill({ email: details.email, password: '' });
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'invalid_password') {
      setSignupError('');
      setLoginError('Incorrect password. Please try again.');
      setAuthMode('login');
      queueLoginPrefill({ email: details.email, password: '' });
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'email_not_found') {
      setSignupError('We couldn\'t find that email. Please create your account below.');
      setAuthMode('signup');
      setSignupEmail(details.email);
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'password_mismatch') {
      setSignupError('Passwords do not match. Please confirm and try again.');
      return;
    }

    if (result.status === 'invalid_referral_code') {
      setSignupError('Referral codes must be 5 characters (e.g., AB123). Please double-check and try again.');
      return;
    }

    if (result.status === 'referral_code_not_found') {
      setSignupError('We couldn\'t locate that referral code. Please confirm it with your sales representative.');
      return;
    }

    if (result.status === 'sales_rep_email_mismatch') {
      setSignupError('Please use the email address associated with your sales representative profile.');
      return;
    }

	    if (result.status === 'referral_code_unavailable') {
	      setSignupError('This onboarding code isn\'t available. Please confirm it with your representative.');
	      return;
	    }

    if (result.status === 'name_email_required') {
      setSignupError('Name and email are required to create your account.');
      return;
    }

    if (result.status === 'error') {
      if (result.message === 'PASSWORD_REQUIRED') {
        setSignupError('Please create a secure password to access your account.');
      } else {
        setSignupError('Unable to create an account right now. Please try again.');
      }
  }
  };

  const handleTrackOrder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!trackingForm.orderId.trim()) {
      setTrackingMessage('Please enter a valid order ID.');
      return;
    }

    setTrackingPending(true);
    setTrackingMessage(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      setTrackingMessage('We will email your latest tracking update shortly.');
    } catch (error) {
      console.warn('[Account modal] Tracking lookup failed', error);
      setTrackingMessage('Unable to look up that order right now. Please try again.');
    } finally {
      setTrackingPending(false);
    }
  };


  const handleDialogChange = (open: boolean) => {
    console.debug('[Header] Auth dialog open change', { open });
    setLoginOpen(open);
    if (!open) {
      setAuthMode('login');
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setLoginError('');
      setSignupError('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
    }
  };

  const handleCartClick = () => {
    if (onCartClick) {
      onCartClick('cart_button');
    }
  };

  const handleCancelOrderClick = useCallback(async (orderId: string) => {
    if (!onCancelOrder) {
      return;
    }
    setCancellingOrderId(orderId);
    try {
      await onCancelOrder(orderId);
    } catch (error: any) {
      const message = typeof error?.message === 'string' && error.message.trim().length > 0
        ? error.message
        : 'Unable to cancel this order right now.';
      toast.error(message);
      setCancellingOrderId((current) => (current === orderId ? null : current));
      return;
    }

    const isTerminalCancelStatus = (status?: string | null) => {
      const normalized = String(status || '').trim().toLowerCase();
      return (
        normalized === 'refunded' ||
        normalized === 'cancelled' ||
        normalized === 'canceled' ||
        normalized === 'trash'
      );
    };
    const matchesCancellationKey = (order: AccountOrderSummary) => {
      const key = order?.cancellationId || order?.wooOrderId || order?.id;
      return key ? String(key) === String(orderId) : false;
    };
    const selectedCancellationId = selectedOrder
      ? selectedOrder.cancellationId || selectedOrder.wooOrderId || selectedOrder.id
      : null;

	    void (async () => {
	      const started = Date.now();
	      const timeoutMs = 180_000;
	      const intervalMs = 1500;
	      while (Date.now() - started < timeoutMs) {
	        try {
	          await Promise.resolve(onRefreshOrders?.());
	        } catch {
	          // ignore refresh errors during polling
	        }
        const match = cachedAccountOrdersRef.current.find(matchesCancellationKey);
        if (match && isTerminalCancelStatus(match.status)) {
          if (selectedCancellationId && String(selectedCancellationId) === String(orderId)) {
            setSelectedOrder(null);
          }
          setCancellingOrderId((current) => (current === orderId ? null : current));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      toast.info('Cancellation submitted. It may take a moment for the order status to update.');
    })();
  }, [onCancelOrder, onRefreshOrders, selectedOrder]);

  const storeOrderLineImageCacheEntry = useCallback((key: string, url: string | null) => {
    if (!key) return;
    setOrderLineImageCache((prev) => {
      if (Object.is(prev[key], url)) {
        return prev;
      }
      const next = { ...prev, [key]: url };
      orderLineImageCacheRef.current = next;
      return next;
    });
  }, []);

  const extractWooLineItemsFromOrder = useCallback((order: AccountOrderSummary | null | undefined) => {
    if (!order) return [];
    const integrationDetails = parseMaybeJson((order as any).integrationDetails);
    const wooIntegration = parseMaybeJson(integrationDetails?.wooCommerce || integrationDetails?.woocommerce);
    const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
    const wooPayload = parseMaybeJson(wooIntegration?.payload) || {};
    if (Array.isArray(wooResponse?.line_items)) {
      return wooResponse.line_items;
    }
    if (Array.isArray(wooPayload?.line_items)) {
      return wooPayload.line_items;
    }
    return [];
  }, []);

  const extractOrderLineImageKey = useCallback((line: AccountOrderLineItem | null | undefined) => {
    if (!line) return null;
    const productId =
      normalizeIdValue(line.productId) ||
      normalizeIdValue((line as any)?.product_id);
    if (!productId) return null;
    const variationId =
      normalizeIdValue(line.variantId) ||
      normalizeIdValue((line as any)?.variation_id);
    const key = variationId ? `${productId}:${variationId}` : `${productId}:0`;
    return { productId, variationId: variationId || null, key };
  }, []);

  const runWithOrderLineImagePrefetchLimit = useCallback(async (task: () => Promise<void>) => {
    const limit = 4;
    const state = orderLineImagePrefetchRef.current;
    return new Promise<void>((resolve) => {
      const run = () => {
        state.active += 1;
        Promise.resolve()
          .then(task)
          .catch(() => undefined)
          .finally(() => {
            state.active = Math.max(0, state.active - 1);
            const next = state.queue.shift();
            if (next) {
              next();
            }
            resolve();
          });
      };

      if (state.active < limit) {
        run();
        return;
      }

      state.queue.push(run);
    });
  }, []);

  const ensureOrderLineImageLoaded = useCallback(
    async (line: AccountOrderLineItem, wooLineItems: any[] = []) => {
      const existingInline = resolveOrderLineImage(line, wooLineItems);
      const ids = extractOrderLineImageKey(line);
      if (!ids) {
        return;
      }

      if (existingInline) {
        storeOrderLineImageCacheEntry(ids.key, existingInline);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(orderLineImageCacheRef.current, ids.key)) {
        return;
      }
      if (orderLineImageInflightRef.current.has(ids.key)) {
        return;
      }

      orderLineImageInflightRef.current.add(ids.key);
      try {
        await runWithOrderLineImagePrefetchLimit(async () => {
          const api = await import('../services/api');
          let resolved: string | null = null;

          if (ids.variationId) {
            try {
              const variation = await api.wooAPI.getProductVariation(ids.productId, ids.variationId);
              resolved =
                normalizeImageSource((variation as any)?.image) ||
                normalizeImageSource((variation as any)?.images?.[0]) ||
                null;
            } catch {
              // ignore variation lookup failures
            }
          }

          if (!resolved) {
            try {
              const product = await api.wooAPI.getProduct(ids.productId);
              resolved =
                normalizeImageSource((product as any)?.images?.[0]) ||
                normalizeImageSource((product as any)?.image) ||
                null;
            } catch {
              // ignore product lookup failures
            }
          }

          storeOrderLineImageCacheEntry(ids.key, resolved);
        });
      } finally {
        orderLineImageInflightRef.current.delete(ids.key);
      }
    },
    [extractOrderLineImageKey, runWithOrderLineImagePrefetchLimit, storeOrderLineImageCacheEntry],
  );

  const isCanceledOrRefundedStatus = useCallback((status?: string | null) => {
    const normalized = status ? String(status).trim().toLowerCase() : '';
    return normalized === 'trash' || normalized.includes('cancel') || normalized.includes('refund');
  }, []);

  const invoiceDownloadInflightRef = useRef<Set<string>>(new Set());
  const downloadInvoiceForOrder = useCallback(async (order: any) => {
    const integrations = order?.integrations || order?.integrationDetails || null;
    const woo =
      (integrations as any)?.wooCommerce ||
      (integrations as any)?.woocommerce ||
      null;
    const invoiceOrderId =
      order?.wooOrderId ||
      woo?.wooOrderId ||
      order?.wooOrderNumber ||
      woo?.wooOrderNumber ||
      order?.id ||
      null;
    const resolvedId = invoiceOrderId ? String(invoiceOrderId) : '';
    if (!resolvedId) {
      toast.error('Invoice is not available for this order yet.');
      return;
    }

    if (invoiceDownloadInflightRef.current.has(resolvedId)) {
      return;
    }
    invoiceDownloadInflightRef.current.add(resolvedId);

    try {
      const api = await import('../services/api');
      const { blob, filename } = await api.ordersAPI.downloadInvoice(resolvedId);
      triggerBrowserDownload(blob, filename || `PepPro_Invoice_${resolvedId}.pdf`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to download invoice right now.';
      toast.error(message);
    } finally {
      invoiceDownloadInflightRef.current.delete(resolvedId);
    }
  }, []);

  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'orders') {
      return;
    }

    const visibleOrders = cachedAccountOrders
      .filter((order) => {
        const source = (order.source || '').toLowerCase();
        const hasWooIntegration = Boolean(
          (order.integrationDetails as any)?.wooCommerce ||
          (order.integrationDetails as any)?.woocommerce,
        );
        return source === 'woocommerce' || source === 'peppro' || source === 'local' || hasWooIntegration;
      })
      .filter((order) => {
        if (showCanceledOrders) {
          return true;
        }
        return !isCanceledOrRefundedStatus(order.status);
      });

    const queued = new Set<string>();
    for (const order of visibleOrders) {
      const wooLineItems = extractWooLineItemsFromOrder(order);
      const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
      for (const line of lines) {
        const ids = extractOrderLineImageKey(line);
        if (!ids) continue;
        if (queued.has(ids.key)) continue;
        queued.add(ids.key);
        void ensureOrderLineImageLoaded(line, wooLineItems);
        if (queued.size >= 40) {
          return;
        }
      }
    }
  }, [
    welcomeOpen,
    accountTab,
    cachedAccountOrders,
    showCanceledOrders,
    ensureOrderLineImageLoaded,
    extractWooLineItemsFromOrder,
    extractOrderLineImageKey,
    isCanceledOrRefundedStatus,
  ]);

  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'orders' || !selectedOrder) {
      return;
    }
    const wooLineItems = extractWooLineItemsFromOrder(selectedOrder);
    const lines = Array.isArray(selectedOrder.lineItems) ? selectedOrder.lineItems : [];
    lines.forEach((line) => {
      void ensureOrderLineImageLoaded(line, wooLineItems);
    });
  }, [welcomeOpen, accountTab, selectedOrder, ensureOrderLineImageLoaded, extractWooLineItemsFromOrder]);

  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'orders' || !selectedOrder) {
      return;
    }
    const trackingNumber = resolveTrackingNumber(selectedOrder);
    if (!trackingNumber) {
      return;
    }

    const cached = trackingStatusCacheRef.current.get(trackingNumber);
    if (cached) {
      setSelectedOrder((prev) => {
        if (!prev) return prev;
        const integrationDetails = (prev.integrationDetails && typeof prev.integrationDetails === 'object')
          ? prev.integrationDetails
          : {};
        const existing = (integrationDetails as any)?.carrierTracking || (integrationDetails as any)?.carrier_tracking || null;
        if (existing?.trackingStatus) {
          return prev;
        }
        return {
          ...prev,
          integrationDetails: {
            ...(integrationDetails as any),
            carrierTracking: cached,
          },
        };
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const api = await import('../services/api');
        const info = await api.trackingAPI.getStatus(trackingNumber);
        if (cancelled || !info) return;
        trackingStatusCacheRef.current.set(trackingNumber, info);
        setSelectedOrder((prev) => {
          if (!prev) return prev;
          const integrationDetails = (prev.integrationDetails && typeof prev.integrationDetails === 'object')
            ? prev.integrationDetails
            : {};
          return {
            ...prev,
            integrationDetails: {
              ...(integrationDetails as any),
              carrierTracking: info,
            },
          };
        });
      } catch {
        // non-fatal
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [welcomeOpen, accountTab, selectedOrder?.id]);

  const handleCopyReferralCode = useCallback(async () => {
    if (!primaryReferralCode) return;
    try {
      if (!navigator?.clipboard) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(primaryReferralCode);
      setReferralCopied(true);
      if (referralCopyTimeout.current) {
        clearTimeout(referralCopyTimeout.current);
      }
      referralCopyTimeout.current = setTimeout(() => {
        setReferralCopied(false);
      }, 2000);
    } catch (error) {
      setReferralCopied(false);
    }
  }, [primaryReferralCode]);

  const renderCartButton = () => {
    if (!(Number(cartItems) > 0)) {
      return null;
    }
    return (
      <div className="relative inline-flex flex-shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCartClick}
          className="header-cart-button inline-flex glass squircle-sm transition-all duration-300"
        >
          {delegateMode ? (
            <ClipboardDocumentListIcon className="h-4 w-4" />
          ) : (
            <ShoppingCart className="h-4 w-4" />
          )}
        </Button>
        <Badge
          variant="outline"
          className="absolute -top-2 -right-2 header-count-indicator flex h-5 w-5 items-center justify-center p-0 squircle-sm border border-[var(--brand-glass-border-2)] text-[rgb(95,179,249)]"
        >
          {cartItems}
        </Badge>
      </div>
    );
  };

  const renderSearchField = (
    inputClassName = '',
    options?: {
      value?: string;
      readOnly?: boolean;
      showClearButton?: boolean;
      borderColor?: string | null;
    },
  ) => (
    <div
      className="relative"
      style={{
        '--header-search-border-color': options?.borderColor || (delegateMode ? secondaryColor : undefined),
      } as CSSProperties}
    >
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform !text-slate-500"
        style={{ color: delegateMode ? secondaryColor : 'rgb(100, 116, 139)' }}
      />
      <Input
        type="text"
        inputMode="search"
        enterKeyHint="search"
        placeholder="Search peptides..."
        value={options && typeof options.value === 'string' ? options.value : searchQuery}
        onChange={(e) => {
          if (options?.readOnly) return;
          handleSearchChange(e.target.value);
        }}
        ref={options?.readOnly ? undefined : searchInputRef}
        className={`header-search-input squircle-sm !h-[2.4rem] !min-h-[2.4rem] !max-h-[2.4rem] box-border pl-10 pr-12 placeholder:text-slate-500 focus-visible:outline-none focus-visible:!ring-0 ${inputClassName}`.trim()}
        style={{
          minWidth: '100%',
          color: delegateMode ? secondaryColor : undefined,
          caretColor: delegateMode ? secondaryColor : undefined,
        }}
        readOnly={Boolean(options?.readOnly)}
      />
		      {(options?.showClearButton ?? true) && searchQuery.trim().length > 0 && (
		        <button
		          type="button"
		          aria-label="Clear search"
	          onClick={() => {
            handleSearchChange('');
            requestAnimationFrame(() => {
	              searchInputRef.current?.focus();
	            });
	          }}
	          className="absolute right-3 left-auto top-1/2 z-10 -translate-y-1/2 rounded-full p-1 text-slate-900/70 transition-colors hover:bg-white/50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.4)]"
            style={{ right: '0.75rem', left: 'auto' }}
	        >
	          <X className="h-4 w-4" />
	        </button>
	      )}
    </div>
  );

  const normalizedRole = String((localUser as any)?.role || '').toLowerCase();
  const normalizedPatientLinksDoctorUserIds = new Set(
    Array.isArray(patientLinksDoctorUserIds)
      ? patientLinksDoctorUserIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  );
  const showPatientLinksTab = Boolean(
    localUser && (
      normalizedRole === 'test_doctor'
      || (
        normalizedRole === 'doctor'
        && (
          isNodePatientLinkDummyMode
          || (
            patientLinksEnabled
            && normalizedPatientLinksDoctorUserIds.has(String((localUser as any)?.id || '').trim())
          )
        )
      )
    ),
  );
  const accountHeaderTabs = useMemo(() => {
    const tabs: Array<{ id: AccountTabId; label: string; Icon: any }> = [
      { id: 'details', label: 'Details', Icon: Info },
      { id: 'orders', label: 'Orders', Icon: Package },
    ];
    if (showPatientLinksTab) {
      tabs.push({ id: 'patient_links', label: 'Delegate Links', Icon: Link2 });
    }
    tabs.push({ id: 'research', label: 'Research', Icon: Users });
    return tabs;
  }, [showPatientLinksTab]);

  const accountTabDescriptionById: Record<AccountTabId, string> = {
    details: 'Update your profile, shipping info, and settings.',
    orders: 'Track your orders, reorders, and invoices.',
    patient_links: 'Manage delegate sessions and proposals.',
    research: 'Where you will soon find research tools and resources.',
  };

  const normalizeMarkupPercent = useCallback((value: unknown) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    const clamped = Math.max(0, parsed);
    return Math.round((clamped + Number.EPSILON) * 100) / 100;
  }, []);

  const normalizeMarkupDraftText = useCallback((raw: string) => {
    const input = typeof raw === 'string' ? raw : String(raw ?? '');
    const stripped = input.replace(/%/g, '').replace(/[^\d.]/g, '');
    const dotIndex = stripped.indexOf('.');
    if (dotIndex === -1) {
      return stripped;
    }
    const head = stripped.slice(0, dotIndex + 1);
    const tail = stripped.slice(dotIndex + 1).replace(/\./g, '');
    return `${head}${tail}`;
  }, []);

  const loadPatientLinks = useCallback(async () => {
    if (!showPatientLinksTab) {
      return;
    }
    if (patientLinksLoadInFlightRef.current) {
      return;
    }
    patientLinksLoadInFlightRef.current = true;
    setPatientLinksLoading(true);
    setPatientLinksError(null);
    try {
      const api = await import('../services/api');
      const response = await api.delegationAPI.listLinks();
      const links = Array.isArray((response as any)?.links) ? (response as any).links : [];
      const config = (response as any)?.config || {};
      const markupPercent = normalizeMarkupPercent((config as any).markupPercent ?? (config as any).markup_percent ?? 0);
      const defaultExpiryHoursRaw =
        typeof (config as any).defaultExpiryHours === 'number'
          ? (config as any).defaultExpiryHours
          : Number((config as any).defaultExpiryHours ?? (config as any).default_expiry_hours ?? 72);
      const defaultExpiryHours = Number.isFinite(defaultExpiryHoursRaw) && defaultExpiryHoursRaw > 0
        ? Math.round(defaultExpiryHoursRaw)
        : 72;
      const sanitizedLinks = links.filter((link: any) => {
        const token = typeof (link as any)?.token === 'string' ? (link as any).token.trim() : '';
        return !token.startsWith('node-ui-dummy-link');
      });
      if (isNodePatientLinkDummyMode) {
        setPatientLinks([
          ...createNodeDummyPatientLinks(localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null),
          ...sanitizedLinks,
        ]);
      } else {
        setPatientLinks(sanitizedLinks);
      }
      setPatientLinkMarkupDraft(String(markupPercent));
      setPatientLinkExpiryHoursDraft(String(defaultExpiryHours));
    } catch (error: any) {
      const status = typeof error?.status === 'number' ? error.status : null;
      const delegationRouteMissing = status === 404 || status === 405;
      if (delegationRouteMissing && isNodePatientLinkDummyMode) {
        setPatientLinks(createNodeDummyPatientLinks(localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null));
        setPatientLinkMarkupDraft('15');
        setPatientLinkExpiryHoursDraft('72');
        setPatientLinksError(null);
        return;
      }
      if (isNodePatientLinkDummyMode) {
        setPatientLinks(createNodeDummyPatientLinks(localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null));
        setPatientLinkMarkupDraft('15');
        setPatientLinkExpiryHoursDraft('72');
        setPatientLinksError(null);
        return;
      }
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'Unable to load delegate links right now.';
      setPatientLinksError(message);
      setPatientLinks([]);
    } finally {
      setPatientLinksLoading(false);
      patientLinksLoadInFlightRef.current = false;
    }
  }, [localUser?.name, localUser?.zelleContact, normalizeMarkupPercent, showPatientLinksTab, user?.name]);

  useEffect(() => {
    if (!Array.isArray(patientLinks) || patientLinks.length === 0) {
      return;
    }

    setPatientLinkPaymentMethodDraftByToken((prev) => {
      const next: Record<string, PatientLinkPaymentMethod> = { ...prev };
      for (const link of patientLinks) {
        const token = typeof (link as any)?.token === 'string' ? String((link as any).token).trim() : '';
        if (!token || next[token]) continue;
        const raw =
          (link as any)?.paymentMethod ??
          (link as any)?.payment_method ??
          (link as any)?.payment_method_id ??
          null;
        next[token] = normalizePatientLinkPaymentMethod(raw);
      }
      return next;
    });

    setPatientLinkInstructionsDraftByToken((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const link of patientLinks) {
        const token = typeof (link as any)?.token === 'string' ? String((link as any).token).trim() : '';
        if (!token || typeof next[token] === 'string') continue;
        const method = normalizePatientLinkPaymentMethod(
          (link as any)?.paymentMethod ?? (link as any)?.payment_method ?? null,
        );
        const raw =
          (link as any)?.paymentInstructions ??
          (link as any)?.payment_instructions ??
          (link as any)?.instructions ??
          (link as any)?.delegateInstructions ??
          (link as any)?.delegate_instructions ??
          null;
        const text = typeof raw === 'string' ? raw : '';
        next[token] = text.trim()
          ? text
          : buildPatientLinkDefaultInstructions(method, localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null);
      }
      return next;
    });

    setPatientLinkReviewNotesDraftByToken((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const link of patientLinks) {
        const token = typeof (link as any)?.token === 'string' ? String((link as any).token).trim() : '';
        if (!token || typeof next[token] === 'string') continue;
        const raw =
          (link as any)?.delegateReviewNotes ??
          (link as any)?.proposalReviewNotes ??
          (link as any)?.delegate_review_notes ??
          (link as any)?.proposal_review_notes ??
          null;
        next[token] = typeof raw === 'string' ? raw : '';
      }
      return next;
    });
  }, [localUser?.name, localUser?.zelleContact, patientLinks, user?.name]);

  const handleSavePatientLinkPaymentSettings = useCallback(
    async (token: string) => {
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!normalized || patientLinksSavingPaymentToken) {
        return;
      }
      const paymentMethodDraft = patientLinkPaymentMethodDraftByToken[normalized] ?? 'none';
      const paymentInstructionsDraft = (patientLinkInstructionsDraftByToken[normalized] ?? '').trim();
      const paymentMethod = paymentMethodDraft === 'zelle' ? 'zelle' : '';
      const paymentInstructions = paymentMethod === 'zelle'
        ? (paymentInstructionsDraft || buildPatientLinkDefaultInstructions('zelle', localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null))
        : '';

      setPatientLinksSavingPaymentToken(normalized);
      try {
        const api = await import('../services/api');
        await api.delegationAPI.updateLink(normalized, {
          paymentMethod,
          paymentInstructions,
        });
        toast.success('Payment settings saved.');
        await loadPatientLinks();
      } catch (error: any) {
        toast.error(
          typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : 'Unable to save payment settings right now.',
        );
      } finally {
        setPatientLinksSavingPaymentToken(null);
      }
    },
    [
      loadPatientLinks,
      localUser?.name,
      localUser?.zelleContact,
      patientLinkInstructionsDraftByToken,
      patientLinkPaymentMethodDraftByToken,
      patientLinksSavingPaymentToken,
      user?.name,
    ],
  );

  const outstandingPatientProposalCount = useMemo(() => {
    return (patientLinks || []).reduce((count, link) => {
      const revokedAtRaw =
        (typeof (link as any)?.revokedAt === 'string' && (link as any).revokedAt.trim())
          ? (link as any).revokedAt.trim()
          : (typeof (link as any)?.revoked_at === 'string' && (link as any).revoked_at.trim())
            ? (link as any).revoked_at.trim()
            : '';
      if (revokedAtRaw) return count;
      const delegateSharedAt =
        (typeof (link as any)?.delegateSharedAt === 'string' && (link as any).delegateSharedAt.trim())
          ? (link as any).delegateSharedAt.trim()
          : (typeof (link as any)?.delegate_shared_at === 'string' && (link as any).delegate_shared_at.trim())
            ? (link as any).delegate_shared_at.trim()
            : '';
      const delegateOrderId =
        (typeof (link as any)?.delegateOrderId === 'string' && (link as any).delegateOrderId.trim())
          ? (link as any).delegateOrderId.trim()
          : (typeof (link as any)?.delegate_order_id === 'string' && (link as any).delegate_order_id.trim())
            ? (link as any).delegate_order_id.trim()
            : '';
      const delegateReviewStatusRaw =
        (typeof (link as any)?.delegateReviewStatus === 'string' && (link as any).delegateReviewStatus.trim())
          ? (link as any).delegateReviewStatus.trim().toLowerCase()
          : (typeof (link as any)?.delegate_review_status === 'string' && (link as any).delegate_review_status.trim())
            ? (link as any).delegate_review_status.trim().toLowerCase()
            : '';
      const proposalStatusRaw =
        (typeof (link as any)?.proposalStatus === 'string' && (link as any).proposalStatus.trim())
          ? (link as any).proposalStatus.trim().toLowerCase()
          : (typeof (link as any)?.proposal_status === 'string' && (link as any).proposal_status.trim())
            ? (link as any).proposal_status.trim().toLowerCase()
            : '';

      const reviewStatus = delegateReviewStatusRaw || proposalStatusRaw;
      const hasSession = Boolean(
        reviewStatus
        || delegateSharedAt
        || delegateOrderId
        || (typeof (link as any)?.token === 'string' && (link as any).token.trim()),
      );
      const proposalStatus = reviewStatus || (hasSession ? 'pending' : '');
      const isOutstanding =
        hasSession
        && proposalStatus !== 'approved'
        && proposalStatus !== 'accepted'
        && proposalStatus !== 'rejected';
      return count + (isOutstanding ? 1 : 0);
    }, 0);
  }, [patientLinks]);

  const accountTabIndicatorCounts = useMemo<Partial<Record<AccountTabId, number>>>(() => {
    const counts: Partial<Record<AccountTabId, number>> = {};
    if (showPatientLinksTab && outstandingPatientProposalCount > 0) {
      counts.patient_links = outstandingPatientProposalCount;
    }
    return counts;
  }, [outstandingPatientProposalCount, showPatientLinksTab]);

  const accountButtonIndicatorTotal = useMemo(
    () => Object.values(accountTabIndicatorCounts).reduce((sum, count) => sum + (Number(count) || 0), 0),
    [accountTabIndicatorCounts],
  );

  useEffect(() => {
    onAccountIndicatorTotalChange?.(accountButtonIndicatorTotal);
  }, [accountButtonIndicatorTotal, onAccountIndicatorTotalChange]);

  useEffect(() => {
    if (!showPatientLinksTab) {
      patientLinksPrefetchedRef.current = false;
      return;
    }
    if (patientLinksPrefetchedRef.current) {
      return;
    }
    patientLinksPrefetchedRef.current = true;
    void loadPatientLinks();
  }, [loadPatientLinks, showPatientLinksTab]);

  const lastPatientLinksRefreshTokenRef = useRef(patientLinksRefreshToken);

  useEffect(() => {
    if (!showPatientLinksTab) {
      return;
    }
    if (patientLinksRefreshToken === lastPatientLinksRefreshTokenRef.current) {
      return;
    }
    lastPatientLinksRefreshTokenRef.current = patientLinksRefreshToken;
    void loadPatientLinks();
  }, [loadPatientLinks, patientLinksRefreshToken, showPatientLinksTab]);

  const handleCreatePatientLink = useCallback(async () => {
    if (!showPatientLinksTab || patientLinksCreating) {
      return;
    }
    if (!patientLinkTermsAccepted) {
      toast.error('Accept the terms to continue.');
      return;
    }
    setPatientLinksCreating(true);
    try {
      const api = await import('../services/api');
      const zelleContact = zelleContactDraft.trim();
      const savedZelleContact =
        typeof localUser?.zelleContact === 'string' ? localUser.zelleContact.trim() : '';
      if (zelleContact !== savedZelleContact) {
        const updatedUser = await api.authAPI.updateMe({
          zelleContact: zelleContact ? zelleContact : null,
        });
        const nextUserState: HeaderUser = {
          ...(localUser || {}),
          ...(updatedUser || {}),
          zelleContact: zelleContact ? zelleContact : null,
        };
        setLocalUser(nextUserState);
        onUserUpdated?.(nextUserState);
      }
      const subjectLabel = patientLinkSubjectLabelDraft.trim();
      const studyLabel = patientLinkStudyLabelDraft.trim();
      const patientReference = patientLinkReferenceDraft.trim();
      const markupPercent = normalizeMarkupPercent(patientLinkMarkupDraft);
      const expiresInHours = Number(patientLinkExpiryHoursDraft);
      const usageLimit = patientLinkUsageLimitDraft.trim() ? Number(patientLinkUsageLimitDraft) : null;
      const paymentMethod = patientLinkPaymentMethodDraft === 'zelle' ? 'zelle' : '';
      const paymentInstructionsDraft = patientLinkInstructionsDraft.trim();
      const paymentInstructions = paymentMethod === 'zelle'
        ? (paymentInstructionsDraft || buildPatientLinkDefaultInstructions('zelle', zelleContact || null, localUser?.name ?? user?.name ?? null))
        : '';
      await api.delegationAPI.createLink({
        patientId: subjectLabel ? subjectLabel : null,
        subjectLabel: subjectLabel ? subjectLabel : null,
        studyLabel: studyLabel ? studyLabel : null,
        patientReference: patientReference ? patientReference : null,
        referenceLabel: patientReference ? patientReference : studyLabel ? studyLabel : null,
        markupPercent,
        instructions: patientLinkResearchNoteDraft.trim() ? patientLinkResearchNoteDraft.trim() : null,
        expiresInHours: Number.isFinite(expiresInHours) && expiresInHours > 0 ? expiresInHours : null,
        usageLimit: usageLimit && Number.isFinite(usageLimit) && usageLimit > 0 ? usageLimit : null,
        paymentMethod,
        paymentInstructions,
        physicianCertified: patientLinkTermsAccepted,
      });
      setPatientLinkSubjectLabelDraft('');
      setPatientLinkStudyLabelDraft('');
      setPatientLinkReferenceDraft('');
      setPatientLinkUsageLimitDraft('');
      setPatientLinkResearchNoteDraft('');
      setPatientLinkTermsAccepted(false);
      toast.success('Delegate link created.');
      await loadPatientLinks();
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to create a delegate link right now.',
      );
    } finally {
      setPatientLinksCreating(false);
    }
  }, [
    loadPatientLinks,
    normalizeMarkupPercent,
    patientLinkExpiryHoursDraft,
    patientLinkMarkupDraft,
    patientLinkReferenceDraft,
    patientLinkResearchNoteDraft,
    patientLinkStudyLabelDraft,
    patientLinkSubjectLabelDraft,
    patientLinkTermsAccepted,
    patientLinkInstructionsDraft,
    patientLinkPaymentMethodDraft,
    patientLinkUsageLimitDraft,
    patientLinksCreating,
    localUser?.name,
    localUser?.zelleContact,
    onUserUpdated,
    setLocalUser,
    showPatientLinksTab,
    user?.name,
    zelleContactDraft,
  ]);

  const getPatientLinkUrl = useCallback((token: string): string => {
    if (typeof window === 'undefined') return '';
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) return '';
    return buildResearchSupplyLinkUrl(window.location.origin, normalized, localUser?.name ?? user?.name ?? null);
  }, [localUser?.name, user?.name]);

  const openLegalDocument = useCallback((key: 'terms' | 'shipping' | 'privacy') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('peppro:open-legal', {
        detail: { key, preserveDialogs: true },
      }),
    );
  }, []);

  const trackUsageEvent = useCallback((event: string, metadata?: Record<string, unknown>) => {
    const normalizedEvent = typeof event === 'string' ? event.trim() : '';
    if (!normalizedEvent) return;
    void import('../services/api')
      .then((api) => api.usageTrackingAPI.track({ event: normalizedEvent, metadata: metadata || {} }))
      .catch((error) => {
        if (import.meta.env.DEV && typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[usage-tracking] Failed to record event', {
            event: normalizedEvent,
            error,
          });
        }
      });
  }, []);

  const trackPatientLinkFieldEntry = useCallback((field: string, value: string) => {
    const normalizedField = typeof field === 'string' ? field.trim() : '';
    const normalizedValue = typeof value === 'string' ? value.trim() : '';
    if (!normalizedField || !normalizedValue) {
      return;
    }
    if (patientLinkTrackedFieldsRef.current.has(normalizedField)) {
      return;
    }
    patientLinkTrackedFieldsRef.current.add(normalizedField);
    trackUsageEvent('delegate_link_text_field_entry', { field: normalizedField });
  }, [trackUsageEvent]);

  const handleCopyPatientLink = useCallback(async (token: string) => {
    const url = getPatientLinkUrl(token);
    if (!url) return;
    try {
      if (!navigator?.clipboard) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('Unable to copy link.');
    }
  }, [getPatientLinkUrl]);

  const handleViewPatientLink = useCallback((token: string) => {
    if (typeof window === 'undefined') return;
    const url = getPatientLinkUrl(token);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [getPatientLinkUrl]);

  const handleRevokePatientLink = useCallback(async (token: string) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized || patientLinksUpdatingToken) {
      return;
    }
    setPatientLinksUpdatingToken(normalized);
    try {
      const api = await import('../services/api');
      await api.delegationAPI.updateLink(normalized, { revoke: true });
      toast.success('Link revoked.');
      await loadPatientLinks();
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to revoke link right now.',
      );
    } finally {
      setPatientLinksUpdatingToken(null);
    }
  }, [loadPatientLinks, patientLinksUpdatingToken]);

  const handleDeletePatientLink = useCallback(async (token: string) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized || patientLinksDeletingToken) {
      return;
    }
    setPatientLinksDeletingToken(normalized);
    try {
      const api = await import('../services/api');
      await api.delegationAPI.updateLink(normalized, { delete: true });
      toast.success('Link deleted.');
      await loadPatientLinks();
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to delete link right now.',
      );
    } finally {
      setPatientLinksDeletingToken(null);
    }
  }, [loadPatientLinks, patientLinksDeletingToken]);

  const handleSetPatientLinkPaymentReceived = useCallback(
    async (token: string, received: boolean) => {
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!normalized || patientLinksPaymentReceivedToken) {
        return;
      }
      setPatientLinksPaymentReceivedToken(normalized);
      try {
        const api = await import('../services/api');
        await api.delegationAPI.updateLink(normalized, { receivedPayment: received ? 1 : 0 });
        toast.success(received ? 'Marked as paid.' : 'Marked as unpaid.');
        await loadPatientLinks();
      } catch (error: any) {
        toast.error(
          typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : 'Unable to update payment status right now.',
        );
      } finally {
        setPatientLinksPaymentReceivedToken(null);
      }
    },
    [loadPatientLinks, patientLinksPaymentReceivedToken],
  );

  const [patientLinksProposalToken, setPatientLinksProposalToken] = useState<string | null>(null);

  const handleViewPatientProposal = useCallback(
    async (token: string) => {
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!normalized || patientLinksProposalToken) {
        return;
      }
      setPatientLinksProposalToken(normalized);
      try {
        const api = await import('../services/api');
        const response = await api.delegationAPI.getLinkProposal(normalized);
	        const proposal = (response as any)?.proposal ?? null;
	        const cart = proposal?.delegateCart ?? proposal?.delegate_cart ?? null;
	        const shipping = proposal?.delegateShipping ?? proposal?.delegate_shipping ?? null;
	        const items = Array.isArray(cart?.items) ? cart.items : [];
	        if (!items.length) {
	          throw new Error('No proposal items found for this link.');
	        }
	        const shippingAddress =
	          shipping?.shippingAddress ??
	          shipping?.shipping_address ??
	          cart?.shippingAddress ??
	          cart?.shipping_address ??
	          null;
          const shippingRateCandidates = [
            shipping?.shippingEstimate,
            shipping?.shipping_estimate,
            shipping?.shippingRate,
            shipping?.shipping_rate,
            shipping?.rate,
            shipping?.selectedRate,
            shipping?.selected_rate,
            cart?.shippingEstimate,
            cart?.shipping_estimate,
            cart?.shippingRate,
            cart?.shipping_rate,
          ];
          const shippingRate =
            shippingRateCandidates.find((candidate) => {
              if (!candidate || typeof candidate !== 'object') return false;
              const raw = candidate as Record<string, unknown>;
              const keys = Object.keys(raw);
              if (!keys.length) return false;
              const carrier = raw.carrierId ?? raw.carrier_id ?? raw.carrierCode ?? raw.carrier_code ?? raw.carrier;
              const service = raw.serviceCode ?? raw.service_code ?? raw.serviceType ?? raw.service_type ?? raw.service;
              const amount = raw.rate ?? raw.amount ?? raw.cost ?? raw.price ?? raw.shippingTotal ?? raw.shipping_total;
              return Boolean(
                (typeof carrier === 'string' && carrier.trim())
                || (typeof service === 'string' && service.trim())
                || (amount != null && Number.isFinite(Number(amount))),
              );
            }) ?? null;
		        if (typeof onLoadDelegateProposal === 'function') {
		          const markupPercentRaw =
		            typeof proposal?.markupPercent === 'number'
		              ? proposal.markupPercent
		              : typeof proposal?.markupPercent === 'string'
		                ? Number(proposal.markupPercent)
		                : typeof proposal?.markup_percent === 'number'
		                  ? proposal.markup_percent
		                  : typeof proposal?.markup_percent === 'string'
		                    ? Number(proposal.markup_percent)
		                    : null;
		          const markupPercent = typeof markupPercentRaw === 'number' && Number.isFinite(markupPercentRaw)
		            ? markupPercentRaw
		            : null;
		          onLoadDelegateProposal({
		            token: normalized,
		            items,
		            markupPercent,
		            delegateOrderId:
	              typeof proposal?.delegateOrderId === 'string'
	                ? proposal.delegateOrderId
	                : typeof proposal?.delegate_order_id === 'string'
	                  ? proposal.delegate_order_id
	                  : null,
	            sharedAt:
	              typeof proposal?.delegateSharedAt === 'string'
	                ? proposal.delegateSharedAt
	                : typeof proposal?.delegate_shared_at === 'string'
	                  ? proposal.delegate_shared_at
	                  : null,
	            shippingAddress,
              shippingRate,
	          });
		        }
		        toast.success('Proposal loaded into your cart.');
	      } catch (error: any) {
	        toast.error(
	          typeof error?.message === 'string' && error.message.trim()
	            ? error.message
            : 'Unable to load proposal right now.',
        );
      } finally {
        setPatientLinksProposalToken(null);
      }
    },
    [onLoadDelegateProposal, patientLinksProposalToken],
  );

  const handleRejectPatientProposal = useCallback(
    async (token: string) => {
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!normalized || patientLinksProposalToken) {
        return;
      }
      setPatientLinksProposalToken(normalized);
      try {
        const api = await import('../services/api');
        await api.delegationAPI.reviewLinkProposal(normalized, { status: 'rejected' });
        toast.success('Proposal rejected.');
        await loadPatientLinks();
      } catch (error: any) {
        toast.error(
          typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : 'Unable to reject proposal right now.',
        );
      } finally {
        setPatientLinksProposalToken(null);
      }
    },
    [loadPatientLinks, patientLinksProposalToken],
  );

  const handleSavePatientLinkReviewNotes = useCallback(
    async (token: string, currentStatus?: string | null) => {
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!normalized || patientLinksSavingReviewNotesToken) {
        return;
      }
      const normalizedStatus = typeof currentStatus === 'string' && currentStatus.trim()
        ? currentStatus.trim().toLowerCase()
        : 'pending';
      const notes = (patientLinkReviewNotesDraftByToken[normalized] ?? '').trim();

      setPatientLinksSavingReviewNotesToken(normalized);
      try {
        const api = await import('../services/api');
        await api.delegationAPI.reviewLinkProposal(normalized, {
          status: normalizedStatus,
          notes,
        });
        toast.success('Proposal notes saved.');
        await loadPatientLinks();
      } catch (error: any) {
        toast.error(
          typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : 'Unable to save proposal notes right now.',
        );
      } finally {
        setPatientLinksSavingReviewNotesToken(null);
      }
    },
    [loadPatientLinks, patientLinkReviewNotesDraftByToken, patientLinksSavingReviewNotesToken],
  );

  const saveProfileField = useCallback(
    async (label: string, payload: Record<string, string | null>) => {
      const toastId = `profile-field:${label.toLowerCase().replace(/\s+/g, '-')}`;
      try {
        const api = await import('../services/api');
        const updated = await api.authAPI.updateMe(payload);

        const normalizedPayload = Object.fromEntries(
          Object.entries(payload).map(([key, value]) => {
            if (typeof value === 'string') {
              const trimmed = value.trim();
              return [key, trimmed.length > 0 ? trimmed : null];
            }
            return [key, value];
          }),
        );

        const nextUserState: HeaderUser = {
          ...(localUser || {}),
          ...(updated || {}),
        };

        Object.entries(normalizedPayload).forEach(([key, value]) => {
          const serverValue = updated ? (updated as Record<string, unknown>)[key] : undefined;
          const shouldUsePayload =
            serverValue === undefined
            || serverValue === null
            || (typeof serverValue === 'string' && serverValue.trim().length === 0);

          if (shouldUsePayload) {
            (nextUserState as Record<string, unknown>)[key] = value;
          }
        });

        setLocalUser(nextUserState);
        onUserUpdated?.(nextUserState);
        toast.success(`${label} updated`, { id: toastId });
      } catch (error: any) {
        if (error?.status === 413) {
          toast.error('Upload too large. Please choose a smaller image.', { id: toastId });
        } else if (error?.message === 'EMAIL_EXISTS') {
          toast.error('That email is already in use.', { id: toastId });
        } else {
          toast.error('Update failed', { id: toastId });
        }
        throw error;
      }
    },
    [setLocalUser, onUserUpdated, localUser],
  );

  const delegateLogoInputRef = useRef<HTMLInputElement | null>(null);
  const [delegateLogoUploading, setDelegateLogoUploading] = useState(false);
  const [delegateSecondaryColorSaving, setDelegateSecondaryColorSaving] = useState(false);

  const downscaleImageDataUrl = useCallback(async (
    dataUrl: string,
    maxWidthPx: number,
    maxHeightPx: number,
  ) => {
    const safeMaxWidth = Number.isFinite(maxWidthPx) ? Math.max(16, Math.min(2048, Math.floor(maxWidthPx))) : 480;
    const safeMaxHeight = Number.isFinite(maxHeightPx) ? Math.max(16, Math.min(2048, Math.floor(maxHeightPx))) : 128;
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'eager';

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
      img.src = dataUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) {
      throw new Error('IMAGE_DIMENSIONS_INVALID');
    }

    const scale = Math.min(1, safeMaxWidth / srcW, safeMaxHeight / srcH);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    if (dstW === srcW && dstH === srcH) {
      return dataUrl;
    }

    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('CANVAS_CONTEXT_UNAVAILABLE');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, dstW, dstH);
    ctx.drawImage(img, 0, 0, dstW, dstH);

    const outputMime = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    return canvas.toDataURL(outputMime, outputMime === 'image/jpeg' ? 0.85 : undefined);
  }, []);

  const handleSelectDelegateLogo = useCallback(async (file: File | null) => {
    if (!file || delegateLogoUploading) {
      return;
    }
    const currentDelegateSecondaryColor =
      normalizeDelegateSecondaryColor(localUser?.delegateSecondaryColor ?? null) || DEFAULT_DELEGATE_SECONDARY_COLOR;
    const maxBytes = 5_000_000;
    if (file.size > maxBytes) {
      toast.error('Image is too large. Please choose a smaller file.');
      return;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      toast.error('Please choose an image file.');
      return;
    }
    setDelegateLogoUploading(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
        reader.readAsDataURL(file);
      });
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        throw new Error('INVALID_IMAGE');
      }
      try {
        const { moderationAPI } = await import('../services/api');
        const resp = await moderationAPI.checkImage({ dataUrl, purpose: 'delegate_logo' });
        if (resp?.flagged) {
          const proceed = window.confirm(
            'This image may contain inappropriate content. Please choose a different image.\n\nContinue anyway?',
          );
          if (!proceed) {
            toast.error('Upload canceled.');
            return;
          }
        }
      } catch {
        // Soft-fail moderation checks; never block uploads if moderation is unavailable.
      }
	      // Match the header logo slot (2x for crispness on retina).
	      const resized = await downscaleImageDataUrl(
	        dataUrl,
	        isLargeScreen ? 960 : 840,
	        isLargeScreen ? 112 : 96,
	      );
      await saveProfileField('Delegate branding', {
        delegateLogoUrl: resized,
        delegateSecondaryColor: currentDelegateSecondaryColor,
      });
    } catch (error) {
      // saveProfileField handles toasts
    } finally {
      setDelegateLogoUploading(false);
      if (delegateLogoInputRef.current) {
        delegateLogoInputRef.current.value = '';
      }
    }
	  }, [delegateLogoUploading, downscaleImageDataUrl, isLargeScreen, localUser?.delegateSecondaryColor, saveProfileField]);

  const handleRemoveDelegateLogo = useCallback(async () => {
    if (delegateLogoUploading) return;
    const currentDelegateSecondaryColor =
      normalizeDelegateSecondaryColor(localUser?.delegateSecondaryColor ?? null) || DEFAULT_DELEGATE_SECONDARY_COLOR;
    setDelegateLogoUploading(true);
    try {
      await saveProfileField('Delegate branding', {
        delegateLogoUrl: null,
        delegateSecondaryColor: currentDelegateSecondaryColor,
      });
    } catch (error) {
      // saveProfileField handles toasts
    } finally {
      setDelegateLogoUploading(false);
    }
  }, [delegateLogoUploading, localUser?.delegateSecondaryColor, saveProfileField]);

  const handleDelegateSecondaryColorChange = useCallback(async (value: string) => {
    const normalized = normalizeDelegateSecondaryColor(value) || DEFAULT_DELEGATE_SECONDARY_COLOR;
    const current = normalizeDelegateSecondaryColor(localUser?.delegateSecondaryColor ?? null) || DEFAULT_DELEGATE_SECONDARY_COLOR;
    if (delegateSecondaryColorSaving || normalized === current) {
      return;
    }
    setDelegateSecondaryColorSaving(true);
    try {
      await saveProfileField('Delegate session color', { delegateSecondaryColor: normalized });
    } catch {
      // saveProfileField handles toasts
    } finally {
      setDelegateSecondaryColorSaving(false);
    }
  }, [delegateSecondaryColorSaving, localUser?.delegateSecondaryColor, saveProfileField]);

  useEffect(() => {
    if (!showPatientLinksTab && accountTab === 'patient_links') {
      setAccountTab('details');
    }
  }, [accountTab, showPatientLinksTab]);

  const identityFields: Array<{ key: 'name' | 'email' | 'phone'; label: string; type?: string; autoComplete?: string }> = [
    { key: 'name', label: 'Full Name', autoComplete: 'name' },
    { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
    { key: 'phone', label: 'Phone', autoComplete: 'tel' },
  ];

  const directShippingFields: Array<{ key: DirectShippingField; label: string; type?: string; autoComplete?: string }> = [
    { key: 'officeAddressLine1', label: 'Street', autoComplete: 'shipping address-line1' },
    { key: 'officeAddressLine2', label: 'Suite / Unit', autoComplete: 'shipping address-line2' },
    { key: 'officeCity', label: 'City', autoComplete: 'shipping address-level2' },
    { key: 'officeState', label: 'State', autoComplete: 'shipping address-level1' },
    { key: 'officePostalCode', label: 'Postal Code', autoComplete: 'shipping postal-code' },
  ];

  const accountInfoPanel = localUser ? (
    <div className="space-y-4">
      <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Contact Info</h2>
          <p className="text-sm text-slate-600">Manage your account and shipping information below.</p>
        </div>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-start pt-2">
          <div className="flex flex-col gap-3 sm:min-w-[220px] sm:max-w-[260px]">
            <div className="avatar-shell" onClick={() => avatarInputRef.current?.click()}>
              {renderAvatar(72)}
              <button
                type="button"
                className="avatar-edit-badge"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowAvatarControls((prev) => !prev);
                }}
                aria-label="Edit profile photo"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>

            {showAvatarControls && (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-800">Profile photo</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="header-home-button squircle-sm bg-white text-slate-900"
                    disabled={avatarUploading}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {avatarUploading ? `Uploading… ${avatarUploadPercent}%` : 'Upload photo'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="squircle-sm"
                    disabled={avatarUploading || !profileImageUrl}
                    onClick={() => {
                      void (async () => {
                        try {
                          await saveProfileField('Profile photo', { profileImageUrl: null });
                          if (avatarInputRef.current) {
                            avatarInputRef.current.value = '';
                          }
                        } catch {
                          // Error toast is handled by saveProfileField.
                        }
                      })();
                    }}
                  >
                    Remove
                  </Button>
                  <p className="text-xs text-slate-500">Photos must be 50MB or smaller in size.</p>
                </div>
              </div>
            )}

            <input
              type="file"
              accept="image/*"
              ref={avatarInputRef}
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const maxBytes = 50 * 1024 * 1024; // 50MB limit
                if (file.size > maxBytes) {
                  toast.error('Upload too large. Please choose an image 50MB or smaller.');
                  if (avatarInputRef.current) {
                    avatarInputRef.current.value = '';
                  }
                  return;
                }
                setAvatarUploading(true);
                setAvatarUploadPercent(8);
                let uploadTicker: number | null = null;
                try {
                  console.info('[Profile] Compressing image before upload', { sizeBytes: file.size, name: file.name });
                  const dataUrl = await compressImageToDataUrl(file, { maxSize: 1600, quality: 0.82 });
                  setAvatarUploadPercent(55);

                  try {
                    // Lightweight client-side heuristic: if the browser supports FaceDetector and
                    // no faces are detected, warn the user before uploading.
                    const FaceDetectorCtor = (window as any)?.FaceDetector;
                    if (FaceDetectorCtor) {
                      const img = new Image();
                      img.decoding = 'async';
                      await new Promise<void>((resolve, reject) => {
                        img.onload = () => resolve();
                        img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
                        img.src = dataUrl;
                      });
                      const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 3 });
                      const faces = await detector.detect(img);
                      if (!faces || faces.length === 0) {
                        const proceed = window.confirm(
                          'No face was detected in this image. If this is intentional, you can continue.\n\nContinue uploading?',
                        );
                        if (!proceed) {
                          toast.error('Upload canceled.');
                          return;
                        }
                      }
                    }
                  } catch {
                    // ignore
                  }

                  try {
                    const { moderationAPI } = await import('../services/api');
                    const resp = await moderationAPI.checkImage({ dataUrl, purpose: 'profile_photo' });
                    if (resp?.flagged) {
                      const proceed = window.confirm(
                        'This image may contain inappropriate content. Please choose a different image.\n\nContinue anyway?',
                      );
                      if (!proceed) {
                        toast.error('Upload canceled.');
                        return;
                      }
                    }
                  } catch {
                    // Soft-fail moderation checks; never block uploads if moderation is unavailable.
                  }

                  // Simulated progress while request is in-flight
                  const startProgress = 60;
                  const targetProgress = 95;
                  let current = startProgress;
                  uploadTicker = window.setInterval(() => {
                    current = Math.min(targetProgress, current + 2);
                    setAvatarUploadPercent(current);
                  }, 120);

                  await saveProfileField('Profile photo', { profileImageUrl: dataUrl });
                  setAvatarUploadPercent(100);
                  setShowAvatarControls(false);
                } catch (error: any) {
                  // saveProfileField already emits canonical upload/update toasts.
                  const message = typeof error?.message === 'string' ? error.message : 'Upload failed';
                  console.error('[Profile] Upload failed', { message, error });
                } finally {
                  if (uploadTicker) {
                    window.clearInterval(uploadTicker);
                  }
                  setAvatarUploading(false);
                  setAvatarUploadPercent(0);
                  if (avatarInputRef.current) {
                    avatarInputRef.current.value = '';
                  }
                }
              }}
            />
          </div>

          {canShowReferralCode && primaryReferralCode && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Referral Code</label>
              <div
                className="flex items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800"
              >
                <span className="tracking-[0.16em] uppercase">
                  {primaryReferralCode}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="squircle-sm text-xs"
                  onClick={handleCopyReferralCode}
                >
                  Copy
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Share this code with physicians to link them to your account. Editing is disabled for security.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-1">
            {identityFields.map(({ key, label, type, autoComplete }) => (
              <EditableRow
                key={key}
                label={label}
                value={(localUser?.[key] as string | null) || ''}
                type={type || 'text'}
                autoComplete={autoComplete}
                onSave={async (next) => {
                  await saveProfileField(label, { [key]: next });
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Direct Shipping</h3>
          <p className="text-sm text-slate-600">Update the address where orders should ship.</p>
        </div>

        <div className="grid gap-3">
          {directShippingFields.map(({ key, label, autoComplete }) => (
            <EditableRow
              key={key}
              label={label}
              value={(localUser?.[key] as string | null) || ''}
              autoComplete={autoComplete}
              onSave={async (next) => {
                await saveProfileField(label, { [key]: next });
              }}
            />
          ))}
        </div>
      </div>

	      <div className="pt-1">
	        <button
	          type="button"
	          onClick={() => setDeleteAccountModalOpen(true)}
	          className="text-sm font-medium !text-[rgb(95,179,249)] transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.35)] focus-visible:ring-offset-2"
	          style={{ color: 'rgb(95, 179, 249)', marginLeft: '16px' }}
	        >
	          Need to delete your account?
	        </button>
	      </div>
    </div>
  ) : null;

  const researchPlaceholderPanel = (
    <div
      ref={researchPanelRef}
      className="glass-card squircle-md p-6 border border-[var(--brand-glass-border-2)] text-center space-y-3 bg-white"
    >
      <h3 className="text-base font-semibold text-slate-800">Research</h3>
      <p className="text-sm text-slate-600">
        This section is currently in development. Soon you&apos;ll be able to access research tools and resources here to share your findings securely and anonymously with the PepPro network of physicians.
      </p>
    </div>
  );

  const researchWipPanel = (
    <div
      ref={researchPanelRef}
      className={clsx(
        "transition-all duration-300 ease-in-out bg-white",
        researchDashboardExpanded && "h-full w-full min-h-full",
        researchDashboardExpanded ? "h-full flex flex-col" : "space-y-4",
      )}
    >
      <div className="flex">
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-[rgb(95,179,249)] shadow-[0_10px_18px_-12px_rgba(15,23,42,0.35)] transition-colors hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.35)]"
          aria-label={
            researchDashboardExpanded
              ? 'Exit full screen Research dashboard'
              : 'Expand Research dashboard to full screen'
          }
          onClick={toggleResearchOverlay}
        >
          {researchDashboardExpanded ? (
            <Minimize2 className="h-4 w-4" aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
          ) : (
            <Maximize2 className="h-4 w-4" aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
          )}
        </button>
      </div>
    </div>
  );

  const effectiveRole = localUser?.role || user?.role || null;
  const canSeeResearchWip =
    isAdmin(effectiveRole)
    || normalizeRole(effectiveRole) === 'test_doctor'
    || (researchDashboardEnabled === true && (isDoctorRole(effectiveRole) || isRep(effectiveRole)));

  const researchPanel = canSeeResearchWip ? researchWipPanel : researchPlaceholderPanel;
  const normalizeDelegateLabel = (value: unknown) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '';
  };
  const formatDelegateOrderLabel = (value: unknown): string => {
    const trimmed = normalizeDelegateLabel(value);
    if (!trimmed) return '';

    const normalized = trimmed
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isGenericLabel =
      normalized === 'label'
      || normalized === 'delegate'
      || normalized === 'delegate order';
    if (isGenericLabel) return 'Delegate order';

    const delegatePrefix = trimmed.match(/^delegate\s*:\s*(.+)$/i);
    if (delegatePrefix && delegatePrefix[1]?.trim()) {
      return `Delegate: ${delegatePrefix[1].trim()}`;
    }

    const delegateOf = trimmed.match(/^delegate\s+of\s+(.+)$/i);
    if (delegateOf && delegateOf[1]?.trim()) {
      return `Delegate: ${delegateOf[1].trim()}`;
    }

    return `Delegate: ${trimmed}`;
  };
  const resolveDelegateOrderLabel = (order: any): string => {
    const direct =
      normalizeDelegateLabel(order?.as_delegate)
      || normalizeDelegateLabel(order?.asDelegate);
    if (direct) return formatDelegateOrderLabel(direct);

    const integrationDetails = parseMaybeJson(order?.integrationDetails);
    const integrations = parseMaybeJson(order?.integrations);
    const wooIntegration =
      parseMaybeJson(integrationDetails?.wooCommerce || integrationDetails?.woocommerce)
      || parseMaybeJson(integrations?.wooCommerce || integrations?.woocommerce)
      || {};
    const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
    const wooPayload = parseMaybeJson(wooIntegration?.payload) || {};

    const nested =
      normalizeDelegateLabel(wooIntegration?.as_delegate)
      || normalizeDelegateLabel(wooIntegration?.asDelegate)
      || normalizeDelegateLabel(wooResponse?.as_delegate)
      || normalizeDelegateLabel(wooResponse?.asDelegate)
      || normalizeDelegateLabel(wooPayload?.as_delegate)
      || normalizeDelegateLabel(wooPayload?.asDelegate)
      // SQL persistence can surface in integration details depending on hydration path.
      || normalizeDelegateLabel(integrationDetails?.mysql?.order?.as_delegate)
      || normalizeDelegateLabel(integrationDetails?.mysql?.order?.asDelegate)
      || normalizeDelegateLabel(integrations?.mysql?.order?.as_delegate)
      || normalizeDelegateLabel(integrations?.mysql?.order?.asDelegate);

    return formatDelegateOrderLabel(nested);
  };
  const normalizeOrderIdentifierToken = (value: unknown): string => {
    const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!raw) return '';
    let normalized = raw;
    if (normalized.startsWith('#')) normalized = normalized.slice(1).trim();
    if (normalized.toLowerCase().startsWith('woo-')) {
      const parts = normalized.split('-', 2);
      normalized = parts.length === 2 ? parts[1].trim() : normalized;
    }
    return normalized.toLowerCase();
  };
  const normalizeReferenceLabel = (value: unknown): string => {
    const raw = normalizeDelegateLabel(value);
    if (!raw) return '';
    return raw
      .replace(/^delegate\s*:\s*/i, '')
      .replace(/^delegate\s+of\s+/i, '')
      .trim()
      .toLowerCase();
  };
  const buildOrderToPatientLinkTarget = useCallback((order: any) => {
    const integrations = parseMaybeJson(order?.integrationDetails || order?.integrations) || {};
    const wooIntegration = parseMaybeJson(integrations?.wooCommerce || integrations?.woocommerce) || {};
    const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
    const wooPayload = parseMaybeJson(wooIntegration?.payload) || {};

    const readMetaValue = (meta: any, keys: string[]) => {
      if (!Array.isArray(meta)) return '';
      const normalizedKeys = new Set(
        keys.map((key) => String(key || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')),
      );
      const match = meta.find((entry: any) => {
        const key = String(entry?.key || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        return normalizedKeys.has(key);
      });
      return normalizeDelegateLabel(match?.value);
    };

    const rawDelegateTokenCandidates = [
      order?.delegateProposalToken,
      order?.delegate_proposal_token,
      order?.delegationToken,
      order?.delegation_token,
      order?.proposalToken,
      order?.proposal_token,
      integrations?.delegateProposalToken,
      integrations?.delegate_proposal_token,
      wooIntegration?.delegateProposalToken,
      wooIntegration?.delegate_proposal_token,
      wooResponse?.delegateProposalToken,
      wooResponse?.delegate_proposal_token,
      wooPayload?.delegateProposalToken,
      wooPayload?.delegate_proposal_token,
      readMetaValue(wooResponse?.meta_data, [
        'delegate_proposal_token',
        'proposal_token',
        'delegation_token',
        'peppro_delegate_proposal_token',
      ]),
      readMetaValue(wooPayload?.meta_data, [
        'delegate_proposal_token',
        'proposal_token',
        'delegation_token',
        'peppro_delegate_proposal_token',
      ]),
    ];
    const delegateTokens = Array.from(
      new Set(
        rawDelegateTokenCandidates
          .map((value) => normalizeDelegateLabel(value))
          .filter(Boolean),
      ),
    );

    const orderIds = Array.from(
      new Set(
        [
          order?.wooOrderId,
          order?.woo_order_id,
          order?.wooOrderNumber,
          order?.woo_order_number,
          order?.number,
          order?.id,
          wooIntegration?.wooOrderId,
          wooIntegration?.wooOrderNumber,
          wooResponse?.id,
          wooResponse?.number,
          wooPayload?.id,
          wooPayload?.number,
        ]
          .map((value) => normalizeOrderIdentifierToken(value))
          .filter(Boolean),
      ),
    );

    const referenceLabels = Array.from(
      new Set(
        [
          resolveDelegateOrderLabel(order),
          order?.asDelegate,
          order?.as_delegate,
          order?.delegateOrderLabel,
          order?.delegate_order_label,
        ]
          .map((value) => normalizeReferenceLabel(value))
          .filter(Boolean),
      ),
    );

    return { delegateTokens, orderIds, referenceLabels };
  }, []);
  const findMatchingPatientLinkToken = useCallback(
    (
      target: { delegateTokens: string[]; orderIds: string[]; referenceLabels: string[] } | null,
      links: any[],
    ): string | null => {
      if (!target || !Array.isArray(links) || links.length === 0) return null;

      const normalizedLinkTokenEntries = links
        .map((link) => {
          const token = normalizeDelegateLabel((link as any)?.token);
          return { token, link };
        })
        .filter((entry) => entry.token);

      for (const token of target.delegateTokens) {
        const matched = normalizedLinkTokenEntries.find((entry) => entry.token === token);
        if (matched) return matched.token;
      }

      for (const entry of normalizedLinkTokenEntries) {
        const delegateOrderId = normalizeOrderIdentifierToken(
          (entry.link as any)?.delegateOrderId ?? (entry.link as any)?.delegate_order_id,
        );
        if (delegateOrderId && target.orderIds.includes(delegateOrderId)) {
          return entry.token;
        }
      }

      for (const entry of normalizedLinkTokenEntries) {
        const referenceLabel = normalizeReferenceLabel(
          (entry.link as any)?.referenceLabel
          ?? (entry.link as any)?.reference_label
          ?? (entry.link as any)?.label,
        );
        if (referenceLabel && target.referenceLabels.includes(referenceLabel)) {
          return entry.token;
        }
      }

      return null;
    },
    [],
  );
  const handleDelegateLabelNavigateToPatientLink = useCallback((order: any) => {
    if (!showPatientLinksTab) return;
    const target = buildOrderToPatientLinkTarget(order);
    if (
      target.delegateTokens.length === 0
      && target.orderIds.length === 0
      && target.referenceLabels.length === 0
    ) {
      toast.message('No associated delegate link was found for this order.');
      return;
    }
    setAccountTab('patient_links');
    setPendingPatientLinkScrollTarget(target);
    if (!patientLinksLoadInFlightRef.current) {
      void loadPatientLinks();
    }
  }, [buildOrderToPatientLinkTarget, loadPatientLinks, showPatientLinksTab]);

  useEffect(() => {
    return () => {
      if (patientLinkHighlightTimeoutRef.current) {
        clearTimeout(patientLinkHighlightTimeoutRef.current);
        patientLinkHighlightTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!welcomeOpen) {
      setPendingPatientLinkScrollTarget(null);
    }
  }, [welcomeOpen]);

  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'patient_links' || !pendingPatientLinkScrollTarget) {
      return;
    }
    if (patientLinksLoading || patientLinksLoadInFlightRef.current) {
      return;
    }

    const matchedToken = findMatchingPatientLinkToken(pendingPatientLinkScrollTarget, patientLinks);
    if (!matchedToken) {
      if (!Array.isArray(patientLinks) || patientLinks.length === 0) {
        return;
      }
      setPendingPatientLinkScrollTarget(null);
      toast.message('Associated delegate link was not found in your current links.');
      return;
    }

    requestAnimationFrame(() => {
      const targetEl = patientLinkRowRefs.current[matchedToken];
      if (!targetEl) return;
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('patient-link-item--highlight');
      if (patientLinkHighlightTimeoutRef.current) {
        clearTimeout(patientLinkHighlightTimeoutRef.current);
      }
      patientLinkHighlightTimeoutRef.current = setTimeout(() => {
        targetEl.classList.remove('patient-link-item--highlight');
      }, 1600);
    });

    setPendingPatientLinkScrollTarget(null);
  }, [
    accountTab,
    findMatchingPatientLinkToken,
    patientLinks,
    patientLinksLoading,
    pendingPatientLinkScrollTarget,
    welcomeOpen,
  ]);

		  const renderOrdersList = () => {
		    const repView = false;
		    const doctorView = Boolean(isDoctorRole(accountRole));
		    const salesRepEmail = (localUser?.salesRep?.email || '').trim();
        const normalizedQuery = ordersSearchQuery.trim().toLowerCase();
        const renderOrdersLoadingState = () => (
          <div className="space-y-4 pb-4" aria-live="polite" aria-busy="true">
            {Array.from({ length: 2 }).map((_, index) => (
              <div
                key={`account-order-skeleton-${index}`}
                className="account-order-card squircle-lg bg-white border border-[#d5d9d9] overflow-hidden"
              >
                <div className="px-6 py-4 bg-[#f5f6f6] border-b border-[#d5d9d9]">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-8 text-sm text-slate-700">
                      <div className="space-y-2">
                        <div className="news-loading-line news-loading-shimmer w-24" />
                        <div className="news-loading-line news-loading-shimmer w-28" />
                      </div>
                      <div className="space-y-2">
                        <div className="news-loading-line news-loading-shimmer w-16" />
                        <div className="news-loading-line news-loading-shimmer w-20" />
                      </div>
                      <div className="space-y-2">
                        <div className="news-loading-line news-loading-shimmer w-20" />
                        <div className="news-loading-line news-loading-shimmer w-32" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="news-loading-line news-loading-shimmer w-28" />
                      <div className="news-loading-line news-loading-shimmer w-24" />
                    </div>
                  </div>
                </div>
                <div className="px-6 pt-5 pb-6">
                  <div className="flex flex-col gap-4 pt-4 md:flex-row md:items-start md:gap-6">
                    <div className="space-y-4 flex-1 min-w-0">
                      <div className="space-y-2">
                        <div className="news-loading-line news-loading-shimmer w-40" />
                        <div className="news-loading-line news-loading-shimmer w-32" />
                      </div>
                      <div className="space-y-3">
                        {Array.from({ length: 2 }).map((__, lineIdx) => (
                          <div
                            key={`account-order-skeleton-line-${index}-${lineIdx}`}
                            className="flex items-center gap-4 min-h-[60px]"
                          >
                            <div className="h-[60px] w-20 rounded-xl border border-[#d5d9d9] bg-white overflow-hidden flex-shrink-0">
                              <div className="h-full w-full bg-slate-100" />
                            </div>
                            <div className="flex-1 space-y-2">
                              <div className="news-loading-line news-loading-shimmer w-48" />
                              <div className="news-loading-line news-loading-shimmer w-20" />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="w-full md:w-auto md:min-w-[12rem] space-y-3">
                      <div className="h-9 w-full rounded-[10px] bg-slate-100" />
                      <div className="h-9 w-full rounded-[10px] bg-slate-100" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
		    const visibleOrders = cachedAccountOrders
	      .filter((order) => {
        const source = (order.source || '').toLowerCase();
        const hasWooIntegration = Boolean(
          (order.integrationDetails as any)?.wooCommerce ||
          (order.integrationDetails as any)?.woocommerce,
        );
        return source === 'woocommerce' || source === 'peppro' || source === 'local' || hasWooIntegration;
      })
      .filter((order) => {
        const status = String(order.status || '').toLowerCase().trim();
        return status !== 'delegation_draft';
      })
      .filter((order) => {
        if (showCanceledOrders) {
          return true;
        }
        return !isCanceledOrRefundedStatus(order.status);
      })
      .filter((order) => {
        if (!normalizedQuery) {
          return true;
        }

        const integrationDetails = parseMaybeJson((order as any).integrationDetails);
        const wooIntegration = parseMaybeJson(integrationDetails?.wooCommerce || integrationDetails?.woocommerce);
        const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
        const wooOrderNumber =
          normalizeStringField(order.wooOrderNumber) ||
          normalizeStringField(wooResponse?.number) ||
          normalizeStringField(wooIntegration?.wooOrderNumber) ||
          normalizeStringField(order.number) ||
          normalizeStringField(order.id) ||
          '';
        const trackingNumber = resolveTrackingNumber(order);
        const lineItemNames = (order.lineItems || [])
          .map((line) => (line?.name || '').toString())
          .filter(Boolean)
          .join(' ');
        const haystack = [
          wooOrderNumber,
          order.status || '',
          trackingNumber || '',
          lineItemNames,
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(normalizedQuery);
      });

    if (accountOrdersLoading && cachedAccountOrders.length === 0) {
      return renderOrdersLoadingState();
    }

    if (!visibleOrders.length) {
      return (
        <div className="text-center py-12">
          <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] inline-block">
            <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
            <p className="text-sm font-medium text-slate-700 mb-1">No orders found</p>
            <p className="text-xs text-slate-500">Your recent orders will appear here</p>
          </div>
        </div>
      );
    }

	    return (
	      <div className="space-y-4 pb-4">
	      {visibleOrders.map((order) => {
	        const status = describeOrderStatus(order);
	        const trackingNumber = resolveTrackingNumber(order);
	        const statusDisplay = trackingNumber ? `${status} - ${trackingNumber}` : status;
            const statusNormalized = String(order.status || '').trim().toLowerCase();
            const statusNormalizedKey = statusNormalized.replace(/_/g, '-');
            const isCanceled = statusNormalized.includes('cancel') || statusNormalized.includes('refund') || statusNormalized === 'trash';
            const isProcessing = statusNormalized.includes('processing');
            const canCancel =
              !repView &&
              Boolean(onCancelOrder) &&
              (CANCELLABLE_ORDER_STATUSES.has(statusNormalized) || CANCELLABLE_ORDER_STATUSES.has(statusNormalizedKey)) &&
              !isCanceled;
            const cancellationKey =
              order.cancellationId ||
              order.wooOrderId ||
              (order.id ? String(order.id) : null);
            const isCanceling = Boolean(
              cancellationKey && cancellingOrderId === cancellationKey
            );
            const wooOrderNumber =
              normalizeStringField(order.wooOrderNumber) ||
              normalizeStringField((order.integrationDetails as any)?.wooCommerce?.response?.number) ||
              normalizeStringField((order.integrationDetails as any)?.wooCommerce?.wooOrderNumber) ||
              normalizeStringField((order.integrationDetails as any)?.woocommerce?.response?.number) ||
              normalizeStringField((order.integrationDetails as any)?.woocommerce?.wooOrderNumber) ||
              null;
            const orderNumberValue = wooOrderNumber || order.number || order.id || 'Order';
            const orderNumberLabel = `Order #${orderNumberValue}`;
            const itemCount = order.lineItems?.length ?? 0;
            const showItemCount = itemCount > 0 && (isProcessing || !isCanceled);
            const integrationDetails = parseMaybeJson((order as any).integrationDetails);
            const wooIntegration = parseMaybeJson(integrationDetails?.wooCommerce || integrationDetails?.woocommerce);
            const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
            const wooPayload = parseMaybeJson(wooIntegration?.payload) || {};
            const delegateOrderLabel = resolveDelegateOrderLabel(order as any);
            const showDelegateOrderLabel = Boolean(delegateOrderLabel);
            const wooShippingLine =
              (wooResponse?.shipping_lines && wooResponse.shipping_lines[0]) ||
              (wooPayload?.shipping_lines && wooPayload.shipping_lines[0]);
            const wooLineItems = Array.isArray(wooResponse?.line_items)
              ? wooResponse.line_items
              : Array.isArray(wooPayload?.line_items)
                ? wooPayload.line_items
                : [];
            const expectedDelivery = formatExpectedDelivery(order);
            const showExpectedDelivery = Boolean(
              expectedDelivery &&
              (isShipmentInTransit(order.status) ||
                (order.status || '').toLowerCase() === 'completed')
            );
            const summedLineItems = (order.lineItems || []).reduce((sum, line) => {
              const lineTotal = parseWooMoney(line.total, parseWooMoney(line.subtotal, 0));
              return sum + lineTotal;
            }, 0);
            const wooMeta = Array.isArray(wooResponse?.meta_data)
              ? wooResponse.meta_data
              : Array.isArray(wooPayload?.meta_data)
                ? wooPayload.meta_data
                : [];
            const findWooMetaValue = (key: string) => {
              if (!key) return null;
              const normalizedKey = String(key).trim().toLowerCase();
              const match = Array.isArray(wooMeta)
                ? wooMeta.find((entry: any) => String(entry?.key || '').trim().toLowerCase() === normalizedKey)
                : null;
              return match?.value ?? null;
            };
            const discountCodeAmountFromWoo = findWooMetaValue('peppro_discount_code_amount');
            const discountCodeAmount = Math.abs(
              parseWooMoney(
                (order as any).discountCodeAmount,
                parseWooMoney(discountCodeAmountFromWoo, 0),
              ),
            );
            const appliedReferralCreditRaw = parseWooMoney((order as any).appliedReferralCredit, 0);
            const appliedReferralCredit = Math.abs(appliedReferralCreditRaw);
            const hasExplicitDiscounts = discountCodeAmount > 0 || appliedReferralCredit > 0;

            const fallbackSubtotal = summedLineItems > 0
              ? summedLineItems
              : parseWooMoney(wooResponse?.subtotal ?? wooPayload?.subtotal, 0);

            const hasStoredItemsSubtotal = (order as any).itemsSubtotal != null || (order as any).itemsTotal != null;
            const storedItemsSubtotal = hasStoredItemsSubtotal
              ? parseWooMoney((order as any).itemsSubtotal ?? (order as any).itemsTotal, 0)
              : 0;
            const originalItemsSubtotal = parseWooMoney(
              (order as any).originalItemsSubtotal,
              Math.max(0, storedItemsSubtotal || fallbackSubtotal) + discountCodeAmount,
            );
            const effectiveItemsSubtotal = hasStoredItemsSubtotal
              ? storedItemsSubtotal
              : hasExplicitDiscounts
                ? Math.max(0, originalItemsSubtotal - discountCodeAmount)
                : fallbackSubtotal;
            const shippingValue = parseWooMoney(
              order.shippingTotal,
              parseWooMoney(
                wooResponse?.shipping_total ??
                  wooPayload?.shipping_total ??
                  wooShippingLine?.total,
                0,
              ),
            );
            const taxValue = parseWooMoney(
              order.taxTotal,
              parseWooMoney(wooResponse?.total_tax ?? wooPayload?.total_tax, 0),
            );
            const legacyDiscountValueRaw = parseWooMoney(
              wooResponse?.discount_total ??
                wooPayload?.discount_total ??
                (wooPayload?.discount_lines?.[0]?.total ?? 0),
              0,
            );
            const legacyDiscountValue = Math.abs(legacyDiscountValueRaw);
            const discountValue = hasExplicitDiscounts ? appliedReferralCredit : legacyDiscountValue;
            const storedGrandTotal = parseWooMoney(
              (order as any).grandTotal,
              parseWooMoney(
                (order as any).total,
                parseWooMoney(wooResponse?.total ?? wooPayload?.total, 0),
              ),
            );
            const computedGrandTotal = effectiveItemsSubtotal + shippingValue + taxValue - discountValue;
            const baseTotal = storedGrandTotal > 0 ? storedGrandTotal : computedGrandTotal;
            const displayTotal =
              taxValue > 0 && computedGrandTotal > baseTotal + 0.01
                ? computedGrandTotal
                : baseTotal;
            const itemLabel = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
            
          return (
            <div
              key={`${order.source}-${order.id}`}
              className="account-order-card squircle-lg bg-white border border-[#d5d9d9] overflow-hidden"
            >
              {/* Order Header */}
              <div className="px-6 py-4 bg-[#f5f6f6] border-b border-[#d5d9d9]">
                <div className="order-header-main flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="order-header-meta flex flex-wrap items-center gap-8 text-sm text-slate-700">
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Order placed</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {formatOrderDate(resolveOrderPlacedAt(order))}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Total</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {formatCurrency(displayTotal, order.currency || 'USD')}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Status</p>
                      <p className="order-status-row flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                        <span>{statusDisplay}</span>
                        {showDelegateOrderLabel && (
                          <button
                            type="button"
                            className="sales-account-indicator-badge squircle-sm"
                            onClick={() => handleDelegateLabelNavigateToPatientLink(order as any)}
                            title="Open associated delegate link"
                          >
                            {delegateOrderLabel}
                          </button>
                        )}
                      </p>
                    </div>
                    {showExpectedDelivery && (
                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Expected delivery</p>
                        <p className="text-sm font-semibold text-slate-900">{expectedDelivery}</p>
                      </div>
                    )}
                  </div>
                  <div className="order-header-actions flex flex-row items-end gap-3 text-sm">
                    <div className="flex flex-wrap items-center justify-end gap-3">
                      {(() => {
                        const integrations = order.integrations || integrationDetails;
                        const wooIntegration =
                          (integrations as any)?.wooCommerce ||
                          (integrations as any)?.woocommerce ||
                          null;
                        const invoiceOrderId =
                          order.wooOrderId ||
                          wooIntegration?.wooOrderId ||
                          order.wooOrderNumber ||
                          wooIntegration?.wooOrderNumber ||
                          null;
                        const hasWooInvoice = Boolean(
                          invoiceOrderId ||
                            (integrationDetails as any)?.wooCommerce?.wooOrderId ||
                            (integrationDetails as any)?.woocommerce?.wooOrderId,
                        );

                        if (!hasWooInvoice) {
                          return null;
                        }

                        return (
                          <>
                            <button
                              type="button"
                              className="text-[rgb(26,85,173)] font-semibold hover:underline"
                              onClick={() => void downloadInvoiceForOrder(order)}
                            >
                              Download invoice
                            </button>
                            |
                          </>
                        );
                      })()}
                      <button
                        type="button"
                        className="text-[rgb(26,85,173)] font-semibold hover:underline"
                        onClick={() => setSelectedOrder(order)}
                      >
                        View order details
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Order Body */}
              <div className="px-6 pt-5 pb-6">
                <div className="order-card-body flex flex-col gap-4 pt-4 md:flex-row md:items-start md:gap-6">
                  <div className="space-y-4 flex-1 min-w-0">
	                    <div className="order-number-row flex flex-wrap items-start justify-between gap-3">
	                      <div className="flex-1 min-w-0 space-y-1">
		                        <p className="text-base font-bold text-slate-900 break-words">
		                          <span className="mr-2">{orderNumberLabel}</span>
		                          {showItemCount && (
		                            <span className="text-slate-700 font-semibold">
		                              {itemLabel}
		                            </span>
		                          )}
		                        </p>
	                          {repView && (order.doctorName || order.doctorEmail) && (
	                            <p className="text-sm text-slate-700 break-words">
	                              <span className="font-semibold">
	                                {order.doctorName || "Physician"}
	                              </span>
	                              {order.doctorEmail ? ` — ${order.doctorEmail}` : ""}
	                            </p>
	                          )}
			                      </div>
		                    </div>

	                    {order.lineItems && order.lineItems.length > 0 && (
	                      <div className="space-y-3">
	                        {order.lineItems.map((line, idx) => {
	                          const ids = extractOrderLineImageKey(line);
	                          const cachedImage = ids ? orderLineImageCache[ids.key] : null;
	                          const lineImage =
	                            typeof cachedImage === 'string' && cachedImage.trim().length > 0
	                              ? cachedImage
	                              : resolveOrderLineImage(line, wooLineItems);
		                          return (
		                            <div
		                              key={line.id || `${line.sku}-${idx}`}
		                              className="order-line-item flex items-center gap-4 mb-4 min-h-[60px]"
		                            >
                              <div
                                className="h-full min-h-[60px] w-20 rounded-xl border border-[#d5d9d9] bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0"
                                style={{ maxHeight: '120px' }}
                              >
                                {lineImage ? (
                                  <img
                                    src={lineImage}
                                    alt={line.name || 'Item thumbnail'}
                                    className="object-contain"
                                    style={{ width: '100%', height: '100%', maxHeight: '120px' }}
                                    onError={(event) => {
                                      event.currentTarget.style.display = 'none';
                                    }}
                                  />
                                ) : (
                                  <Package className="h-6 w-6 opacity-60" />
                                )}
                              </div>
                              <div className="flex-1 space-y-1">
                                <p className="text-[rgb(26,85,173)] font-semibold leading-snug">
                                  {line.name || 'Item'}
                                </p>
                                <p className="text-sm text-slate-700">
                                  Qty: {line.quantity ?? '—'}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
	                  <div className="order-card-actions flex flex-col gap-2 items-stretch text-center justify-start w-full pb-2 md:items-end md:gap-6 md:w-auto md:min-w-[12rem] md:text-right md:self-stretch md:ml-auto">
	                    {typeof order.notes === 'string' && order.notes.trim().length > 0 && (
	                      <div className="w-full text-left md:text-left rounded-lg border border-slate-200 bg-white/70 px-3 py-2">
	                        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
	                          Notes
	                        </div>
	                        <div className="mt-1 text-sm text-slate-700 whitespace-pre-wrap max-h-24 overflow-auto">
	                          {formatTimestampedNotesForDisplay(order.notes)}
	                        </div>
	                      </div>
	                    )}
	                    <Button
	                      type="button"
	                      size="sm"
	                      variant="outline"
	                      className="header-home-button squircle-sm bg-white text-slate-900 px-6 justify-center font-semibold gap-2 w-full lg:w-full"
	                      onClick={() => {
	                        if (onBuyOrderAgain) {
	                          // Close account modal before opening checkout to avoid stacked modal blur.
	                          setWelcomeOpen(false);
	                          setTimeout(() => onBuyOrderAgain(order), 0);
	                        } else {
	                          setSelectedOrder(order);
	                        }
	                      }}
	                    >
	                      {repView ? (
	                        <Eye className="h-4 w-4" aria-hidden="true" />
	                      ) : (
	                        <ShoppingCart className="h-4 w-4" aria-hidden="true" />
	                      )}
	                      {repView ? 'View order' : 'Buy it again'}
	                    </Button>
                    {canCancel && (
                      <button
                        type="button"
                        disabled={isCanceling}
                        onClick={() => {
                          if (!isCanceling) {
                            const targetId = cancellationKey || order.id;
                            if (targetId) {
                              handleCancelOrderClick(targetId);
                            }
                          }
                        }}
                        className="order-cancel-button squircle-sm inline-flex h-9 w-full items-center justify-center px-6 py-0 text-center font-semibold disabled:cursor-not-allowed disabled:opacity-60 lg:w-full"
                      >
                        {isCanceling ? 'Canceling…' : 'Cancel order'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
	          );
	        })}
	        {doctorView && (
		          <div className="glass-card squircle-lg border border-[var(--brand-glass-border-2)] bg-white/80 px-7 py-4 text-sm text-slate-700">
		            <div className="px-4 space-y-1">
		              {salesRepEmail && (
		                <p>
		                  Sales rep:{' '}
	                  <a
	                    href={`mailto:${salesRepEmail}`}
	                    className="underline hover:text-[rgb(95,179,249)]"
	                  >
	                    {salesRepEmail}
	                  </a>
	                </p>
	              )}
	              <p>
	                Support:{' '}
	                <a
	                  href="mailto:support@peppro.net"
	                  className="underline hover:text-[rgb(95,179,249)]"
	                >
	                  support@peppro.net
	                </a>
	              </p>
	            </div>
	          </div>
	        )}
	      </div>
	    );
	  };

  const renderOrderDetails = () => {
    if (!selectedOrder) return null;
    const isOrderDetailHydrating = Boolean(accountOrdersLoading);
    const integrationDetails = parseMaybeJson((selectedOrder as any).integrationDetails);
    const wooIntegration = parseMaybeJson(integrationDetails?.wooCommerce || integrationDetails?.woocommerce);
    const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
    const wooPayload = parseMaybeJson(wooIntegration?.payload) || {};
    const wooShippingLine =
      (wooResponse?.shipping_lines && wooResponse.shipping_lines[0]) ||
      (wooPayload?.shipping_lines && wooPayload.shipping_lines[0]);
    const wooLineItems = Array.isArray(wooResponse?.line_items)
      ? wooResponse.line_items
      : Array.isArray(wooPayload?.line_items)
        ? wooPayload.line_items
        : [];

    const expectedDelivery = formatExpectedDelivery(selectedOrder);
    const showExpectedDeliveryDetails = Boolean(
      expectedDelivery && (isShipmentInTransit(selectedOrder.status) || !selectedOrder.status),
    );
    const normalizedStatus = String(selectedOrder.status || '').trim().toLowerCase();
    const expectedShipmentWindow =
      (selectedOrder as any).expectedShipmentWindow ||
      (selectedOrder as any).expected_shipment_window ||
      null;
    const showExpectedShipmentWindow = Boolean(
      expectedShipmentWindow && !(normalizedStatus === 'shipped' && Boolean(resolveTrackingNumber(selectedOrder))),
    );
    const shippingMethod =
      formatShippingMethod(selectedOrder.shippingEstimate) ||
      titleCase(wooShippingLine?.method_title || wooShippingLine?.method_id);
    const shippingRate =
      selectedOrder.shippingEstimate?.rate ??
      (wooShippingLine && typeof wooShippingLine.total === 'string' ? Number(wooShippingLine.total) : undefined);

    const wooShippingAddress = convertWooAddress(wooResponse?.shipping || wooPayload?.shipping);
    const wooBillingAddress = convertWooAddress(wooResponse?.billing || wooPayload?.billing);
    const trackingNumber = resolveTrackingNumber(selectedOrder);
    const wooService = wooShippingLine?.method_title || wooShippingLine?.method_id || '';
    const carrierCode =
      selectedOrder.shippingEstimate?.carrierId ||
      integrationDetails?.shipStation?.carrierCode ||
      (wooService?.toLowerCase().includes('ups') ? 'ups' : null);
    const trackingHref = trackingNumber ? buildTrackingUrl(trackingNumber, carrierCode) : null;

    const shippingAddress =
      parseAddress(selectedOrder.shippingAddress) ||
      parseAddress((selectedOrder as any).shipping) ||
      wooShippingAddress ||
      parseAddress(selectedOrder.billingAddress);
    const billingAddressBase =
      parseAddress(selectedOrder.billingAddress) ||
      wooBillingAddress ||
      parseAddress(selectedOrder.shippingAddress);
    const shippingRecipientName = typeof shippingAddress?.name === 'string'
      ? shippingAddress.name.trim()
      : '';
    const billingAddress =
      billingAddressBase && shippingRecipientName
        ? { ...billingAddressBase, name: shippingRecipientName }
        : billingAddressBase;
    const lineItems = selectedOrder.lineItems || [];
    const summedLineItems = lineItems.reduce((sum, line) => {
      const lineTotal = parseWooMoney(line.total, parseWooMoney(line.subtotal, 0));
      return sum + lineTotal;
    }, 0);
    const stripeMeta = parseMaybeJson(integrationDetails?.stripe || (integrationDetails as any)?.Stripe) || {};
    const itemsSubtotalEffective = parseWooMoney(
      (selectedOrder as any).itemsSubtotal ?? (selectedOrder as any).itemsTotal,
      summedLineItems > 0
        ? summedLineItems
        : parseWooMoney(
            wooResponse.total ?? wooPayload.total ?? wooResponse.subtotal ?? wooPayload.subtotal,
            0,
          ),
    );
    const wooMeta = Array.isArray(wooResponse?.meta_data)
      ? wooResponse.meta_data
      : Array.isArray(wooPayload?.meta_data)
        ? wooPayload.meta_data
        : [];
    const findWooMetaValue = (key: string) => {
      if (!key) return null;
      const normalizedKey = String(key).trim().toLowerCase();
      const match = Array.isArray(wooMeta)
        ? wooMeta.find((entry: any) => String(entry?.key || '').trim().toLowerCase() === normalizedKey)
        : null;
      return match?.value ?? null;
    };
    const discountCodeFromWoo = findWooMetaValue('peppro_discount_code');
    const discountCodeAmountFromWoo = findWooMetaValue('peppro_discount_code_amount');
    const discountCode = String(
      (selectedOrder as any).discountCode ?? discountCodeFromWoo ?? '',
    )
      .trim()
      .toUpperCase() || null;
    const hasDiscountCode = Boolean(discountCode);
    const discountCodeAmount = Math.abs(
      parseWooMoney(
        (selectedOrder as any).discountCodeAmount,
        parseWooMoney(discountCodeAmountFromWoo, 0),
      ),
    );
    const appliedReferralCreditRaw = parseWooMoney((selectedOrder as any).appliedReferralCredit, 0);
    const appliedReferralCredit = Math.abs(appliedReferralCreditRaw);
    const hasExplicitDiscounts = discountCodeAmount > 0 || appliedReferralCredit > 0;
    const originalItemsSubtotal = parseWooMoney(
      (selectedOrder as any).originalItemsSubtotal,
      itemsSubtotalEffective + discountCodeAmount,
    );
    const shippingTotal = parseWooMoney(
      selectedOrder.shippingTotal,
      parseWooMoney(
        wooResponse.shipping_total ?? wooPayload.shipping_total ?? wooShippingLine?.total,
        0,
      ),
    );
    const taxTotal = parseWooMoney(
      (selectedOrder as any).taxTotal,
      parseWooMoney(wooResponse.total_tax ?? wooPayload.total_tax, 0),
    );
    const legacyDiscountTotalRaw = parseWooMoney(
      wooResponse.discount_total ?? wooPayload.discount_total ?? (wooPayload.discount_lines?.[0]?.total ?? 0),
      0,
    );
    const legacyDiscountTotal = Math.abs(legacyDiscountTotalRaw);
    const inferredDiscountCodeAmount = Math.max(
      0,
      Math.round(((originalItemsSubtotal - itemsSubtotalEffective) + Number.EPSILON) * 100) / 100,
    );
    const resolvedDiscountCodeAmount = discountCodeAmount > 0
      ? discountCodeAmount
      : inferredDiscountCodeAmount > 0.01
        ? inferredDiscountCodeAmount
        : 0;
    const resolvedHasExplicitDiscounts = resolvedDiscountCodeAmount > 0 || appliedReferralCredit > 0;
    const discountTotal = resolvedHasExplicitDiscounts ? resolvedDiscountCodeAmount + appliedReferralCredit : legacyDiscountTotal;
    const storedGrandTotal = parseWooMoney(
      (selectedOrder as any).grandTotal,
      parseWooMoney(
        (selectedOrder as any).total,
        parseWooMoney(wooResponse.total ?? wooPayload.total, 0),
      ),
    );
    const subtotalForSummary = resolvedHasExplicitDiscounts ? originalItemsSubtotal : itemsSubtotalEffective;
    const computedGrandTotal = subtotalForSummary + shippingTotal + taxTotal - discountTotal;
    const baseGrandTotal = storedGrandTotal > 0 ? storedGrandTotal : computedGrandTotal;
    const grandTotal =
      taxTotal > 0 && computedGrandTotal > baseGrandTotal + 0.01
        ? computedGrandTotal
        : baseGrandTotal;
    const detailTotal = Math.max(grandTotal, 0);
    const fallbackPayment =
      selectedOrder.paymentDetails ||
      selectedOrder.paymentMethod ||
      null;
    const paymentDisplay = (() => {
      if (stripeMeta?.cardLast4) {
        return `${stripeMeta?.cardBrand || 'Card'} •••• ${stripeMeta.cardLast4}`;
      }
      if (typeof fallbackPayment === 'string' && fallbackPayment.trim().length > 0) {
        const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (/stripe onsite/i.test(fallbackPayment)) {
          return 'Card payment';
        }
        const normalized = normalize(fallbackPayment);
        if (normalized.includes('zelle')) {
          return 'Zelle';
        }
        if (
          normalized === 'bacs' ||
          normalized === 'bank_transfer' ||
          normalized === 'direct_bank_transfer' ||
          normalized.includes('direct_bank') ||
          normalized.includes('bank_transfer') ||
          normalized.includes('banktransfer')
        ) {
          return 'Direct Bank Transfer';
        }
        if (normalized.includes('stripe')) {
          return 'Card payment';
        }
        return fallbackPayment;
      }
      return null;
    })();
    const renderOrderDetailShimmer = (widthClass = 'w-24') => (
      <span className={`news-loading-line news-loading-shimmer inline-block align-middle ${widthClass}`} aria-hidden="true" />
    );
    const renderOrderTextOrShimmer = (value: string | null | undefined, widthClass = 'w-24') => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) {
        return text;
      }
      return isOrderDetailHydrating ? renderOrderDetailShimmer(widthClass) : '—';
    };
    const renderAddressLinesForOrderDetail = (address: any) => {
      if (!address) {
        return isOrderDetailHydrating ? (
          <div className="space-y-2">
            {renderOrderDetailShimmer('w-36')}
            {renderOrderDetailShimmer('w-48')}
            {renderOrderDetailShimmer('w-28')}
          </div>
        ) : (
          <p className="text-sm text-slate-500">—</p>
        );
      }
      const lines = [
        address.name,
        [address.addressLine1, address.addressLine2].filter(Boolean).join(' ').trim(),
        [address.city, address.state, address.postalCode].filter(Boolean).join(', ').trim(),
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
      return lines.length > 0 ? lines : (
        isOrderDetailHydrating ? (
          <div className="space-y-2">
            {renderOrderDetailShimmer('w-36')}
            {renderOrderDetailShimmer('w-48')}
          </div>
        ) : (
          <p className="text-sm text-slate-500">—</p>
        )
      );
    };

	    return (
	      <div className="space-y-6">
	          <div className="flex justify-end">
		          <Button
		            type="button"
	            variant="outline"
	            className="header-home-button squircle-sm bg-white text-slate-900"
	            onClick={() => setSelectedOrder(null)}
	          >
	            ← Back to orders
	          </Button>
	        </div>
	        <div className="account-order-card squircle-lg bg-white border border-[#d5d9d9] overflow-hidden text-left">
	          <div className="px-6 py-4 bg-[#f5f6f6] flex flex-wrap items-center justify-between gap-4">
	            <div className="space-y-1">
	              <p className="text-xs uppercase tracking-[0.08em] text-slate-500">Order</p>
	              <p className="text-lg font-semibold text-slate-900">
	                {selectedOrder.number ? `Order #${selectedOrder.number}` : selectedOrder.id}
	              </p>
	            </div>
	            <div className="space-y-1 text-right">
	              <p className="text-xs uppercase tracking-[0.08em] text-slate-500">Status</p>
	              <p className="text-base font-semibold text-slate-900">{describeOrderStatus(selectedOrder)}</p>
	            </div>
	          </div>

          <div className="px-6 py-5 flex flex-wrap items-center justify-between gap-6 text-sm text-slate-700 mb-4">
            <div className="space-y-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Placed</p>
                <div className="text-sm font-semibold text-slate-900">
                  {renderOrderTextOrShimmer(formatOrderDate(resolveOrderPlacedAt(selectedOrder)), 'w-28')}
                </div>
              </div>
              {showExpectedDeliveryDetails && (
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Expected delivery</p>
                  <div className="text-sm font-semibold text-slate-900">
                    {renderOrderTextOrShimmer(expectedDelivery, 'w-32')}
                  </div>
                </div>
              )}
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Total</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(detailTotal, selectedOrder.currency || 'USD')}
              </p>
            </div>
          </div>

	          <div className="border-t border-[#d5d9d9] p-6 space-y-6">
	            <div className="grid gap-4 md:grid-cols-2">
	              <div className="space-y-3">
	                <h4 className="text-base font-semibold text-slate-900">Shipping Information</h4>
	                {renderAddressLinesForOrderDetail(shippingAddress)}
	                <div className="text-sm text-slate-700 space-y-1">
	                  {trackingNumber && (
	                    <p>
	                      <span className="font-semibold">Tracking:</span>{' '}
	                      {trackingHref ? (
	                        <a
	                          href={trackingHref}
	                          target="_blank"
	                          rel="noreferrer"
	                          className="text-[rgb(26,85,173)] hover:underline"
	                        >
	                          {trackingNumber}
	                        </a>
	                      ) : (
	                        trackingNumber
	                      )}
	                    </p>
	                  )}
	                  {(() => {
	                    const carrierTracking =
	                      (selectedOrder.integrationDetails as any)?.carrierTracking ||
	                      (selectedOrder.integrationDetails as any)?.carrier_tracking ||
	                      null;
	                    const label =
	                      carrierTracking?.trackingStatusRaw ||
	                      carrierTracking?.trackingStatus ||
	                      carrierTracking?.tracking_status ||
	                      carrierTracking?.status ||
	                      carrierTracking?.deliveryStatus ||
	                      carrierTracking?.delivery_status ||
	                      null;
	                    if (!label) return null;
	                    return (
	                      <p>
	                        <span className="font-semibold">Tracking status:</span>{' '}
	                        {humanizeOrderStatus(String(label))}
	                      </p>
	                    );
	                  })()}
	                  {shippingMethod && (
	                    <p>
	                      <span className="font-semibold">Service:</span> {shippingMethod}
	                    </p>
	                  )}
	                  {Number.isFinite(shippingTotal) && (
	                    <p>
	                      <span className="font-semibold">Shipping:</span>{' '}
	                      {formatCurrency(shippingTotal, selectedOrder.currency || 'USD')}
	                    </p>
	                  )}
	                  {Number.isFinite(taxTotal) && taxTotal > 0 && (
	                    <p>
	                      <span className="font-semibold">Estimated tax:</span>{' '}
	                      {formatCurrency(taxTotal, selectedOrder.currency || 'USD')}
	                    </p>
	                  )}
	                  {expectedDelivery && (
	                    <p>
	                      <span className="font-semibold">Expected:</span> {expectedDelivery}
	                    </p>
	                  )}
	                  {showExpectedShipmentWindow && (
	                    <p>
	                      <span className="font-semibold">Estimated ship window:</span>{' '}
	                      {expectedShipmentWindow}
	                    </p>
	                  )}
	                </div>
	              </div>

	              <div className="space-y-3">
	                <h4 className="text-base font-semibold text-slate-900">Billing Information</h4>
	                {renderAddressLinesForOrderDetail(billingAddress)}
	                <div className="text-sm text-slate-700 space-y-1">
	                  <p>
	                    <span className="font-semibold">Payment:</span>{' '}
                      {typeof paymentDisplay === 'string' && paymentDisplay.trim().length > 0 ? (
                        paymentDisplay
                      ) : isOrderDetailHydrating ? (
                        renderOrderDetailShimmer('w-28')
                      ) : (
                        '—'
                      )}
	                  </p>
	                  {stripeMeta?.cardLast4 && (
	                    <p>
	                      <span className="font-semibold">Card:</span>{' '}
	                      {`${stripeMeta?.cardBrand || 'Card'} •••• ${stripeMeta.cardLast4}`}
	                    </p>
	                  )}
	                  {selectedOrder.physicianCertified && (
	                    <p className="text-green-700 font-semibold">Physician certification acknowledged</p>
	                  )}
	                </div>
	              </div>
	            </div>

	            <div className="space-y-4">
	              <h4 className="text-base font-semibold text-slate-900">Items</h4>
	              {lineItems.length > 0 ? (
	                <div className="space-y-4">
	                  {lineItems.map((line, idx) => {
	                    const quantity = Number(line.quantity) || 0;
	                    const lineTotal = parseWooMoney(line.total, parseWooMoney(line.subtotal, 0));
	                    const unitPrice = quantity > 0 ? lineTotal / quantity : parseWooMoney(line.price, lineTotal);
	                    const ids = extractOrderLineImageKey(line);
	                    const cachedImage = ids ? orderLineImageCache[ids.key] : null;
	                    const lineImage =
	                      typeof cachedImage === 'string' && cachedImage.trim().length > 0
	                        ? cachedImage
	                        : resolveOrderLineImage(line, wooLineItems);
	                    return (
	                      <div
	                        key={line.id || `${line.sku}-${idx}`}
	                        className="flex items-start gap-4 border-b border-slate-100 pb-3 last:border-b-0 last:pb-3"
	                      >
                        <div
                          className="h-full min-h-[60px] w-20 rounded-xl border border-[#d5d9d9] bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0"
                          style={{ maxHeight: '120px' }}
                        >
                          {lineImage ? (
                            <img
                              src={lineImage}
                              alt={line.name || 'Item thumbnail'}
                              className="object-contain"
                              style={{ width: '100%', height: '100%', maxHeight: '120px' }}
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                          ) : (
                            <Package className="h-6 w-6 opacity-60" />
                          )}
                        </div>
	                        <div className="flex-1 min-w-[12rem] space-y-1 pr-4">
	                          <p className="text-slate-900 font-semibold">{line.name || 'Item'}</p>
	                          <p className="text-slate-600">Qty: {quantity || '—'}</p>
	                        </div>
	                        <div className="text-sm text-slate-700 text-right min-w-[8rem]">
	                          {Number.isFinite(unitPrice) && (
	                            <p>Each: {formatCurrency(unitPrice, selectedOrder.currency || 'USD')}</p>
	                          )}
	                          {Number.isFinite(lineTotal) && (
	                            <p className="font-semibold">
	                              Total: {formatCurrency(lineTotal, selectedOrder.currency || 'USD')}
	                            </p>
	                          )}
	                        </div>
	                      </div>
	                    );
	                  })}
	                </div>
	              ) : (
	                <p className="text-sm text-slate-600">No line items available for this order.</p>
	              )}
	            </div>

		            <div className="space-y-3">
		              <h4 className="text-base font-semibold text-slate-900">Order Summary</h4>
		              <div className="space-y-2 text-sm text-slate-700">
	                <div className="flex justify-between">
	                  <span>Subtotal</span>
	                  <span>{formatCurrency(subtotalForSummary, selectedOrder.currency || 'USD')}</span>
	                </div>
                  {resolvedHasExplicitDiscounts && resolvedDiscountCodeAmount > 0 && (
                    <div className="flex justify-between text-[rgb(26,85,173)]">
                      <span>{discountCode ? `Discount (${discountCode})` : 'Discount'}</span>
                      <span>-{formatCurrency(resolvedDiscountCodeAmount, selectedOrder.currency || 'USD')}</span>
                    </div>
                  )}
                  {hasDiscountCode && resolvedDiscountCodeAmount <= 0 && (
                    <div className="flex justify-between text-[rgb(26,85,173)]">
                      <span>{`Discount code used (${discountCode})`}</span>
                      <span>Applied</span>
                    </div>
                  )}
                  {resolvedHasExplicitDiscounts && appliedReferralCredit > 0 && (
                    <div className="flex justify-between text-[rgb(26,85,173)]">
                      <span>Referral Credit</span>
                      <span>-{formatCurrency(appliedReferralCredit, selectedOrder.currency || 'USD')}</span>
                    </div>
                  )}
	                <div className="flex justify-between">
	                  <span>Shipping</span>
	                  <span>{formatCurrency(shippingTotal, selectedOrder.currency || 'USD')}</span>
	                </div>
	                {taxTotal > 0 && (
	                  <div className="flex justify-between">
	                    <span>Tax</span>
	                    <span>{formatCurrency(taxTotal, selectedOrder.currency || 'USD')}</span>
	                  </div>
	                )}
	                {!resolvedHasExplicitDiscounts && discountTotal > 0 && (
	                  <div className="flex justify-between text-[rgb(26,85,173)]">
	                    <span>Credits & Discounts</span>
	                    <span>-{formatCurrency(discountTotal, selectedOrder.currency || 'USD')}</span>
	                  </div>
	                )}
	                {paymentDisplay && (
	                  <div className="flex justify-between">
	                    <span>Paid with</span>
	                    <span className="font-medium text-slate-900">{paymentDisplay}</span>
	                  </div>
	                )}
		                <div className="flex justify-between text-base font-semibold text-slate-900 border-t border-slate-100 pt-3">
		                  <span>Total</span>
		                  <span>{formatCurrency(Math.max(grandTotal, 0), selectedOrder.currency || 'USD')}</span>
		                </div>
		              </div>
		            </div>

		            {typeof selectedOrder.notes === 'string' && selectedOrder.notes.trim().length > 0 && (
		              <div className="space-y-2">
		                <h4 className="text-base font-semibold text-slate-900">
		                  Notes <span className="label-paren">(from PepPro)</span>
		                </h4>
		                <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
		                  <p className="text-sm text-slate-700 whitespace-pre-wrap">
		                    {formatTimestampedNotesForDisplay(selectedOrder.notes)}
		                  </p>
		                </div>
		              </div>
		            )}
		          </div>
		        </div>
		      </div>
		    );
		  };

	  const accountOrdersPanel = localUser ? (
	    <div className="space-y-4">
      {/* Header Section */}
      <div className="flex flex-col gap-4">
	        
	        <div className="flex flex-wrap items-center justify-between gap-3">
	          {ordersLastSyncedAt && (
	            <button
	              type="button"
	              onClick={() => Promise.resolve(onRefreshOrders?.({ force: true }))}
	              disabled={!onRefreshOrders}
	              title={onRefreshOrders ? 'Refresh orders' : undefined}
	              className="text-xs text-slate-500 px-3 py-1.5 glass-card squircle-sm border border-[var(--brand-glass-border-1)] disabled:opacity-70 disabled:cursor-default hover:text-slate-700 hover:border-[var(--brand-glass-border-2)] transition-colors"
	            >
	              {formatRelativeMinutes(ordersLastSyncedAt)}
	            </button>
	          )}

          <Input
            value={ordersSearchQuery}
            onChange={(event) => setOrdersSearchQuery(event.target.value)}
            placeholder="Search orders…"
            className="h-7 w-full sm:w-[16rem] md:w-[18rem] text-xs squircle-sm bg-white/80 border border-[var(--brand-glass-border-1)] focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.35)]"
          />

          <div className="flex items-center gap-2 ml-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onToggleShowCanceled?.()}
              className="glass squircle-sm btn-hover-lighter border border-[rgb(95,179,249)] bg-white text-slate-900 shadow-[0_8px_18px_rgba(95,179,249,0.14)] my-0 h-7 py-0 leading-none gap-1"
            >
              {showCanceledOrders ? (
                <>
                  <EyeOff className="h-4 w-4 mr-2" aria-hidden="true" />
                  Hide canceled
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4 mr-2" aria-hidden="true" />
                  Show canceled
                </>
              )}
            </Button>
          </div>
        </div>

        {accountOrdersError && (
          <div className="glass-card squircle-md p-4 border border-red-200 bg-red-50/50">
            <p className="text-sm text-red-700 font-medium">{accountOrdersError}</p>
          </div>
        )}

        {catalogLoading && (
          <div className="glass-card squircle-md p-4 border border-[rgba(95,179,249,0.35)] bg-white/80 flex items-center gap-3">
            <RefreshCw className="h-4 w-4 text-[rgb(95,179,249)] animate-spin" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-slate-900">Loading product and order catelogue…</p>
              <p className="text-xs text-slate-600">Please hold while we sync the catalog data.</p>
            </div>
          </div>
        )}
      </div>

      {/* Orders Content */}
      <div className="relative">
        {selectedOrder ? renderOrderDetails() : renderOrdersList()}
      </div>
    </div>
	  ) : null;

  const logoSlotHeightPx = isLargeScreen ? 56 : 48;
  const logoSizing = {
    maxWidth: isLargeScreen ? '240px' : 'min(170px, 40vw)',
    heightPx: logoSlotHeightPx,
  };
  const delegateUserIconClassName = 'h-5 w-5 flex-shrink-0';
  const delegatePreviewSecondaryHex =
    normalizeDelegateSecondaryColor(localUser?.delegateSecondaryColor ?? user?.delegateSecondaryColor ?? null)
    || DEFAULT_DELEGATE_SECONDARY_COLOR;
  const delegatePreviewSecondaryColor = hexToRgbCss(delegatePreviewSecondaryHex);
  const delegatePreviewTranslucentSecondary = hexToRgbaCss(delegatePreviewSecondaryHex, 0.18);

		  const patientLinksPanel = showPatientLinksTab ? (
		    <div className="space-y-6">
      <p className="text-sm text-slate-600">
        This tool is in early access. Please{' '}
        <button
          type="button"
          className="font-bold hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.35)] focus-visible:ring-offset-2"
          style={{
            color: 'rgb(95,179,249)',
            textDecorationLine: 'underline',
            textDecorationColor: 'rgb(95,179,249)',
            textUnderlineOffset: '2px',
          }}
          onClick={() => window.dispatchEvent(new Event('peppro:open-bug-report'))}
        >
          report
        </button>
        {' '}any issues you encounter, and we will prioritize fixing them (usually within a day or two).
      </p>
      <div className="glass-card squircle-lg border border-[var(--brand-glass-border-1)] bg-white/80 p-6 sm:p-7">
        <h3 className="text-lg font-semibold text-slate-900">Create a delegate link</h3>
        <p className="mb-3 text-sm leading-relaxed text-slate-700">
          Configure a session for your patient, and share the link with them once configured. This tool is intended to help you fascilate independent peptide research. Please be consienscious when setting compensation, as patients will see the disclosures you set when they access the link. You can demo your own links before sharing by clicking the "View" button.
        </p>
	        <div className="mt-5 patient-link-form patient-link-form--generate patient-link-form--grouped">
            <div className="patient-link-group rounded-xl border border-slate-200/70 bg-white/55 px-4 py-4 sm:px-5">
            <div className="pt-1">
              <p className="text-base font-semibold uppercase tracking-[0.08em] text-[rgb(95,179,249)]">
                Subject & Access
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Define subject metadata for this delegate session.
              </p>
            </div>
	          <Label
	            htmlFor="patient-link-subject-label"
	            className="patient-link-form__label patient-link-form__label--patient-id text-sm font-semibold text-slate-700"
	          >
	            Subject label <span className="label-paren">(optional, non-PHI)</span>
	          </Label>
	          <Input
	            id="patient-link-subject-label"
	            value={patientLinkSubjectLabelDraft}
	            onChange={(event) => {
                setPatientLinkSubjectLabelDraft(event.target.value);
                trackPatientLinkFieldEntry('subject_label', event.target.value);
              }}
	            placeholder="e.g., Subject 042"
            className="patient-link-form__patient-id-input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-study-label"
	            className="patient-link-form__label patient-link-form__label--link text-sm font-semibold text-slate-700"
	          >
	            Study label <span className="label-paren">(optional, non-PHI)</span>
	          </Label>
	          <Input
	            id="patient-link-study-label"
	            value={patientLinkStudyLabelDraft}
	            onChange={(event) => {
                setPatientLinkStudyLabelDraft(event.target.value);
                trackPatientLinkFieldEntry('study_label', event.target.value);
              }}
	            placeholder="e.g., GH response pilot"
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-reference"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Internal reference <span className="label-paren">(optional order or subject code)</span>
	          </Label>
	          <Input
	            id="patient-link-reference"
	            value={patientLinkReferenceDraft}
	            onChange={(event) => {
                setPatientLinkReferenceDraft(event.target.value);
                trackPatientLinkFieldEntry('internal_reference', event.target.value);
              }}
	            placeholder="e.g., A104"
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
            </div>
            <div className="patient-link-group rounded-xl border border-slate-200/70 bg-white/55 px-4 py-4 sm:px-5">
            <div className="pt-2">
              <p className="text-base font-semibold uppercase tracking-[0.08em] text-[rgb(95,179,249)]">
                Pricing & Limits
              </p>
            </div>
	          <Label
	            htmlFor="patient-link-markup"
	            className="patient-link-form__label patient-link-form__label--markup text-sm font-semibold text-slate-700"
	          >
	            <span className="block">Delegate markup %</span>
	            <span className="label-paren mt-0.5 block">
	              (Cap this conservatively. Patients must see compensation disclosure.)
	            </span>
	          </Label>
	          <div className="patient-link-form__markup relative w-full mb-0">
	            <Input
	              id="patient-link-markup"
	              type="text"
	              inputMode="decimal"
	              value={patientLinkMarkupDraft}
	              onChange={(event) => {
                  setPatientLinkMarkupDraft(normalizeMarkupDraftText(event.target.value));
                  trackPatientLinkFieldEntry('markup_percent', event.target.value);
                }}
	              placeholder="0"
	              className="!h-11 w-full text-left tabular-nums squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	              style={{ direction: 'ltr' }}
	            />
	          </div>
	          <Label
	            htmlFor="patient-link-expiry-hours"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Expiration hours
	          </Label>
	          <Input
	            id="patient-link-expiry-hours"
	            type="text"
	            inputMode="numeric"
	            value={patientLinkExpiryHoursDraft}
	            onChange={(event) => {
                const next = event.target.value.replace(/[^\d]/g, '');
                setPatientLinkExpiryHoursDraft(next);
                trackPatientLinkFieldEntry('expiration_hours', next);
              }}
	            placeholder="72"
            className="h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-usage-limit"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Usage limit <span className="label-paren">(optional)</span>
	          </Label>
	          <Input
	            id="patient-link-usage-limit"
	            type="text"
	            inputMode="numeric"
	            value={patientLinkUsageLimitDraft}
	            onChange={(event) => {
                const next = event.target.value.replace(/[^\d]/g, '');
                setPatientLinkUsageLimitDraft(next);
                trackPatientLinkFieldEntry('usage_limit', next);
              }}
	            placeholder="e.g., 5"
            className="h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-payment-method"
	            className="patient-link-form__label patient-link-form__label--payment text-sm font-semibold text-slate-700"
	          >
	            Payment method
	          </Label>
	          <select
	            id="patient-link-payment-method"
	            value={patientLinkPaymentMethodDraft}
	            onChange={(event) => {
	              const next = normalizePatientLinkPaymentMethod(event.target.value);
	              const currentDefault = buildPatientLinkDefaultInstructions(
	                patientLinkPaymentMethodDraft,
	                zelleContactDraft.trim() || null,
	                localUser?.name ?? user?.name ?? null,
	              );
	              const shouldReplace =
	                !patientLinkInstructionsDraft.trim()
	                || patientLinkInstructionsDraft.trim() === currentDefault.trim();
	              setPatientLinkPaymentMethodDraft(next);
	              if (shouldReplace) {
	                setPatientLinkInstructionsDraft(
                    buildPatientLinkDefaultInstructions(next, zelleContactDraft.trim() || null, localUser?.name ?? user?.name ?? null),
                  );
	              }
	            }}
	            className="patient-link-form__select h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          >
	            {patientLinkPaymentMethodOptions.map((opt) => (
	              <option key={opt.value} value={opt.value}>
	                {opt.label}
	              </option>
	            ))}
	          </select>
	          <Label
	            htmlFor="patient-link-zelle-contact"
	            className="patient-link-form__label patient-link-form__label--zelle-contact text-sm font-semibold text-slate-700"
	          >
	            Zelle email or phone
	          </Label>
	          <Input
	            id="patient-link-zelle-contact"
	            value={zelleContactDraft}
	            onChange={(event) => {
                setZelleContactDraft(event.target.value);
                trackPatientLinkFieldEntry('zelle_contact', event.target.value);
              }}
	            placeholder="e.g., billing@clinic.com or +1 (444) 444-4444"
	            className="patient-link-form__zelle-contact-input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
            </div>
            <div className="patient-link-group rounded-xl border border-slate-200/70 bg-white/55 px-4 py-4 sm:px-5">
            <div className="pt-2">
              <p className="text-base font-semibold uppercase tracking-[0.08em] text-[rgb(95,179,249)]">
                Notes & Instructions
              </p>
            </div>
	          <Label
	            htmlFor="patient-link-research-note"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Research note <span className="label-paren">(optional, non-clinical)</span>
	          </Label>
	          <Textarea
	            id="patient-link-research-note"
	            value={patientLinkResearchNoteDraft}
	            onChange={(event) => {
                setPatientLinkResearchNoteDraft(event.target.value);
                trackPatientLinkFieldEntry('research_note', event.target.value);
              }}
	            placeholder="e.g., Restricted to approved protocol materials only."
	            rows={2}
	            className="min-h-[56px] squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-instructions"
	            className="patient-link-form__label patient-link-form__label--instructions text-sm font-semibold text-slate-700"
	          >
	            Payment instructions <span className="label-paren">(shown to the delegate)</span>
	          </Label>
	          <Textarea
	            id="patient-link-instructions"
	            value={patientLinkInstructionsDraft}
	            onChange={(event) => {
                setPatientLinkInstructionsDraft(event.target.value);
                trackPatientLinkFieldEntry('payment_instructions', event.target.value);
              }}
	            placeholder="Enter instructions that the delegate will see in their proposal modal…"
	            rows={2}
	            className="patient-link-form__instructions !mb-0 min-h-[56px] squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	          />
            </div>
	          <div className="patient-link-submit-row mt-2 pt-3 pb-3">
	            <div className="patient-link-submit-copy flex items-center gap-3 min-w-0">
	              <input
	                type="checkbox"
	                id="delegate-link-terms"
	                className="brand-checkbox"
	                checked={patientLinkTermsAccepted}
	                onChange={(event) => setPatientLinkTermsAccepted(event.target.checked)}
	              />
	              <label htmlFor="delegate-link-terms" className="text-sm text-slate-700 leading-snug flex-1 min-w-0">
	                I certify that I am {localUser?.name || user?.name || 'the licensed physician for this account'}, and I agree to PepPro&apos;s{' '}
	                <button
	                  type="button"
	                  className="legal-inline-link"
	                  onClick={(event) => {
	                    event.preventDefault();
	                    event.stopPropagation();
	                    openLegalDocument('terms');
	                  }}
	                >
	                  Terms of Service
	                </button>
	                {', '}
	                <button
	                  type="button"
	                  className="legal-inline-link"
	                  onClick={(event) => {
	                    event.preventDefault();
	                    event.stopPropagation();
	                    openLegalDocument('shipping');
	                  }}
	                >
	                  Shipping Policy
	                </button>
	                {', and '}
	                <button
	                  type="button"
	                  className="legal-inline-link"
	                  onClick={(event) => {
	                    event.preventDefault();
	                    event.stopPropagation();
	                    openLegalDocument('privacy');
	                  }}
	                >
	                  Privacy Policy
	                </button>
	                .
	              </label>
	            </div>
	            <div className="patient-link-submit-action">
	              <Button
	                type="button"
	                onClick={() => void handleCreatePatientLink()}
	                disabled={!showPatientLinksTab || patientLinksCreating}
	                className="header-home-button patient-link-form__button !h-11 min-h-[44px] w-full mb-0 squircle-sm bg-white text-slate-900 px-7"
	              >
	                {patientLinksCreating ? 'Creating…' : 'Create delegate link'}
	              </Button>
	            </div>
	          </div>
	        </div>
	      </div>

	      <div className="glass-card squircle-lg border border-[var(--brand-glass-border-1)] bg-white/80 p-6 sm:p-7">
	        <h3 className="text-lg font-semibold text-slate-900">White label your sessions</h3>
	        <p className="mb-3 text-sm leading-relaxed text-slate-700">
	          Make your logo appear in the header of your patient&apos;s session. Recommended: horizontal rectangle PNG (we&apos;ll resize to fit the header).
	        </p>
	        <div className="mt-2 space-y-4">
	          <div className="glass-card squircle-lg p-3 !border-0">
	            <p className="text-xs font-semibold text-slate-700">Header preview</p>
	            <div className="mt-3 w-full max-w-full overflow-hidden app-header-blur border border-slate-200 shadow-sm rounded-xl px-4 sm:px-6 py-4">
	              <div className="flex flex-col gap-3 md:gap-4">
	                <div className="flex w-full min-w-0 items-center gap-3 sm:gap-4 justify-between flex-nowrap">
	                  <div className="flex items-center gap-3 min-w-0">
	                    <div
	                      className="brand-logo relative flex items-center justify-start flex-shrink min-w-0"
	                      style={{ height: logoSizing.heightPx, maxWidth: logoSizing.maxWidth }}
	                    >
	                      <img
	                        src={
	                          typeof localUser?.delegateLogoUrl === 'string' &&
	                          localUser.delegateLogoUrl.trim().length > 0
	                            ? localUser.delegateLogoUrl
	                            : withStaticAssetStamp('/PepPro_fulllogo.png')
	                        }
	                        alt="Delegate header logo preview"
	                        className="relative z-[1] flex-shrink-0"
	                        style={{
	                          display: 'block',
	                          width: '100%',
	                          height: '100%',
	                          maxHeight: '100%',
	                          objectFit: 'contain',
	                        }}
	                        loading="eager"
	                        decoding="async"
	                      />
	                    </div>
	                  </div>

	                  {isLargeScreen && (
	                    <div className="flex flex-1 justify-center min-w-0 pointer-events-none opacity-95">
	                      <div className="w-full min-w-0 max-w-md">
	                        {renderSearchField('', {
	                          value: '',
	                          readOnly: true,
	                          showClearButton: false,
                            borderColor: delegatePreviewSecondaryColor,
	                        })}
	                      </div>
	                    </div>
	                  )}

	                  <div className="ml-auto flex w-auto items-center justify-end gap-2 min-w-0 max-w-full">
	                    <div
	                      className="squircle-sm inline-flex items-center gap-2 select-none cursor-default min-w-0 max-w-[58vw] sm:max-w-[20rem] flex-shrink overflow-hidden px-4 py-2 sm:px-5 sm:py-2.5 text-sm sm:text-base border-0 !border-0 !bg-transparent"
	                      aria-label="Delegate header preview"
	                      style={{
	                        border: '0',
	                        backgroundColor: 'transparent',
	                        color: delegatePreviewSecondaryColor,
	                      }}
	                    >
	                      <User className={delegateUserIconClassName} aria-hidden="true" style={{ color: delegatePreviewSecondaryColor }} />
	                      <span className="font-semibold truncate min-w-0 max-w-full">{`Delegate of ${
	                        localUser?.name ? `Dr. ${localUser.name}` : 'Physician'
	                      }`}</span>
	                    </div>
	                    {!isLargeScreen && (
	                      <Button
	                        type="button"
	                        variant="outline"
	                        size="icon"
	                        disabled
	                        aria-hidden="true"
	                        className="glass squircle-sm pointer-events-none"
	                        style={{
	                          color: delegatePreviewSecondaryColor,
	                          borderColor: delegatePreviewTranslucentSecondary,
	                        }}
	                      >
	                        <Search className="h-4 w-4" style={{ color: delegatePreviewSecondaryColor }} />
	                      </Button>
	                    )}
	                  </div>
	                </div>
	              </div>
	            </div>
	          </div>

	          <div className="delegate-logo-summary-row">
	            <div className="delegate-logo-summary-copy">
	              <p className="text-sm font-semibold text-slate-900 truncate">
	                {typeof localUser?.delegateLogoUrl === 'string' && localUser.delegateLogoUrl.trim().length > 0
	                  ? 'Custom logo set'
	                  : 'Using PepPro logo'}
	              </p>
	              <p className="text-xs text-slate-600">Max ~5MB. Stored on your account (we resize to fit the header).</p>
	            </div>
	            <input
	              ref={delegateLogoInputRef}
	              type="file"
	              accept="image/*"
	              className="hidden"
	              onChange={(event) => void handleSelectDelegateLogo(event.target.files?.[0] ?? null)}
	            />
	            <div className="delegate-logo-summary-actions">
	              <Button
	                type="button"
	                variant="outline"
	                onClick={() => delegateLogoInputRef.current?.click()}
	                disabled={delegateLogoUploading}
	                className="header-home-button delegate-logo-summary-button h-11 squircle-sm gap-2 bg-white px-7 text-slate-900"
	              >
                  <Upload className="h-4 w-4" aria-hidden="true" />
	                {delegateLogoUploading ? 'Uploading…' : 'Upload your logo'}
	              </Button>
	              <Button
	                type="button"
	                variant="outline"
	                onClick={() => void handleRemoveDelegateLogo()}
	                disabled={delegateLogoUploading}
                  aria-label="Remove logo"
	                className="header-home-button patient-link-payment-toggle-button delegate-logo-summary-button h-11 squircle-sm bg-white text-slate-900"
	              >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
	              </Button>
	            </div>
	          </div>
	          <div className="rounded-xl border border-slate-200/70 bg-white/55 px-4 py-4">
	            <Label htmlFor="delegate-secondary-color" className="text-sm font-semibold text-slate-700">
	              Primary color
	            </Label>
	            <p className="mt-1 text-xs text-slate-500">
	              Used for delegate header accents and session highlights.
	            </p>
	            <div className="mt-3 flex items-center gap-3">
	              <input
	                id="delegate-secondary-color"
	                type="color"
	                value={delegatePreviewSecondaryHex}
	                disabled={delegateSecondaryColorSaving}
	                onChange={(event) => void handleDelegateSecondaryColorChange(event.target.value)}
	                className="h-11 w-16 cursor-pointer rounded-md border border-slate-200 bg-white p-1"
	              />
	              <div className="min-w-0">
	                <p className="text-sm font-semibold text-slate-900">{delegatePreviewSecondaryHex.toUpperCase()}</p>
	                {delegateSecondaryColorSaving ? (
                    <p className="text-xs text-slate-600">Saving color…</p>
                  ) : null}
	              </div>
	            </div>
	          </div>
	        </div>
	      </div>

	      <div className="glass-card squircle-lg border border-[var(--brand-glass-border-1)] bg-white/70 p-6 sm:p-7 space-y-1">
	        <div className="flex items-start justify-between gap-3">
	          <h3 className="text-lg font-semibold text-slate-900 leading-tight">Manage your links</h3>
		          <Button
		            type="button"
	            variant="outline"
	            size="sm"
	            onClick={() => void loadPatientLinks()}
	            disabled={!showPatientLinksTab || patientLinksLoading}
	            className="header-home-button squircle-sm bg-white text-slate-900 self-start"
	            aria-busy={patientLinksLoading}
	            title="Refresh"
	          >
            {patientLinksLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
	        <p className="text-sm leading-relaxed text-slate-700">
	          Copy the link to share a restricted delegate session. Delegates can build a proposal for your review using only the approved SKUs tied to that link. Use “Revoke link” to disable it early.
	        </p>

        {patientLinksError && (
          <div className="glass-card squircle-md p-4 border border-red-200 bg-red-50/60">
            <p className="text-sm text-red-700 font-medium">{patientLinksError}</p>
          </div>
        )}

	        {patientLinksLoading ? (
	          <div className="glass-card squircle-lg p-6 border border-[var(--brand-glass-border-1)] bg-white/80">
	            <p className="text-sm text-slate-600">Loading links…</p>
	          </div>
	        ) : patientLinks.length === 0 ? (
	          <div className="glass-card squircle-lg p-6 border border-[var(--brand-glass-border-1)] bg-white/80">
	            <div className="flex items-center justify-between gap-3">
	              <p className="text-sm font-semibold text-slate-900">No delegate links yet.</p>
	              <p className="text-sm text-slate-600">Create one above to get started.</p>
	            </div>
	          </div>
	        ) : (
	          <div className="space-y-4 pt-1">
		            {patientLinks.map((link) => {
		              const token = typeof link?.token === 'string' ? link.token : '';
		              const subjectLabel =
		                (typeof (link as any)?.subjectLabel === 'string' && (link as any).subjectLabel.trim())
		                  ? (link as any).subjectLabel.trim()
		                  : (typeof link?.patientId === 'string' && link.patientId.trim())
		                    ? link.patientId.trim()
		                    : (typeof (link as any)?.patient_id === 'string' && (link as any).patient_id.trim())
		                      ? (link as any).patient_id.trim()
		                      : '';
		              const studyLabel =
		                (typeof (link as any)?.studyLabel === 'string' && (link as any).studyLabel.trim())
		                  ? (link as any).studyLabel.trim()
		                  : (typeof (link as any)?.study_label === 'string' && (link as any).study_label.trim())
		                    ? (link as any).study_label.trim()
		                    : '';
		              const patientReference =
		                (typeof (link as any)?.patientReference === 'string' && (link as any).patientReference.trim())
		                  ? (link as any).patientReference.trim()
		                  : (typeof (link as any)?.patient_reference === 'string' && (link as any).patient_reference.trim())
		                    ? (link as any).patient_reference.trim()
		                    : (typeof link?.referenceLabel === 'string' && link.referenceLabel.trim())
		                      ? link.referenceLabel.trim()
		                      : (typeof (link as any)?.reference_label === 'string' && (link as any).reference_label.trim())
		                        ? (link as any).reference_label.trim()
		                        : (typeof link?.label === 'string' && link.label.trim())
		                          ? link.label.trim()
		                          : '';
		              const label = patientReference || studyLabel || subjectLabel || 'Delegate link';
		              const revokedAt = typeof link?.revokedAt === 'string' && link.revokedAt.trim() ? link.revokedAt.trim() : '';
		              const markupPercentValueRaw =
		                typeof (link as any)?.markupPercent === 'number'
		                  ? (link as any).markupPercent
		                  : typeof (link as any)?.markupPercent === 'string'
		                    ? Number((link as any).markupPercent)
		                    : typeof (link as any)?.markup_percent === 'number'
		                      ? (link as any).markup_percent
		                      : typeof (link as any)?.markup_percent === 'string'
		                        ? Number((link as any).markup_percent)
		                        : 0;
		              const markupPercentValue = Number.isFinite(markupPercentValueRaw) ? markupPercentValueRaw : 0;
		              const createdAt = typeof link?.createdAt === 'string' && link.createdAt.trim() ? link.createdAt.trim() : '';
		              const expiresAt = typeof link?.expiresAt === 'string' && link.expiresAt.trim() ? link.expiresAt.trim() : '';
		              const lastUsedAt = typeof link?.lastUsedAt === 'string' && link.lastUsedAt.trim() ? link.lastUsedAt.trim() : '';
		              const statusRaw =
		                typeof (link as any)?.status === 'string' && (link as any).status.trim()
		                  ? (link as any).status.trim().toLowerCase()
		                  : '';
		              const allowedProducts = Array.isArray((link as any)?.allowedProducts)
		                ? (link as any).allowedProducts.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
		                : [];
		              const usageLimitRaw =
		                typeof (link as any)?.usageLimit === 'number'
		                  ? (link as any).usageLimit
		                  : typeof (link as any)?.usageLimit === 'string'
		                    ? Number((link as any).usageLimit)
		                    : typeof (link as any)?.usage_limit === 'number'
		                      ? (link as any).usage_limit
		                      : typeof (link as any)?.usage_limit === 'string'
		                        ? Number((link as any).usage_limit)
		                        : null;
		              const usageCountRaw =
		                typeof (link as any)?.usageCount === 'number'
		                  ? (link as any).usageCount
		                  : typeof (link as any)?.usageCount === 'string'
		                    ? Number((link as any).usageCount)
		                    : typeof (link as any)?.usage_count === 'number'
		                      ? (link as any).usage_count
		                      : typeof (link as any)?.usage_count === 'string'
		                        ? Number((link as any).usage_count)
		                        : 0;
		              const usageLimitValue = Number.isFinite(usageLimitRaw as number) ? Number(usageLimitRaw) : null;
		              const usageCountValue = Number.isFinite(usageCountRaw) ? Number(usageCountRaw) : 0;
	              const delegateSharedAt =
	                typeof link?.delegateSharedAt === 'string' && link.delegateSharedAt.trim()
	                  ? link.delegateSharedAt.trim()
	                  : (typeof (link as any)?.delegate_shared_at === 'string' && (link as any).delegate_shared_at.trim())
	                    ? (link as any).delegate_shared_at.trim()
	                    : '';
	              const delegateOrderId =
	                typeof link?.delegateOrderId === 'string' && link.delegateOrderId.trim()
	                  ? link.delegateOrderId.trim()
	                  : (typeof (link as any)?.delegate_order_id === 'string' && (link as any).delegate_order_id.trim())
	                    ? (link as any).delegate_order_id.trim()
	                    : '';
	              const delegateReviewStatusRaw =
	                typeof link?.delegateReviewStatus === 'string' && link.delegateReviewStatus.trim()
	                  ? link.delegateReviewStatus.trim().toLowerCase()
	                  : (typeof (link as any)?.delegate_review_status === 'string' && (link as any).delegate_review_status.trim())
	                    ? (link as any).delegate_review_status.trim().toLowerCase()
	                    : '';
	              const proposalStatusRaw =
	                typeof (link as any)?.proposalStatus === 'string' && (link as any).proposalStatus.trim()
	                  ? (link as any).proposalStatus.trim().toLowerCase()
	                  : (typeof (link as any)?.proposal_status === 'string' && (link as any).proposal_status.trim())
	                    ? (link as any).proposal_status.trim().toLowerCase()
	                    : '';
	              const reviewStatus = delegateReviewStatusRaw || proposalStatusRaw;
	              const proposalStatus =
	                reviewStatus || (delegateSharedAt || delegateOrderId ? 'pending' : '');
	              const hasProposal = Boolean(reviewStatus || delegateSharedAt || delegateOrderId);
		              const isRevoked = Boolean(revokedAt);
		              const isUpdating = patientLinksUpdatingToken === token;
		              const isDeleting = patientLinksDeletingToken === token;
		              const isSavingPayment = patientLinksSavingPaymentToken === token;
		              const isProposalBusy = patientLinksProposalToken === token;
		              const isUpdatingReceivedPayment = patientLinksPaymentReceivedToken === token;
                  const isSavingReviewNotes = patientLinksSavingReviewNotesToken === token;
                  const proposalReviewNotes =
                    typeof (link as any)?.delegateReviewNotes === 'string'
                      ? String((link as any).delegateReviewNotes)
                      : typeof (link as any)?.proposalReviewNotes === 'string'
                        ? String((link as any).proposalReviewNotes)
                        : typeof (link as any)?.delegate_review_notes === 'string'
                          ? String((link as any).delegate_review_notes)
                          : typeof (link as any)?.proposal_review_notes === 'string'
                            ? String((link as any).proposal_review_notes)
                            : '';
                  const reviewNotesDraft = patientLinkReviewNotesDraftByToken[token] ?? proposalReviewNotes;
                  const reviewNotesDirty = reviewNotesDraft !== proposalReviewNotes;
		              const proposalLabel =
		                proposalStatus === 'approved' || proposalStatus === 'accepted'
		                  ? 'Accepted'
	                  : proposalStatus === 'modified'
	                    ? 'Modified'
	                    : proposalStatus === 'rejected'
	                      ? 'Rejected'
	                      : proposalStatus === 'pending'
		                        ? 'Pending review'
		                        : '';
		              const proposalActionLabel =
		                proposalStatus === 'approved' || proposalStatus === 'accepted' || proposalStatus === 'rejected'
		                  ? 'Proposal'
		                  : 'Review Proposal';
		              const paymentMethodDraft =
		                patientLinkPaymentMethodDraftByToken[token]
		                  ?? normalizePatientLinkPaymentMethod((link as any)?.paymentMethod ?? (link as any)?.payment_method ?? null);
		              const paymentInstructionsDraft =
		                patientLinkInstructionsDraftByToken[token]
		                  ?? (typeof (link as any)?.paymentInstructions === 'string'
		                    ? String((link as any).paymentInstructions)
		                    : typeof (link as any)?.payment_instructions === 'string'
		                      ? String((link as any).payment_instructions)
		                      : '');
			              const paymentMethodLabel =
			                patientLinkPaymentMethodOptions.find((opt) => opt.value === paymentMethodDraft)?.label
			                  ?? (paymentMethodDraft === 'zelle' ? 'Zelle' : '-');
			              const receivedPaymentRaw =
			                (link as any)?.receivedPayment ?? (link as any)?.received_payment ?? (link as any)?.paymentReceived ?? null;
			              const receivedPayment =
			                receivedPaymentRaw === true
			                || receivedPaymentRaw === 1
			                || receivedPaymentRaw === '1'
			                || (typeof receivedPaymentRaw === 'string' && receivedPaymentRaw.trim().toLowerCase() === 'true');

				              return (
				                <div
				                  key={token || label}
                          ref={(node) => {
                            if (!token) return;
                            if (node) {
                              patientLinkRowRefs.current[token] = node;
                            } else {
                              delete patientLinkRowRefs.current[token];
                            }
                          }}
                          data-patient-link-token={token || undefined}
				                  className="patient-link-item glass-liquid squircle-lg border border-[rgba(95,179,249,0.35)] transition-colors hover:border-[rgba(95,179,249,0.55)] p-4 sm:p-5 flex flex-col gap-3 sm:gap-4 sm:flex-row sm:items-start sm:justify-between"
				                >
			                  <div className="min-w-0 flex-1">
				                    <div className="flex items-center gap-2">
				                      <Link2 className="h-4 w-4 text-[rgb(95,179,249)] shrink-0" aria-hidden="true" />
				                      <span className="font-semibold text-slate-900 truncate">{label}</span>
			                      {/* Revoked status is reflected by the disabled action button; no inline badge. */}
			                    </div>
		                    <div className="mt-1 text-xs text-slate-600 space-y-0.5">
			                      {subjectLabel && <div>Subject: {subjectLabel}</div>}
			                      {studyLabel && <div>Study: {studyLabel}</div>}
			                      {patientReference && <div>Reference: {patientReference}</div>}
			                      {createdAt && <div>Created: {formatLinkDateTime(createdAt) || createdAt}</div>}
			                      {expiresAt && <div>Expires: {formatLinkDateTime(expiresAt) || expiresAt}</div>}
			                      {lastUsedAt && <div>Last used: {formatLinkDateTime(lastUsedAt) || lastUsedAt}</div>}
			                      {usageLimitValue ? <div>Uses: {usageCountValue} / {usageLimitValue}</div> : <div>Uses: {usageCountValue}</div>}
			                      {allowedProducts.length > 0 && <div>Allowed SKUs: {allowedProducts.join(', ')}</div>}
			                      <div>Payment: {paymentMethodLabel}</div>
			                      <div>Markup: {Math.round((markupPercentValue + Number.EPSILON) * 100) / 100}%</div>
			                      {statusRaw && <div>Status: {statusRaw.replace(/_/g, ' ')}</div>}
			                      {hasProposal && (
			                        <div className="font-semibold text-slate-700">
			                          Proposal: {proposalLabel || 'Pending review'}
		                        </div>
		                      )}
		                    </div>
	                  </div>
			                  <div className="patient-link-actions sm:self-start">
		                    <div className="patient-link-action-buttons flex flex-wrap items-center justify-start sm:justify-end gap-2">
			                      {hasProposal && (
			                        <Button
			                        type="button"
			                        variant="outline"
		                        size="sm"
		                        onClick={() => {
                              if (proposalActionLabel === 'Review Proposal') {
                                trackUsageEvent('delegate_proposal_review_clicked', {
                                  token,
                                  status: proposalStatus || 'pending',
                                });
                              }
                              void handleViewPatientProposal(token);
                            }}
		                        disabled={!token || isProposalBusy}
		                        className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
		                      >
		                        <ClipboardDocumentListIcon className="h-4 w-4" />
		                        {isProposalBusy ? 'Loading…' : proposalActionLabel}
		                      </Button>
		                      )}
		                      <Button
		                        type="button"
		                      variant="outline"
		                      size="sm"
		                      onClick={() => handleViewPatientLink(token)}
		                      disabled={!token}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
	                    >
	                      <Eye className="h-4 w-4" aria-hidden="true" />
	                      View
	                    </Button>
		                      <Button
		                        type="button"
		                      variant="outline"
		                      size="sm"
		                      onClick={() => void handleCopyPatientLink(token)}
		                      disabled={!token}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
	                    >
	                      <Copy className="h-4 w-4" aria-hidden="true" />
	                      Copy link
	                    </Button>
	                      <Button
	                        type="button"
		                      variant="outline"
		                      size="sm"
		                      onClick={() => {
                            if (isRevoked) {
                              void handleDeletePatientLink(token);
                              return;
                            }
                            void handleRevokePatientLink(token);
                          }}
		                      disabled={!token || isUpdating || isDeleting}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm bg-white text-slate-900"
                          aria-label={isRevoked ? 'Delete revoked link permanently' : 'Revoke link'}
                          title={isRevoked ? 'Delete permanently' : 'Revoke link'}
		                    >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : isRevoked ? (
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            'Revoke link'
                          )}
			                    </Button>
			                    </div>
			                    {hasProposal && (
		                      <div
		                        className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2"
		                        aria-label="Received payment tracker"
		                      >
		                        <div className="min-w-0 flex-1 flex flex-col">
		                          <span className="text-xs font-semibold text-slate-700 whitespace-normal break-words">
		                            Payment Tracker
		                          </span>
		                          <span className="text-xs font-normal text-slate-700 whitespace-normal break-words">
		                            Have you received payment yet?
		                          </span>
		                        </div>
		                        <div className="flex shrink-0 items-center gap-2">
			                          <Button
			                            type="button"
			                            variant="outline"
			                            size="icon"
			                            onClick={() => void handleSetPatientLinkPaymentReceived(token, false)}
			                            disabled={!token || isUpdatingReceivedPayment || !receivedPayment}
			                            className={
			                              receivedPayment
			                                ? "header-home-button patient-link-payment-toggle-button h-9 w-9 squircle-sm bg-white text-slate-900"
			                                : "header-home-button patient-link-payment-toggle-button h-9 w-9 squircle-sm bg-white text-slate-900"
			                            }
			                            title="Mark unpaid"
			                            aria-label="Mark unpaid"
			                          >
			                            <X className="h-4 w-4" aria-hidden="true" />
			                          </Button>
			                          <Button
			                            type="button"
			                            variant="outline"
			                            size="icon"
			                            onClick={() => void handleSetPatientLinkPaymentReceived(token, true)}
			                            disabled={!token || isUpdatingReceivedPayment || receivedPayment}
			                            className={
			                              receivedPayment
			                                ? "header-home-button patient-link-payment-toggle-button h-9 w-9 squircle-sm bg-white text-slate-900"
			                                : "header-home-button patient-link-payment-toggle-button h-9 w-9 squircle-sm bg-white text-slate-900"
			                            }
			                            title="Mark paid"
			                            aria-label="Mark paid"
			                          >
			                            <Check className="h-4 w-4" aria-hidden="true" />
			                          </Button>
			                        </div>
			                      </div>
			                    )}
                          {hasProposal && (
                            <div className="w-full rounded-xl border border-slate-200 bg-white/70 px-3 py-3">
                              <div className="space-y-2">
                                <Label
                                  htmlFor={`patient-link-review-notes-${token || label}`}
                                  className="text-xs font-semibold text-slate-700"
                                >
                                  Rejection or suggestion notes
                                </Label>
                                <Textarea
                                  id={`patient-link-review-notes-${token || label}`}
                                  value={reviewNotesDraft}
                                  onChange={(event) => {
                                    setPatientLinkReviewNotesDraftByToken((prev) => ({
                                      ...prev,
                                      [token]: event.target.value,
                                    }));
                                    trackPatientLinkFieldEntry('proposal_review_notes', event.target.value);
                                  }}
                                  rows={3}
                                  placeholder="Add notes for the delegate here."
                                  className="min-h-[72px] resize-y squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
                                />
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-slate-500">
                                    These notes are shown to the delegate in their proposal status panel.
                                  </span>
                                  <div className="flex items-center gap-2">
                                    {reviewNotesDirty && (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                          setPatientLinkReviewNotesDraftByToken((prev) => ({
                                            ...prev,
                                            [token]: proposalReviewNotes,
                                          }));
                                        }}
                                        disabled={isSavingReviewNotes}
                                        className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
                                      >
                                        Reset
                                      </Button>
                                    )}
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => void handleSavePatientLinkReviewNotes(token, proposalStatus)}
                                      disabled={!token || isSavingReviewNotes || !reviewNotesDirty}
                                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
                                    >
                                      {isSavingReviewNotes ? 'Saving…' : 'Save notes'}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
			                    {!hasProposal && (
			                      <div
			                        aria-hidden="true"
			                        className="my-1 w-full block"
			                        style={{
			                          height: '1px',
			                          backgroundColor: 'rgb(226,232,240)',
			                          borderRadius: '999px',
			                        }}
			                      />
			                    )}
			                    <details className="patient-link-settings-details mt-0 w-full rounded-xl bg-white/70 px-3 py-2">
			                      <summary className="patient-link-settings-summary">
			                        Payment settings (delegate)
			                      </summary>
	                      <div className="mt-3 space-y-3">
	                        <div className="space-y-1">
	                          <Label
	                            htmlFor={`patient-link-payment-method-${token || label}`}
	                            className="text-xs font-semibold text-slate-700"
	                          >
	                            Payment method
	                          </Label>
		                          <select
		                            id={`patient-link-payment-method-${token || label}`}
		                            value={paymentMethodDraft}
		                            onChange={(event) => {
	                              const next = normalizePatientLinkPaymentMethod(event.target.value);
	                              setPatientLinkPaymentMethodDraftByToken((prev) => ({ ...prev, [token]: next }));
	                              setPatientLinkInstructionsDraftByToken((prev) => {
	                                const existing = typeof prev[token] === 'string' ? prev[token] : '';
	                                const currentDefault = buildPatientLinkDefaultInstructions(
	                                  paymentMethodDraft,
	                                  localUser?.zelleContact ?? null,
	                                  localUser?.name ?? user?.name ?? null,
	                                );
	                                const shouldReplace =
	                                  !existing.trim()
	                                  || existing.trim() === currentDefault.trim();
	                                if (!shouldReplace) return { ...prev, [token]: existing };
	                                return {
	                                  ...prev,
	                                  [token]: buildPatientLinkDefaultInstructions(next, localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null),
	                                };
	                              });
	                            }}
		                            className="patient-link-payment-method-select h-10 w-full squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
		                          >
	                            {patientLinkPaymentMethodOptions.map((opt) => (
	                              <option key={opt.value} value={opt.value}>
	                                {opt.label}
	                              </option>
	                            ))}
	                          </select>
	                        </div>
	                        <div className="space-y-1">
	                          <Label
	                            htmlFor={`patient-link-payment-instructions-${token || label}`}
	                            className="text-xs font-semibold text-slate-700"
	                          >
	                            Instructions
	                          </Label>
	                          <Textarea
	                            id={`patient-link-payment-instructions-${token || label}`}
	                            value={paymentInstructionsDraft}
	                            onChange={(event) =>
	                              setPatientLinkInstructionsDraftByToken((prev) => ({ ...prev, [token]: event.target.value }))
	                            }
	                            rows={2}
	                            className="min-h-[56px] resize-y squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
	                          />
	                        </div>
	                        <div className="flex items-center justify-end">
	                          <Button
	                            type="button"
	                            variant="outline"
	                            size="sm"
	                            onClick={() => void handleSavePatientLinkPaymentSettings(token)}
	                            disabled={!token || isSavingPayment}
	                            className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
	                          >
	                            {isSavingPayment ? 'Saving…' : 'Save'}
	                          </Button>
	                        </div>
	                      </div>
	                    </details>
		                  </div>
		                </div>
		              );
            })}
	          </div>
	        )}
	      </div>
    </div>
  ) : null;

  const activeAccountPanel =
    accountTab === 'details'
      ? accountInfoPanel
      : accountTab === 'orders'
        ? accountOrdersPanel
        : accountTab === 'patient_links'
          ? patientLinksPanel
          : researchPanel;

  const researchOverlayStyle: CSSProperties =
    researchOverlayRect && !researchOverlayExpanded
      ? {
          top: researchOverlayRect.top,
          left: researchOverlayRect.left,
          width: researchOverlayRect.width,
          height: researchOverlayRect.height,
          backgroundColor: "#fff",
        }
      : {
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: "100%",
          backgroundColor: "#fff",
        };

  const delegateDoctorLabel = (() => {
    const raw = typeof delegateDoctorName === 'string' ? delegateDoctorName.trim() : '';
    if (!raw) return 'Physician';
    if (raw.toLowerCase() === 'doctor') return 'Physician';
    return `Dr. ${raw}`;
  })();

		  const authControls = delegateMode ? (
		    <div className="flex items-center gap-2 min-w-0 max-w-full">
		      <div
		        className="squircle-sm inline-flex items-center gap-2 select-none cursor-default min-w-0 max-w-[58vw] sm:max-w-[20rem] flex-shrink overflow-hidden px-4 py-2 sm:px-5 sm:py-2.5 text-sm sm:text-base border-0 !border-0 !bg-transparent"
		        aria-label={`Delegate of ${delegateDoctorLabel}`}
		        title={`Delegate of ${delegateDoctorLabel}`}
		        style={{
		          border: '0',
		          backgroundColor: 'transparent',
		          color: secondaryColor,
		        }}
		      >
		        <User className={delegateUserIconClassName} aria-hidden="true" style={{ color: secondaryColor }} />
		        <span className="font-semibold truncate min-w-0 max-w-full">{`Delegate of ${delegateDoctorLabel}`}</span>
      </div>
      {renderCartButton()}
    </div>
  ) : user ? (
    <>
      <Dialog open={welcomeOpen} modal={!legalModalOpen} onOpenChange={(open) => {
        console.debug('[Header] Welcome dialog open change', { open });
        if (!open && legalModalOpen) {
          console.debug('[Header] Welcome dialog close blocked by legal modal');
          return;
        }
        setWelcomeOpen(open);
      }}>
        <DialogTrigger asChild>
	          <Button
	            type="button"
	            variant="default"
	            size="sm"
	            onClick={() => setWelcomeOpen(true)}
	            className="relative overflow-visible squircle-sm header-home-button transition-all duration-300 whitespace-nowrap pl-1 pr-0 header-account-button justify-start"
	            aria-haspopup="dialog"
	            aria-expanded={welcomeOpen}
	          >
	            <span className="header-account-name text-current">
                {headerDisplayName}
              </span>
	            <span className="header-account-avatar-shell">
	              {renderAvatar(isLargeScreen ? 48 : 53, 'header-account-avatar')}
                {accountButtonIndicatorTotal > 0 && (
                  <Badge
                    variant="outline"
                    className="account-indicator-badge absolute -top-2 -right-2 header-count-indicator flex h-5 w-5 items-center justify-center p-0 squircle-sm border border-[var(--brand-glass-border-2)] text-[rgb(95,179,249)]"
                    aria-label={`Notifications: ${accountButtonIndicatorTotal}`}
                    title={`Notifications: ${accountButtonIndicatorTotal}`}
                  >
                    {accountButtonIndicatorTotal > 9 ? '9+' : accountButtonIndicatorTotal}
                  </Badge>
                )}
	            </span>
          </Button>
			        </DialogTrigger>
					        <DialogContent
					          className="checkout-modal account-modal glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
                    overlayClassName="bg-slate-950/40"
                    containerClassName="fixed inset-0 z-[10000] flex items-start justify-center px-3 py-6 sm:px-4 sm:py-8"
                    containerStyle={
                      legalModalOpen
                        ? ({
                            paddingTop: "calc(var(--safe-area-top) + 0.75rem)",
                            ["--modal-header-offset" as any]: "0px",
                            pointerEvents: 'none',
                          } as CSSProperties)
                        : ({
                            paddingTop: "calc(var(--safe-area-top) + 0.75rem)",
                            ["--modal-header-offset" as any]: "0px",
                          } as CSSProperties)
                    }
	              style={{
                  backdropFilter: "blur(38px) saturate(1.6)",
                  backgroundColor: "rgba(245, 251, 255, 1)",
                  ["--modal-header-offset" as any]: "0px",
                }}
                  data-legal-overlay={legalModalOpen ? 'true' : 'false'}
                  trapFocus={!legalModalOpen}
                  disableOutsidePointerEvents={false}
					          >
				          <div
				            ref={accountModalShellRef}
				            className="relative w-full flex flex-col overflow-hidden transition-all duration-300 ease-in-out"
			            style={{
			              position: "relative",
	                  height: "auto",
		                  maxHeight: "90vh",
				            }}
				          >
	            <DialogHeader
	              className={clsx(
	                "sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg flex items-start justify-between gap-4 transition-opacity duration-300 ease-in-out",
	                isResearchFullscreen && "opacity-0 invisible pointer-events-none select-none",
	              )}
              style={{ boxShadow: '0 18px 28px -20px rgba(7,18,36,0.3)' }}
            >
            <div className="flex-1 min-w-0 max-w-full space-y-3 account-header-content">
	            <div className="flex items-center gap-3 flex-wrap min-w-0">
	              <DialogTitle className="text-xl font-semibold header-user-name min-w-0 truncate">
	                  {localUser?.name || user?.name || 'Account'}
	                </DialogTitle>
                {!suppressAccountHomeButton && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">
                      |
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="header-home-button squircle-sm text-slate-900 gap-2"
                      onClick={() => {
                        setWelcomeOpen(false);
                        setTimeout(() => {
                          if (onShowInfo) {
                            onShowInfo();
                          }
                        }, 100);
                      }}
                    >
                      <Home
                        className="h-5 w-5 text-[rgb(95,179,249)]"
                        aria-hidden="true"
                      />
                    </Button>
                  </>
                )}
	              </div>
              <DialogDescription className="account-header-description">
                {((localUser?.visits ?? user?.visits ?? 1) > 1)
                  ? ``
                  : `We are thrilled to have you with us—let's make healthcare fulfilling together!`}
              </DialogDescription>
              <p
                className="w-full text-sm text-slate-600"
                style={{ maxWidth: '53rem' }}
              >
                We appreciate you joining us, and we are honored to be your provider. Our services will grow to enable excellence in more areas of healthcare with continued updates, and we are very excited to see the network grow in reach and function.
              </p>
              <p className="text-sm font-bold text-slate-600">
                {accountTabDescriptionById[accountTab]}
              </p>
              <div className="relative w-full">
                <div
                  className="w-full account-tab-scroll-container"
                  ref={tabsContainerRef}
                  onMouseDown={handleTabScrollMouseDown}
                  onMouseMove={handleTabScrollMouseMove}
                  onMouseUp={handleTabScrollMouseUp}
                  onMouseLeave={handleTabScrollMouseLeave}
                  onTouchStart={handleTabScrollTouchStart}
                  onTouchMove={handleTabScrollTouchMove}
                  onTouchEnd={handleTabScrollTouchEnd}
                  onWheel={handleTabScrollWheel}
                >
                  <div className="flex items-center gap-4 pb-0 sm:pb-4 account-tab-row">
                    {accountHeaderTabs.map((tab) => {
                      const isActive = accountTab === tab.id;
                      const indicatorCount = Number(accountTabIndicatorCounts[tab.id] || 0);
                      const showIndicator = indicatorCount > 0;
	                      return (
	                        <button
	                          key={tab.id}
                          type="button"
	                          className={clsx(
	                            'relative inline-flex items-center gap-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors text-slate-600 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black/30 flex-shrink-0 overflow-visible',
	                            isActive && 'text-slate-900'
	                          )}
                          data-tab={tab.id}
                          aria-pressed={isActive}
	                          onClick={() => {
                              setAccountTab(tab.id);
                              if (tab.id === 'patient_links') {
                                trackUsageEvent('delegate_link_tab_clicked', {
                                  tab: 'delegate_links',
                                  tabLabel: tab.label,
                                });
                              }
                            }}
	                        >
			                          <span className="relative inline-flex h-6 w-6 items-center justify-center overflow-visible">
			                            <tab.Icon className="h-3.5 w-3.5" aria-hidden="true" />
		                          </span>
                          <span className="inline-flex items-center">
                            {tab.label}
                            {showIndicator && (
                              <Badge
                                variant="outline"
                                className={clsx(
                                  "ml-2 inline-flex !h-5 !w-5 shrink-0 items-center justify-center !p-0 glass-strong squircle-sm border border-[var(--brand-glass-border-2)] !text-[rgb(95,179,249)] font-semibold leading-none shadow-sm pointer-events-none transition-opacity duration-150",
                                  showIndicator ? "opacity-100" : "opacity-0",
                                )}
                                title={`${tab.label} notifications`}
                                aria-label={showIndicator ? `${tab.label} notifications: ${indicatorCount}` : undefined}
                                aria-hidden={showIndicator ? undefined : true}
                                style={{ color: 'rgb(95,179,249)' }}
                              >
                                {showIndicator ? (indicatorCount > 9 ? '9+' : indicatorCount) : ''}
                              </Badge>
                            )}
                          </span>
	                        </button>
	                      );
	                    })}
	                  </div>
                </div>
                <span
                  aria-hidden="true"
                  className="account-tab-underline-indicator"
                  style={{ left: indicatorLeft, width: indicatorWidth, opacity: indicatorOpacity }}
                />
              </div>
            </div>
	          </DialogHeader>
          <div
            ref={accountModalScrollRef}
            className={clsx(
              "flex-1 overflow-y-auto px-6 pb-6",
              isResearchFullscreen && "opacity-0 invisible pointer-events-none select-none",
            )}
          >
		            <div className="space-y-6 pt-4">
		              {!isResearchFullscreen &&
		                (activeAccountPanel ?? (
		                  <div className="text-sm text-slate-600">
		                    Loading account details...
		                  </div>
		                ))}
		            </div>
		          </div>
          {isResearchFullscreen && (
            <div
              className="absolute z-30 overflow-hidden bg-white opacity-100 mix-blend-normal transition-[top,left,width,height,opacity] duration-300 ease-in-out p-4 sm:p-6"
              style={{
                ...researchOverlayStyle,
                borderRadius: "inherit",
                willChange: "top, left, width, height",
              }}
            >
              <div className="relative z-10 h-full w-full overflow-y-auto bg-white">
                {researchPanel}
              </div>
            </div>
          )}
          <div
            className={clsx(
              "border-t border-[var(--brand-glass-border-1)] px-6 py-4 flex justify-end transition-opacity duration-300 ease-in-out",
              isResearchFullscreen && "hidden",
            )}
          >
		            <Button
		              type="button"
		              variant="outline"
		              size="sm"
	              className="btn-no-hover header-logout-button squircle-sm bg-transparent text-slate-900 border-0"
	              onClick={handleLogoutClick}
	            >
	              <LogOut className="h-4 w-4 mr-2" />
		              Logout
		            </Button>
		          </div>
	          </div>
	        </DialogContent>
      </Dialog>
	      <Dialog open={deleteAccountModalOpen} onOpenChange={handleDeleteAccountModalOpenChange}>
	        <DialogContent
	          className="glass-card squircle-lg w-full !max-w-[min(468px,calc(100vw-3rem))] sm:!max-w-[min(468px,calc(100vw-3rem))] lg:!max-w-[min(468px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 overflow-hidden"
	          overlayClassName="bg-slate-950/40"
	          containerClassName="fixed inset-0 z-[10001] flex items-center justify-center p-4 sm:p-6"
	          style={{
	            backdropFilter: "blur(32px) saturate(1.45)",
	            backgroundColor: "rgba(245, 251, 255, 0.98)",
		            width: "min(468px, calc(100vw - 3rem))",
		            maxWidth: "min(468px, calc(100vw - 3rem))",
	          }}
	        >
          <DialogHeader className="border-b border-[var(--brand-glass-border-1)] px-6 py-4">
            <DialogTitle className="text-lg font-semibold text-slate-900">Delete Account</DialogTitle>
          </DialogHeader>
	          <div className="space-y-4 px-6 py-5">
	            <p className="text-sm leading-6 text-slate-700">
	              By deleting your account, you understand that all of your data stored within PepPro databases will be lost except anything publically available to the network on PepPro&apos;s research services or otherwise. For those publications, it is your responsibility to fascilitate closure, and if you need further assistance after account suspension contact support@peppro.net.
	            </p>
	            <div className="flex justify-end gap-3">
	              <Button
	                type="button"
	                variant="outline"
	                size="sm"
	                className="header-home-button squircle-sm bg-white text-slate-900"
	                disabled={deleteAccountDeleting}
	                onPointerDown={(event) => {
	                  if (event.pointerType === 'mouse' && event.button !== 0) return;
	                  event.preventDefault();
	                  beginDeleteAccountHold();
	                }}
	                onPointerUp={resetDeleteAccountHold}
	                onPointerLeave={resetDeleteAccountHold}
	                onPointerCancel={resetDeleteAccountHold}
	                onBlur={resetDeleteAccountHold}
	                onContextMenu={(event) => event.preventDefault()}
	                aria-label="Hold for 3 seconds to delete account"
	              >
	                {deleteAccountDeleting
	                  ? 'Deleting account…'
	                  : deleteAccountHoldCount > 0
	                    ? `Hold to delete account ${deleteAccountHoldCount}`
	                    : 'Hold to delete account'}
	              </Button>
	              <Button
	                type="button"
	                variant="outline"
	                size="sm"
	                className="squircle-sm border-[rgba(95,179,249,0.35)] text-[rgb(95,179,249)] hover:bg-[rgb(95,179,249)] hover:text-white"
	                onClick={() => handleDeleteAccountModalOpenChange(false)}
	              >
	                Close
	              </Button>
	            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={logoutThanksOpen} onOpenChange={handleLogoutThanksOpenChange}>
        <DialogContent
          hideCloseButton
          className="logout-thanks-modal relative self-start !mx-auto !mb-6 !mt-0 duration-[250ms] data-[state=closed]:duration-[250ms] !max-w-[min(28rem,calc(100vw-2rem))]"
          overlayClassName="logout-thanks-overlay"
          onTransitionEnd={(event) => {
            if (event.propertyName !== 'opacity') return;
            if (!logoutThanksPendingFadeOutRef.current) return;
            if (logoutThanksOpacity !== 0) return;
            finishLogoutModalClose();
          }}
	          style={{
	            maxWidth: 'min(32rem, calc(100vw - 2rem))',
	            backgroundColor: 'rgba(250, 253, 255, 0.985)',
	            backdropFilter: 'blur(8px) saturate(1.1)',
	            WebkitBackdropFilter: 'blur(8px) saturate(1.1)',
	            opacity: logoutThanksOpacity,
              // Use a CSS var so we can override global `!important` transition rules.
              ["--logout-thanks-ms" as any]: `${logoutThanksTransitionMs}ms`,
	          }}
	          containerClassName="fixed inset-0 z-[10000] flex items-start justify-center px-6 pb-6 md:px-10 md:pb-10"
          overlayStyle={{
            backgroundColor: 'rgba(4, 14, 21, 0.45)',
            backdropFilter: 'blur(22px) saturate(1.35)',
            WebkitBackdropFilter: 'blur(22px) saturate(1.35)',
            opacity: logoutThanksOpacity,
            ["--logout-thanks-ms" as any]: `${logoutThanksTransitionMs}ms`,
          }}
        >
          <VisuallyHidden>
            <DialogTitle>Logged out</DialogTitle>
            <DialogDescription>Thank you message after logging out.</DialogDescription>
          </VisuallyHidden>
          <div className="px-8 py-10 text-center sm:px-10 sm:py-16">
            <p className="text-base leading-relaxed" style={{ color: secondaryColor }}>
              Thank you for being a partner of ours and a joy to those around you. We at PepPro wish you a great rest
              of your day and will be here when you need us!
	            </p>
	          </div>
	        </DialogContent>
	      </Dialog>
	      {renderCartButton()}
	    </>
	  ) : (
    <>
      <Dialog open={loginOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          <Button
            variant="default"
            className="squircle-sm glass-brand-subtle btn-hover-lighter transition-all duration-300 whitespace-nowrap"
          >
            <User className="h-4 w-4 flex-shrink-0" />
            <span className="hidden sm:inline ml-2">Login</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          forceMount
          className="glass-card squircle-xl w-auto border border-[var(--brand-glass-border-2)] shadow-2xl !p-4 sm:!p-6"
          style={{
            backdropFilter: 'blur(38px) saturate(1.6)',
            width: 'min(560px, calc(100vw - 4.5rem))',
            maxWidth: 'min(560px, calc(100vw - 4.5rem))',
          }}
        >
          <DialogHeader
            className="flex items-start justify-between gap-4 border-b border-[var(--brand-glass-border-1)] pb-3"
            style={{
              boxShadow: '0 20px 45px -18px rgba(15,23,42,0.1)',
              position: 'relative',
              zIndex: 20,
            }}
          >
	            <div className="flex-1 min-w-0 space-y-1">
	              <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
	                {authMode === 'login' ? 'Welcome back' : 'Create Account'}
	              </DialogTitle>
	              <DialogDescription>
	                {authMode === 'login'
	                  ? 'Login to enter your PepPro account.'
	                  : 'Create your PepPro physician account to access PepPro.'}
	              </DialogDescription>
	              {authMode === 'signup' && (
	                <p className="text-base leading-snug" style={{ color: secondaryColor }}>
	                  Your representative will work with you, if intended, to collect your resellers permit.
	                </p>
	              )}
	            </div>
            <DialogClose
              className="dialog-close-btn inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full p-0 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              style={{
                backgroundColor: 'rgb(95, 179, 249)',
                borderRadius: '50%',
              }}
              aria-label="Close account modal"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </DialogHeader>
          {authMode === 'login' ? (
            <div className="space-y-5">
              <form
                id="login-form"
                name="login"
                method="post"
                ref={loginFormRef}
                autoComplete="on"
                onSubmit={handleLogin}
                className="space-y-4"
              >
                <div className="space-y-3">
                  <Label htmlFor="login-email">Email</Label>
                  <Input
                    ref={loginEmailRef}
                    id="login-email"
                    name="username"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                </div>
                {/* Login password */}
                <div className="space-y-3">
                  <Label htmlFor="login-password">Password</Label>
                  <div className="relative mt-1">
                    <Input
                      ref={loginPasswordRef}
                      id="login-password"
                      name="password"
                      autoComplete="current-password"
                      type={showLoginPassword ? 'text' : 'password'}
                      autoCorrect="off"
                      spellCheck={false}
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.12)] btn-hover-lighter"
                      aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showLoginPassword}
                    >
                      {showLoginPassword ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span className="sr-only">Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {loginError && (
                  <p className="text-sm text-red-600">{loginError}</p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                  disabled={loginSubmitting}
                >
                  {loginSubmitting && (
                      <Loader2
                        className="h-4 w-4 animate-spin-slow text-white shrink-0"
                      aria-hidden="true"
                      style={{ transformOrigin: 'center center', transform: 'translateZ(0)' }}
                    />
                  )}
                  {loginSubmitting ? 'Signing in…' : 'Sign In'}
                </Button>
              </form>
              <p className="text-center text-sm text-gray-600">
                New to PepPro?{' '}
                <button
                  type="button"
                  onClick={() => setAuthMode('signup')}
                  className="font-semibold btn-hover-lighter"
                  style={{ color: secondaryColor }}
                >
                  Create an account
                </button>
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <form onSubmit={handleSignup} autoComplete="on" className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                  <div className="space-y-2 sm:w-36 sm:pb-0">
                    <Label htmlFor="suffix">
                      <span>Suffix</span>
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        Optional
                      </span>
                    </Label>
                    <select
                      id="suffix"
                      value={signupSuffix}
                      onChange={(e) => setSignupSuffix(e.target.value)}
                      className="glass squircle-sm mt-1 w-full px-3 text-sm border transition-colors focus-visible:outline-none focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[3px] focus-visible:ring-[rgba(95,179,249,0.3)] leading-tight"
                      style={{
                        borderColor: translucentSecondary,
                        backgroundColor: 'rgba(95,179,249,0.02)',
                        WebkitAppearance: 'none',
                        MozAppearance: 'none',
                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23071b1b' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'right 0.75rem center',
                        backgroundSize: '12px',
                        paddingRight: '2.5rem',
                        height: '2.5rem',
                        lineHeight: '1.25rem'
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
                  <div className="flex-1 space-y-2 sm:pb-0">
                    <Label htmlFor="name">Full Name</Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    type="text"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    className="glass squircle-sm mt-1 h-10 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                  </div>
                </div>
                <div className="space-y-3">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    name="email"
                    autoComplete="email"
                    type="email"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                </div>
                {/* Signup password */}
                <div className="space-y-3">
                  <Label htmlFor="signup-password">Password</Label>
                  <div className="relative mt-1">
                    <Input
                      id="signup-password"
                      name="password"
                      autoComplete="new-password"
                      type={showSignupPassword ? 'text' : 'password'}
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.12)] btn-hover-lighter"
                      aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showSignupPassword}
                    >
                      {showSignupPassword ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span className="sr-only">Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {/* Signup confirm password */}
                <div className="space-y-3">
                  <Label htmlFor="signup-confirm-password">Confirm Password</Label>
                  <div className="relative mt-1">
                    <Input
                      id="signup-confirm-password"
                      name="confirm-password"
                      autoComplete="new-password"
                      type={showSignupConfirmPassword ? 'text' : 'password'}
                      value={signupConfirmPassword}
                      onChange={(e) => setSignupConfirmPassword(e.target.value)}
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupConfirmPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.12)] btn-hover-lighter"
                      aria-label={showSignupConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                      aria-pressed={showSignupConfirmPassword}
                    >
                      {showSignupConfirmPassword ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span className="sr-only">Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {/* Signup referral code */}
                <div className="space-y-3">
                  <Label htmlFor="signup-code">Referral Code</Label>
                  <Input
                    id="signup-code"
                    name="referral-code"
                    autoComplete="off"
                    value={signupCode}
                    onChange={(e) => setSignupCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
                    maxLength={5}
                    inputMode="text"
                    pattern="[A-Z0-9]*"
                    className="glass squircle-sm focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary, textTransform: 'uppercase' }}
                    required
                  />
                  <p className="text-xs text-slate-500">Codes are 5 characters and issued by your sales representative.</p>
                </div>
                {signupError && (
                  <p className="text-sm text-red-600">{signupError}</p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full squircle-sm glass-brand btn-hover-lighter"
                >
                  Create Account
                </Button>
              </form>
              <p className="text-center text-sm text-gray-600">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => setAuthMode('login')}
                  className="font-semibold btn-hover-lighter"
                  style={{ color: secondaryColor }}
                >
                  Sign in
                </button>
              </p>
            </div>
          )}
          <div className="mt-6 glass squircle-lg p-4 sm:p-5 space-y-4 border border-[var(--brand-glass-border-1)]">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-slate-800">Track an order</h3>
              <p className="text-sm text-slate-600">
                Enter your PepPro order ID and email. We&apos;ll email you the latest fulfillment update.
              </p>
            </div>
            <form autoComplete="off" className="grid gap-3 sm:grid-cols-2" onSubmit={handleTrackOrder}>
              <div>
                <Label htmlFor="account-track-id">Order ID</Label>
                  <Input
                    id="account-track-id"
                    name="tracking-order-id"
                    autoComplete="off"
                    value={trackingForm.orderId}
                    onChange={(event) => setTrackingForm((prev) => ({ ...prev, orderId: event.target.value }))}
                  className="mt-1"
                  placeholder="ORD-12345"
                  required
                />
              </div>
              <div>
                <Label htmlFor="account-track-email">Email</Label>
                  <Input
                    id="account-track-email"
                    name="tracking-email"
                    type="email"
                    autoComplete="off"
                    value={trackingForm.email}
                  onChange={(event) => setTrackingForm((prev) => ({ ...prev, email: event.target.value }))}
                  className="mt-1"
                  placeholder="you@example.com"
                />
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  className="glass-brand squircle-sm inline-flex items-center gap-2"
                  disabled={trackingPending}
                >
                  {trackingPending && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-current shrink-0"
                      aria-hidden="true"
                      style={{ transformOrigin: 'center center' }}
                    />
                  )}
                  {trackingPending ? 'Checking…' : 'Email tracking link'}
                </Button>
                {trackingMessage && (
                  <p className="text-sm text-slate-600">{trackingMessage}</p>
                )}
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
      {renderCartButton()}
    </>
	  );

				  return (
				    <header
				      ref={headerRef}
				      data-app-header
			      className={clsx(
			        "w-full app-header-blur border-b border-slate-200 shadow-sm",
			        welcomeOpen && "app-header-hidden",
			      )}
			      style={{
			        position: 'fixed',
			        top: 0,
			        left: 0,
			        right: 0,
			        zIndex: welcomeOpen ? 1 : 9500,
			        opacity: welcomeOpen ? 0 : 1,
			        pointerEvents: welcomeOpen ? 'none' : 'auto',
			      }}
			    >
      <div className="w-full px-4 sm:px-6 py-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div className="flex w-full flex-nowrap items-center gap-3 sm:gap-4 justify-between">
	            {/* Logo (same header layout for doctor + delegate) */}
	            <div className="flex items-center gap-3 min-w-0 flex-shrink-0 self-center">
	              <div className="flex items-center gap-3">
		                <div
		                  className="brand-logo relative flex items-center justify-center flex-shrink-0"
		                  style={{ height: logoSizing.heightPx }}
		                >
		                  <img
	                    src={
	                      delegateMode
	                        ? ((typeof delegateLogoUrl === 'string' && delegateLogoUrl.trim().length > 0)
	                          ? delegateLogoUrl
	                          : withStaticAssetStamp('/PepPro_fulllogo.png'))
	                        : withStaticAssetStamp('/PepPro_fulllogo.png')
		                    }
	                    alt={delegateMode ? 'Physician logo' : 'PepPro logo'}
		                    className="relative z-[1] flex-shrink-0"
		                    style={{
		                      display: 'block',
		                      width: 'auto',
		                      height: '100%',
		                      maxWidth: logoSizing.maxWidth,
		                      maxHeight: '100%',
		                      objectFit: 'contain',
		                    }}
	                    loading="eager"
	                    decoding="async"
	                  />
	                </div>
	              </div>
                {!delegateMode && user && onShowInfo && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onShowInfo}
                    className="shop-home-button squircle-sm"
                    aria-label="Home"
                    title="Home"
                  >
                    <Home className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
	            </div>

            {/* Search Bar - Desktop (centered) */}
            {isLargeScreen && (
              <form
                onSubmit={handleSearch}
                className="flex flex-1 items-center justify-center self-center"
              >
                <div className="w-full max-w-md">
                  {renderSearchField()}
                </div>
              </form>
            )}

	            {/* User Actions */}
	            <div className="ml-auto flex items-center gap-2 md:gap-4 flex-wrap sm:flex-nowrap justify-end min-w-0 max-w-full">
		              {(networkQuality === 'offline' || networkQuality === 'poor') && (
		                <div
		                  className="flex items-center justify-center squircle-sm border border-slate-200 bg-white/70 px-2 py-1"
			                  title={
			                    networkQuality === 'offline'
	                          ? 'Offline'
                          : (() => {
                              const parts: string[] = [];
                              if (typeof networkSpeedSummary.downloadMbps === 'number') {
                                parts.push(`Down ${networkSpeedSummary.downloadMbps} Mbps`);
                              }
                              if (typeof networkSpeedSummary.latencyMs === 'number') {
                                parts.push(`Latency ${networkSpeedSummary.latencyMs} ms`);
                              }
                              return `Poor internet connection${parts.length ? ` (${parts.join(' · ')})` : ''}`;
                            })()
			                  }
		                  aria-label={
		                    networkQuality === 'offline' ? 'Offline' : 'Poor internet connection'
		                  }
		                >
		                  {networkQuality === 'offline' ? (
                        <WifiOff className="h-4 w-4 text-slate-800" aria-hidden="true" />
                      ) : (
                        <NetworkBarsIcon activeBars={1} />
                      )}
		                </div>
		              )}
	              {authControls}
	              {!isLargeScreen && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={toggleMobileSearch}
                  aria-expanded={mobileSearchOpen}
                  disabled={Boolean(catalogLoading)}
                  aria-disabled={Boolean(catalogLoading)}
                  className="header-cart-button mobile-search-toggle-button squircle-sm transition-all duration-300"
                  style={delegateMode ? { borderColor: secondaryColor, color: secondaryColor } : undefined}
                >
                  {mobileSearchOpen ? (
                    <X className="h-4 w-4" style={delegateMode ? { color: secondaryColor } : undefined} />
                  ) : (
                    <Search className="h-4 w-4 mobile-search-icon" style={delegateMode ? { color: secondaryColor } : undefined} />
                  )}
                  <span className="sr-only">{mobileSearchOpen ? 'Close search' : 'Open search'}</span>
                </Button>
              )}
            </div>
          </div>

          {mobileSearchOpen && !isLargeScreen && (
            <div className="px-1 pb-2">
              <form onSubmit={handleSearch}>{renderSearchField()}</form>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function EditableRow({
  label,
  value,
  type = 'text',
  autoComplete,
  onSave,
}: {
  label: string;
  value: string;
  type?: string;
  autoComplete?: string;
  onSave: (next: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState(value);
  useEffect(() => setNext(value), [value]);
  const [saving, setSaving] = useState(false);

  const saveValue = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [next, onSave, saving]);

  return (
    <div className="editable-row group flex items-center gap-3">
      <div className="min-w-[7rem] self-center text-sm font-medium text-slate-700">{label}</div>
      <div className="flex-1 flex items-center gap-2 flex-wrap">
        {editing ? (
          <input
            className="w-full h-9 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            value={next}
            type={type}
            autoComplete={autoComplete}
            onChange={(e) => setNext(e.currentTarget.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                await saveValue();
              }
            }}
          />
        ) : (
          <div className="text-sm text-slate-700 flex items-center gap-2">
            <span>{value || '—'}</span>
            <button
              type="button"
              className={clsx('inline-edit-button', editing && 'is-active')}
              onClick={() => setEditing(true)}
              aria-label={`Edit ${label}`}
              title={`Edit ${label}`}
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
        {editing && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="squircle-sm"
              disabled={saving}
              onClick={saveValue}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              className="squircle-sm"
              onClick={() => {
                setNext(value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
