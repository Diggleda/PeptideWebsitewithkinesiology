import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo, FormEvent, MouseEvent, WheelEvent, TouchEvent, ReactNode, CSSProperties, ElementType } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from './ui/dialog';
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { AdjustmentsHorizontalIcon, ArrowDownTrayIcon, ArrowPathIcon, ArrowUturnLeftIcon, BookOpenIcon, CursorArrowRippleIcon, SwatchIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Search, User, Gift, ShoppingCart, LogOut, Home, Copy, X, Check, CheckCircle2, Eye, EyeOff, Pencil, Loader2, Info, Package, Box, Users, WifiOff, Maximize2, Minimize2, Link2, Upload, Trash2, Mail, AlertTriangle, Plus, Truck } from 'lucide-react';
import { toast } from '../lib/toast';
import { AuthActionResult } from '../types/auth';
import clsx from 'clsx';
import { ModalSquircle } from './ui/modal-squircle';
import { proxifyWooMediaUrl } from '../lib/mediaProxy';
import { resolveStaticAssetUrl, withStaticAssetStamp } from '../lib/assetUrl';
import { withLegacyMetaKeys } from '../lib/legacyBrandCompatibility';
import { formatOrderStatusLabel } from '../lib/orderStatusLabels.mjs';
import { shouldDisplayShippingStatusForOrder } from '../lib/orderStatusPrecedence.mjs';
import { formatTimestampedNotesForDisplay } from '../lib/timestampedNotes';
import { parseBackendTimestamp, parseBackendTimestampAsPacificWallTime } from '../lib/timezoneDate';
import { DoctorProfileForm } from './DoctorProfileForm';
import { BrandLogoImage } from './BrandLogoImage';
import delegateLinkBetaImage1 from '../content/marketing/DelegateLinks/DelegateLinkBetaImage1.png';
import delegateLinkBetaImage2 from '../content/marketing/DelegateLinks/DelegateLinkBetaImage2.png';
import { CURRENT_LEGAL_DOCUMENT_VERSIONS, LEGAL_DOCUMENTS } from '../lib/legalDocuments';
import {
  buildBrochureLinkUrl,
  buildResearchSupplyLinkUrl,
} from '../lib/researchSupplyLinks';

const RefreshActionIcon = ({ spinning = false }: { spinning?: boolean }) => (
  <ArrowPathIcon
    className={clsx('h-4 w-4 shrink-0', spinning && 'animate-spin')}
    aria-hidden="true"
  />
);

const normalizeRole = (role?: string | null) => (role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const LOGIN_BACKEND_DOWN_TOAST_ID = 'login-backend-down';
const LOGIN_BACKEND_DOWN_MESSAGE = 'TrufusionLabs is unavailable right now. Please try again in a minute.';
const EMAIL_VERIFICATION_BROADCAST_CHANNEL = 'trufusion-email-verification';
const EMAIL_VERIFICATION_STORAGE_KEY = 'trufusion:email-verification';
const EMAIL_VERIFICATION_BROADCAST_TYPE = 'email_verified';
const EMAIL_VERIFICATION_EVENT_MAX_AGE_MS = 10 * 60 * 1000;

type EmailVerificationBroadcastPayload = {
  type: typeof EMAIL_VERIFICATION_BROADCAST_TYPE;
  email?: string;
  at: number;
};

const normalizeVerificationEmail = (value: unknown) =>
  String(value ?? '').trim().toLowerCase();

const parseEmailVerificationBroadcastPayload = (
  value: unknown,
): EmailVerificationBroadcastPayload | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (payload.type !== EMAIL_VERIFICATION_BROADCAST_TYPE) {
    return null;
  }
  const at = Number(payload.at);
  return {
    type: EMAIL_VERIFICATION_BROADCAST_TYPE,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    at: Number.isFinite(at) ? at : Date.now(),
  };
};
const coerceOptionalBoolean = (value: unknown): boolean | null => {
  if (value === true || value === false) return value;
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
};
const isAdmin = (role?: string | null) => normalizeRole(role) === 'admin';
const isSalesLead = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized !== 'admin' && (normalized === 'sales_lead' || normalized === 'saleslead' || normalized === 'sales-lead');
};
const isRep = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized !== 'admin' && (normalized === 'sales_partner' || normalized === 'sales_rep' || normalized === 'test_rep' || normalized === 'rep' || normalized === 'sales_lead' || normalized === 'saleslead');
};
const isDoctorRole = (role?: string | null) => {
  const normalized = normalizeRole(role);
  return normalized === 'doctor' || normalized === 'test_doctor';
};
const isSalesPartner = (role?: string | null, isPartner?: unknown) => {
  const normalized = normalizeRole(role);
  return normalized !== 'doctor'
    && normalized !== 'test_doctor'
    && (coerceOptionalBoolean(isPartner) === true || normalized === 'sales_partner');
};
const getSalesPartnerLabel = (allowedRetail?: unknown) => {
  const normalized = coerceOptionalBoolean(allowedRetail);
  if (normalized === true) return 'Retail Partner';
  if (normalized === false) return 'Wholesale Partner';
  return 'Sales Partner';
};

type PatientLinkPaymentMethod = 'none' | 'zelle';
type DelegateRole = 'patient' | 'caregiver' | 'staff' | 'research_participant' | 'authorized_representative' | 'other';
type DelegateProductScope = 'all_physician_approved' | 'specific_cart_only' | 'specific_products';
type DelegatePermission = 'view_products_only' | 'submit_for_physician_review';
type CreateLinkDialogMode = 'select' | 'delegate' | 'brochure';
type CreateLinkLegalDocumentKey = 'terms' | 'shipping' | 'privacy';
type PatientLinkType = 'delegate' | 'brochure';
type PatientLinkTypeFilter = 'all' | PatientLinkType;
type PatientLinkConfirmAction = {
  action: 'revoke' | 'delete' | 'modify';
  token: string;
  label: string;
  linkType: PatientLinkType;
};
type PatientLinkEditingState = {
  token: string;
  linkType: PatientLinkType;
  label: string;
  originalProductTokens: string[];
};

const CREATE_LINK_LEGAL_DOCUMENTS: Record<CreateLinkLegalDocumentKey, { title: string; html: string }> = {
  terms: LEGAL_DOCUMENTS.terms,
  shipping: LEGAL_DOCUMENTS.shipping,
  privacy: LEGAL_DOCUMENTS.privacy,
};

const DEFAULT_DELEGATE_LINK_EXPIRY_HOURS = '72';
const DEFAULT_DELEGATE_PRICING_DISCLOSURE =
  'Prices may include physician-directed service, handling, administrative, or research coordination fees.';
const CURRENT_TERMS_VERSION = CURRENT_LEGAL_DOCUMENT_VERSIONS.terms;
const CURRENT_SHIPPING_POLICY_VERSION = CURRENT_LEGAL_DOCUMENT_VERSIONS.shipping;
const CURRENT_PRIVACY_POLICY_VERSION = CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy;

const patientLinkPaymentMethodOptions: Array<{ value: PatientLinkPaymentMethod; label: string }> = [
  { value: 'none', label: 'Hosted checkout' },
  { value: 'zelle', label: 'Zelle' },
];

const delegateRoleOptions: Array<{ value: DelegateRole; label: string }> = [
  { value: 'patient', label: 'Authorized delegate' },
  { value: 'caregiver', label: 'Caregiver' },
  { value: 'staff', label: 'Staff' },
  { value: 'research_participant', label: 'Research participant' },
  { value: 'authorized_representative', label: 'Authorized representative' },
  { value: 'other', label: 'Other' },
];

const delegateProductScopeOptions: Array<{ value: DelegateProductScope; label: string }> = [
  { value: 'all_physician_approved', label: 'All physician-approved products' },
  { value: 'specific_products', label: 'Selected products only' },
  { value: 'specific_cart_only', label: 'Specific cart only' },
];

const delegatePermissionOptions: Array<{ value: DelegatePermission; label: string }> = [
  { value: 'submit_for_physician_review', label: 'Submit proposal for physician review' },
  { value: 'view_products_only', label: 'View only' },
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

const isGeneratedPatientLinkDefaultInstructions = (
  value: string,
  doctorName?: string | null,
) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return true;
  if (/^Please send payment to .+\.$/.test(normalized)) return true;
  const doctor = typeof doctorName === 'string' ? doctorName.trim() : '';
  return normalized === `Reach out to ${doctor || 'your physician'} for Zelle payment details.`;
};

const normalizePatientLinkPaymentMethod = (value: unknown): PatientLinkPaymentMethod => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'zelle') return 'zelle';
  if (raw === 'zelle_ach' || raw === 'zelle/ach' || raw === 'zelle-ach' || raw === 'zelleach') return 'zelle';
  if (raw === 'insurance') return 'none';
  return 'none';
};

const normalizePatientLinkType = (link: unknown): PatientLinkType => {
  const record = link && typeof link === 'object' ? (link as Record<string, unknown>) : {};
  const linkTypeRaw = [
    record.linkType,
    record.link_type,
    record.type,
    record.kind,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  const normalizedLinkType = String(linkTypeRaw || '').trim().toLowerCase();
  return normalizedLinkType.includes('brochure') ? 'brochure' : 'delegate';
};

const getPatientLinkTypeLabel = (type: PatientLinkType) =>
  type === 'brochure' ? 'Brochure' : 'Proposal';

const getPatientLinkTrackingPrefix = (type: PatientLinkType) =>
  type === 'brochure' ? 'brochure_link' : 'delegate_link';

const readPatientLinkText = (link: unknown, keys: string[]): string => {
  const record = link && typeof link === 'object' ? (link as Record<string, unknown>) : {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const readPatientLinkStringList = (link: unknown, keys: string[]): string[] => {
  const record = link && typeof link === 'object' ? (link as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const values: string[] = [];
  for (const key of keys) {
    const raw = record[key];
    const candidates = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(',')
        : [];
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim();
      if (!normalized) continue;
      const dedupeKey = normalized.toUpperCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      values.push(normalized);
    }
  }
  return values;
};

const isPatientLinkRevoked = (link: unknown): boolean => {
  const revokedAt = readPatientLinkText(link, ['revokedAt', 'revoked_at']);
  const status = readPatientLinkText(link, ['status']).toLowerCase();
  return Boolean(revokedAt || status === 'revoked');
};

const createNodeDummyPatientLinks = (_zelleContact?: string | null, _doctorName?: string | null) => {
  void _zelleContact;
  void _doctorName;
  return [];
};

const DEFAULT_DELEGATE_SECONDARY_COLOR = '#0b0679';
const DEFAULT_DELEGATE_BACKGROUND_COLOR = '#377eba';
const HEADER_BRAND_BLUE = 'rgb(11, 6, 121)';
const HEADER_SEARCH_TEXT_GREY = 'rgb(100, 116, 139)';

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

const normalizeDelegateBackgroundColor = normalizeDelegateSecondaryColor;

const normalizeDelegateImageUrl = (value?: string | null) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const toCssUrlValue = (value: string) =>
  `url("${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, '')}")`;

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
type PhysicianDashboardTabId = 'links' | 'orders' | '3pl' | 'refer' | 'settings';

export const PHYSICIAN_DASHBOARD_PORTAL_ID = 'physician-dashboard-root';

const DELEGATE_LINK_FUNNEL_STAGES = [
  { event: 'delegate_link_tab_clicked', label: 'Tab Clicked' },
  { event: 'delegate_link_text_field_entry', label: 'Text Field Entry' },
  { event: 'delegate_link_create_started', label: 'Proposal Started' },
  { event: 'brochure_link_button_clicked', label: 'Brochure Button Clicked' },
  { event: 'delegate_link_created', label: 'Proposal Created' },
  { event: 'delegate_link_copied', label: 'Proposal Copied' },
  { event: 'delegate_link_preview_opened', label: 'Proposal Preview Opened' },
  { event: 'delegate_link_opened', label: 'Proposal Opened' },
  { event: 'delegate_order_estimated', label: 'Proposal Estimated' },
  { event: 'delegate_proposal_shared', label: 'Proposal Shared' },
  { event: 'delegate_proposal_review_clicked', label: 'Review Clicked' },
  { event: 'delegate_proposal_review_loaded', label: 'Review Loaded' },
  { event: 'delegate_proposal_reviewed', label: 'Proposal Reviewed' },
  { event: 'delegate_order_placed', label: 'Proposal Submitted' },
] as const;

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
  isPartner?: boolean | null;
  allowedRetail?: boolean | null;
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
  shadowContext?: {
    active?: boolean;
  } | null;
  profileImageUrl?: string | null;
  profileOnboarding?: boolean;
  resellerPermitOnboardingPresented?: boolean;
  resellerPermitFilePath?: string | null;
  resellerPermitFileName?: string | null;
  resellerPermitUploadedAt?: string | null;
  resellerPermitApprovedByRep?: boolean;
  greaterArea?: string | null;
  studyFocus?: string | null;
  websiteUrl?: string | null;
  bio?: string | null;
  networkPresenceAgreement?: boolean;
  delegateLogoUrl?: string | null;
  delegateSecondaryColor?: string | null;
  delegateBackgroundImageUrl?: string | null;
  delegateBackgroundColor?: string | null;
  delegateLinksEnabled?: boolean;
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
  receivePatientLinkUpdateEmails?: boolean;
  researchTermsAgreement?: boolean;
  researchTermsAgreementVersion?: string | null;
  researchShippingPolicyVersion?: string | null;
  researchPrivacyPolicyVersion?: string | null;
  researchTermsAgreementAcceptedAt?: string | null;
  delegateOptIn?: boolean;
}

interface HeaderCatalogProduct {
  id: string;
  wooId?: string | number | null;
  name: string;
  sku?: string | null;
  category?: string | null;
  tags?: Array<{ id?: string | number | null; name?: string | null; slug?: string | null }> | null;
  image?: string | null;
  images?: string[] | null;
  variants?: Array<{ image?: string | null; sku?: string | null }> | null;
  inStock?: boolean | null;
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
  fullName?: string | null;
  recipientName?: string | null;
  recipient_name?: string | null;
  orderRecipientName?: string | null;
  order_recipient_name?: string | null;
  pickupRecipientName?: string | null;
  pickup_recipient_name?: string | null;
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
  status?: string | null;
  estimatedDeliveryDays?: number | null;
  deliveryDateGuaranteed?: string | null;
  rate?: number | null;
  currency?: string | null;
  estimatedArrivalDate?: string | null;
  deliveredAt?: string | null;
  packageCode?: string | null;
  packageDimensions?: { length?: number | null; width?: number | null; height?: number | null } | null;
  weightOz?: number | null;
  meta?: Record<string, any> | null;
}

interface AccountOrderSummary {
  id: string;
  asDelegate?: string | null;
  as_delegate?: string | null;
  resellerPermitFilePath?: string | null;
  reseller_permit_file_path?: string | null;
  resellerPermitFileName?: string | null;
  reseller_permit_file_name?: string | null;
  resellerPermitUploadedAt?: string | null;
  reseller_permit_uploaded_at?: string | null;
  resellerPermitApprovedByRep?: boolean | null;
  reseller_permit_approved_by_rep?: boolean | null;
  hasResellerPermitUploaded?: boolean | null;
  number?: string | null;
  trackingNumber?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  source: 'local' | 'woocommerce' | 'trufusion';
  doctorName?: string | null;
  doctorEmail?: string | null;
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
  facilityPickupRecipientName?: string | null;
  facility_pickup_recipient_name?: string | null;
  pickupRecipientName?: string | null;
  pickup_recipient_name?: string | null;
  recipientName?: string | null;
  recipient_name?: string | null;
  orderRecipientName?: string | null;
  order_recipient_name?: string | null;
  customerName?: string | null;
  customer_name?: string | null;
  expectedShipmentWindow?: string | null;
  upsTrackingStatus?: string | null;
  upsDeliveredAt?: string | null;
}

const hasUploadedResellerPermit = (...values: unknown[]): boolean =>
  values.some((value) => {
    if (value === true) {
      return true;
    }
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as {
      hasResellerPermitUploaded?: unknown;
      resellerPermitFilePath?: unknown;
      resellerPermitFileName?: unknown;
      resellerPermitUploadedAt?: unknown;
    };
    if (record.hasResellerPermitUploaded === true) {
      return true;
    }
    return [
      record.resellerPermitFilePath,
      (record as any).reseller_permit_file_path,
      record.resellerPermitFileName,
      (record as any).reseller_permit_file_name,
      record.resellerPermitUploadedAt,
      (record as any).reseller_permit_uploaded_at,
    ].some((field) => typeof field === 'string' && field.trim().length > 0);
  });

interface HeaderProps {
  user: HeaderUser | null;
  delegateMode?: boolean;
  delegateLogoUrl?: string | null;
  delegateSecondaryColor?: string | null;
  delegateDoctorName?: string | null;
  researchDashboardEnabled?: boolean;
  physicianThreePlEnabled?: boolean;
  patientLinksEnabled?: boolean;
  patientLinksDoctorUserIds?: string[];
  betaServices?: string[];
  onLogin?: (email: string, password: string) => Promise<AuthActionResult> | AuthActionResult;
  onResendVerificationEmail?: (email: string) => Promise<void> | void;
  onVerifyEmailCode?: (email: string, code: string) => Promise<AuthActionResult> | AuthActionResult;
  onLogout?: () => void;
  cartItems: number;
  cartProductCount?: number;
  cartProductTokens?: string[];
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
  accountModalRequest?: { tab: AccountTabId; open?: boolean; token: number; order?: AccountOrderSummary } | null;
  onAccountModalRequestHandled?: (token: number) => void;
  delegateLinksGuideStep?: 'account' | 'delegate_tab' | null;
  onDelegateLinksGuideAccountClick?: () => void;
  onDelegateLinksGuideTabClick?: () => void;
  suppressHomeButton?: boolean;
  suppressSearch?: boolean;
  showCanceledOrders?: boolean;
  onToggleShowCanceled?: () => void;
  onBuyOrderAgain?: (order: AccountOrderSummary) => void;
  onCancelOrder?: (orderId: string) => Promise<unknown>;
  referralCodes?: string[] | null;
  catalogLoading?: boolean;
  catalogProducts?: HeaderCatalogProduct[];
  onEnsureCatalogProductMedia?: (product: HeaderCatalogProduct) => Promise<unknown> | unknown;
  apiHealthNetworkQuality?: 'poor' | 'offline' | null;
  apiHealthNetworkReason?: string | null;
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
  physicianReferralDashboardPanel?: ReactNode;
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
    || sourceToken === 'trufusion'
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

const resolveOrderShippedAt = (order?: AccountOrderSummary | null): string | null => {
  if (!order || typeof order !== 'object') return null;
  const candidates = [
    (order as any)?.shipped_at,
    (order as any)?.shippedAt,
    (order as any)?.orders?.shipped_at,
    (order as any)?.orders?.shippedAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
};

const formatOrderShippedAtForLocalDisplay = (order?: AccountOrderSummary | null) => {
  const raw = resolveOrderShippedAt(order);
  if (!raw) return null;
  const parsed = parseBackendTimestamp(raw);
  if (!parsed) return raw;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
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

const normalizeOrderAddressComparisonPart = (value?: string | null) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const isFacilityPickupRecipientPlaceholder = (value?: string | null) =>
  normalizeOrderAddressComparisonPart(value) === 'trufusion facility pickup';

const isFacilityPickupAddress = (address?: AccountOrderAddress | null) => {
  if (!address) return false;

  const name = normalizeOrderAddressComparisonPart(address.name);
  const line1 = normalizeOrderAddressComparisonPart(address.addressLine1);
  const line2 = normalizeOrderAddressComparisonPart(address.addressLine2);
  const combinedLine = [line1, line2].filter(Boolean).join(' ');
  const city = normalizeOrderAddressComparisonPart(address.city);
  const state = normalizeOrderAddressComparisonPart(address.state);
  const postalCode = normalizeOrderAddressComparisonPart(address.postalCode);

  const matchesName = name === 'trufusion facility pickup';
  const matchesStreet =
    line1 === '640 s grand ave' || combinedLine.includes('640 s grand ave');
  const matchesUnit =
    line2 === 'unit #107' ||
    line2 === 'unit 107' ||
    combinedLine.includes('unit #107') ||
    combinedLine.includes('unit 107');
  const matchesLocation =
    city === 'santa ana' && state === 'ca' && postalCode === '92705';

  return (matchesStreet && matchesUnit && matchesLocation) || (matchesName && matchesLocation);
};

const getSalesOrderFulfillmentTokens = (
  order?: AccountOrderSummary | null,
): string[] => {
  if (!order) return [];
  return [
    (order as any)?.handDelivery === true ? 'hand_delivery' : '',
    (order as any)?.facilityPickup === true ? 'facility_pickup' : '',
    (order as any)?.facility_pickup === true ? 'facility_pickup' : '',
    (order as any)?.fascility_pickup === true ? 'fascility_pickup' : '',
    (order as any)?.fulfillmentMethod,
    (order as any)?.fulfillment_method,
    (order as any)?.shippingService,
    (order as any)?.shipping_service,
    (order as any)?.shippingEstimate?.serviceType,
    (order as any)?.shippingEstimate?.serviceCode,
    (order as any)?.shippingEstimate?.carrierId,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
};

const isSalesOrderFacilityPickup = (
  order?: AccountOrderSummary | null,
): boolean => {
  if (!order) return false;
  if (resolveTrackingNumber(order)) return false;
  const shippingAddress =
    (order as any)?.shippingAddress ||
    (order as any)?.shipping ||
    (order as any)?.shipping_address ||
    null;
  const billingAddress =
    (order as any)?.billingAddress ||
    (order as any)?.billing ||
    (order as any)?.billing_address ||
    null;
  const candidates = getSalesOrderFulfillmentTokens(order);
  return candidates.some((value) =>
    value === 'facility pickup' ||
    value === 'fascility_pickup' ||
    value === 'facility_pickup',
  ) || isFacilityPickupAddress(shippingAddress)
    || isFacilityPickupAddress(billingAddress);
};

const isSalesOrderHandDelivered = (
  order?: AccountOrderSummary | null,
): boolean => {
  if (!order) return false;
  if (resolveTrackingNumber(order)) return false;
  if (isSalesOrderFacilityPickup(order)) return false;
  const candidates = getSalesOrderFulfillmentTokens(order);
  return candidates.some((value) =>
    value === 'hand delivery' ||
    value === 'hand delivered' ||
    value === 'hand_delivery' ||
    value === 'hand_delivered' ||
    value === 'local hand delivery' ||
    value === 'local_hand_delivery' ||
    value === 'local_delivery' ||
    value === 'hand-delivery' ||
    value === 'hand-delivered',
  );
};

const resolveFacilityPickupRecipientName = (
  ...candidates: Array<string | null | undefined>
): string | null => {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || isFacilityPickupRecipientPlaceholder(trimmed)) {
      continue;
    }
    return trimmed;
  }
  return null;
};

const resolveFacilityPickupRecipientNameFromOrder = (
  order?: AccountOrderSummary | null,
): string | null => {
  if (!order || typeof order !== 'object') {
    return null;
  }

  const readMetaValue = (source: unknown, key: string): string | null => {
    const parsed = parseMaybeJson(source);
    if (!parsed) return null;
    const keys = withLegacyMetaKeys(key);
    if (Array.isArray(parsed)) {
      const match = parsed.find((entry: any) => keys.includes(String(entry?.key || '')));
      return typeof match?.value === 'string' ? match.value : null;
    }
    if (typeof parsed === 'object') {
      const obj = parsed as Record<string, any>;
      for (const candidateKey of keys) {
        if (typeof obj[candidateKey] === 'string') return obj[candidateKey];
      }
      return (
        readMetaValue(obj.meta_data, key) ||
        readMetaValue(obj.metaData, key) ||
        readMetaValue(obj.payload?.meta_data, key) ||
        readMetaValue(obj.payload?.metaData, key) ||
        readMetaValue(obj.response?.meta_data, key) ||
        readMetaValue(obj.response?.metaData, key) ||
        null
      );
    }
    return null;
  };

  const integrations = parseMaybeJson((order as any).integrationDetails || order.integrations) || {};
  const shippingAddress =
    (order as any).shippingAddress ||
    (order as any).shipping_address ||
    (order as any).shipping ||
    null;
  const billingAddress =
    (order as any).billingAddress ||
    (order as any).billing_address ||
    (order as any).billing ||
    null;
  return resolveFacilityPickupRecipientName(
    shippingAddress?.recipientName,
    shippingAddress?.recipient_name,
    shippingAddress?.orderRecipientName,
    shippingAddress?.order_recipient_name,
    shippingAddress?.pickupRecipientName,
    shippingAddress?.pickup_recipient_name,
    billingAddress?.recipientName,
    billingAddress?.recipient_name,
    billingAddress?.orderRecipientName,
    billingAddress?.order_recipient_name,
    billingAddress?.pickupRecipientName,
    billingAddress?.pickup_recipient_name,
    readMetaValue(integrations, 'trufusion_facility_pickup_recipient_name'),
    readMetaValue((integrations as any)?.wooCommerce, 'trufusion_facility_pickup_recipient_name'),
    readMetaValue((integrations as any)?.woocommerce, 'trufusion_facility_pickup_recipient_name'),
    shippingAddress?.fullName,
    shippingAddress?.name,
    billingAddress?.fullName,
    billingAddress?.name,
    (order as any).facilityPickupRecipientName,
    (order as any).facility_pickup_recipient_name,
    (order as any).pickupRecipientName,
    (order as any).pickup_recipient_name,
    (order as any).recipientName,
    (order as any).recipient_name,
    (order as any).orderRecipientName,
    (order as any).order_recipient_name,
  );
};

const withFacilityPickupRecipientName = (
  address?: AccountOrderAddress | null,
  options?: {
    preferredName?: string | null;
    billingAddress?: AccountOrderAddress | null;
    fallbackName?: string | null;
  },
): AccountOrderAddress | null => {
  if (!address || !isFacilityPickupAddress(address)) {
    return address ?? null;
  }
  const preferredName = resolveFacilityPickupRecipientName(options?.preferredName);
  const addressName = resolveFacilityPickupRecipientName(
    address.recipientName,
    address.recipient_name,
    address.orderRecipientName,
    address.order_recipient_name,
    address.pickupRecipientName,
    address.pickup_recipient_name,
    address.fullName,
    address.name,
  );
  const billingName = resolveFacilityPickupRecipientName(
    options?.billingAddress?.recipientName,
    options?.billingAddress?.recipient_name,
    options?.billingAddress?.orderRecipientName,
    options?.billingAddress?.order_recipient_name,
    options?.billingAddress?.pickupRecipientName,
    options?.billingAddress?.pickup_recipient_name,
    options?.billingAddress?.fullName,
    options?.billingAddress?.name,
  );
  const fallbackName = resolveFacilityPickupRecipientName(options?.fallbackName);
  const namesMatch = (left?: string | null, right?: string | null) =>
    Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
  const recipientName =
    preferredName ||
    (addressName && !namesMatch(addressName, fallbackName) ? addressName : null) ||
    (billingName && !namesMatch(billingName, fallbackName) ? billingName : null) ||
    addressName ||
    billingName ||
    fallbackName;
  if (!recipientName) {
    return address;
  }
  return {
    ...address,
    name: recipientName,
    fullName: recipientName,
    recipientName,
    recipient_name: recipientName,
    orderRecipientName: recipientName,
    order_recipient_name: recipientName,
    pickupRecipientName: recipientName,
    pickup_recipient_name: recipientName,
  };
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

const normalizeEstimateDisplayLabel = (value?: string | null) => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\s*[–—]\s*/g, ' - ').replace(/\s*-\s*/g, ' - ');
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
  const recipientName = resolveFacilityPickupRecipientName(
    addr.recipientName,
    addr.recipient_name,
    addr.orderRecipientName,
    addr.order_recipient_name,
    addr.pickupRecipientName,
    addr.pickup_recipient_name,
  );
  return {
    name: recipientName || name,
    fullName: recipientName || name,
    recipientName,
    recipient_name: recipientName,
    orderRecipientName: recipientName,
    order_recipient_name: recipientName,
    pickupRecipientName: recipientName,
    pickup_recipient_name: recipientName,
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

const isDelegatePickerPlaceholderImage = (value?: string | null): boolean => {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  return normalized.includes('Trufusionpeptides_icon');
};

const getDelegatePickerProductKey = (product: HeaderCatalogProduct): string => {
  const id = typeof product?.id === 'string' ? product.id.trim() : '';
  if (id) return id;
  const wooId = product?.wooId == null ? '' : String(product.wooId).trim();
  if (wooId) return `woo-${wooId}`;
  const sku = typeof product?.sku === 'string' ? product.sku.trim() : '';
  return sku;
};

const isInternalAllowedProductAlias = (value: string): boolean => {
  const normalized = String(value || '').trim().toUpperCase();
  return /^\d+$/.test(normalized) || /^WOO-(?:VARIATION-)?\d+$/.test(normalized);
};

const formatAllowedProductsForDisplay = (values: string[]): string[] => {
  const seen = new Set<string>();
  const normalizedValues: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedValues.push(normalized);
  }
  const publicValues = normalizedValues.filter((value) => !isInternalAllowedProductAlias(value));
  return publicValues.length > 0 ? publicValues : normalizedValues;
};

const getDelegatePickerProductTokens = (product: HeaderCatalogProduct): string[] => {
  const sku = typeof product?.sku === 'string' ? product.sku.trim() : '';
  if (sku) return [sku];
  const candidates = [
    product?.id,
    product?.wooId == null ? null : String(product.wooId),
  ];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (!normalized) continue;
    const dedupeKey = normalized.toUpperCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tokens.push(normalized);
  }
  return tokens;
};

const getDelegatePickerProductImage = (product: HeaderCatalogProduct): string | null => {
  const candidates: Array<string | null> = [];
  if (Array.isArray(product?.variants)) {
    for (const variant of product.variants) {
      candidates.push(normalizeImageSource(variant?.image));
    }
  }
  if (Array.isArray(product?.images)) {
    for (const image of product.images) {
      candidates.push(normalizeImageSource(image));
    }
  }
  candidates.push(normalizeImageSource(product?.image));

  const normalizedCandidates = candidates.filter((src): src is string => Boolean(src));
  return (
    normalizedCandidates.find((src) => !isDelegatePickerPlaceholderImage(src)) ||
    normalizedCandidates[0] ||
    null
  );
};

const getDelegatePickerProductResearchDomains = (product: HeaderCatalogProduct) => {
  const tags = Array.isArray(product?.tags) ? product.tags : [];
  const seen = new Set<string>();
  const domains: Array<{ slug: string; name: string }> = [];
  for (const tag of tags) {
    const name = String(tag?.name || '').trim();
    const rawSlug = String(tag?.slug || '').trim();
    const slug = (rawSlug || name)
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!name || !slug || seen.has(slug)) continue;
    seen.add(slug);
    domains.push({ slug, name });
  }
  return domains;
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
  return formatOrderStatusLabel(status) || 'Pending';
};

const normalizeTrackingStatusToken = (value?: string | null) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/[\s-]+/g, '_');
};

const normalizeCarrierTrackingStatusToken = (value?: string | null) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  let normalized = raw.replace(/[\s-]+/g, '_');
  normalized = normalized.replace(/_+/g, '_');
  if (!normalized || normalized === 'unknown') {
    return null;
  }

  if (normalized.includes('delivered')) {
    return 'delivered';
  }
  if (normalized.includes('out_for_delivery') || normalized.includes('outfordelivery')) {
    return 'out_for_delivery';
  }
  if (
    normalized.includes('in_transit') ||
    normalized.includes('intransit') ||
    normalized.includes('on_the_way') ||
    normalized.includes('ontheway')
  ) {
    return 'in_transit';
  }
  if (normalized === 'shipped') {
    return 'shipped';
  }
  if (normalized === 'awaiting_shipment' || normalized === 'awaiting') {
    return 'awaiting_shipment';
  }
  if (
    normalized.includes('label_created') ||
    normalized.includes('shipment_ready_for_ups') ||
    normalized.includes('shipment_information_received') ||
    normalized.includes('information_received') ||
    normalized.includes('billing_information_received')
  ) {
    return 'label_created';
  }
  if (
    normalized.includes('exception') ||
    normalized.includes('delay') ||
    normalized.includes('held') ||
    normalized.includes('hold') ||
    normalized.includes('error')
  ) {
    return 'exception';
  }

  return normalized;
};

const formatDeliveryDateLabel = (value?: string | null) => {
  const date = parseBackendTimestamp(value);
  if (!date) return null;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const resolveOrderDeliveredAt = (order?: AccountOrderSummary | null) => {
  if (!order || typeof order !== 'object') return null;
  const shippingEstimate = order.shippingEstimate && typeof order.shippingEstimate === 'object'
    ? order.shippingEstimate
    : null;
  const integrations = parseMaybeJson((order as any).integrationDetails || (order as any).integrations || null) || {};
  const carrierTracking = parseMaybeJson((integrations as any)?.carrierTracking || (integrations as any)?.carrier_tracking || null) || {};
  const candidates = [
    (order as any).upsDeliveredAt,
    (order as any).ups_delivered_at,
    shippingEstimate?.deliveredAt,
    (shippingEstimate as any)?.delivered_at,
    carrierTracking?.deliveredAt,
    carrierTracking?.delivered_at,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
};

const collectTrackingStatusCandidates = (order?: AccountOrderSummary | null) => {
  if (!order || typeof order !== 'object') return [];
  const shippingEstimate = order.shippingEstimate && typeof order.shippingEstimate === 'object'
    ? order.shippingEstimate
    : null;
  const integrations = parseMaybeJson((order as any).integrationDetails || (order as any).integrations || null) || {};
  const carrierTracking = parseMaybeJson((integrations as any)?.carrierTracking || (integrations as any)?.carrier_tracking || null) || {};
  const shipStation = parseMaybeJson((integrations as any)?.shipStation || (integrations as any)?.shipstation || null) || {};
  const candidates: unknown[] = [
    (order as any).upsTrackingStatus,
    (order as any).ups_tracking_status,
    shippingEstimate?.status,
    carrierTracking?.trackingStatusRaw,
    carrierTracking?.trackingStatus,
    carrierTracking?.tracking_status,
    carrierTracking?.status,
    carrierTracking?.deliveryStatus,
    carrierTracking?.delivery_status,
    shipStation?.trackingStatus,
    shipStation?.tracking_status,
    shipStation?.deliveryStatus,
    shipStation?.delivery_status,
    shipStation?.shipmentStatus,
    shipStation?.shipment_status,
    shipStation?.status,
  ];

  const shipments = Array.isArray(shipStation?.shipments)
    ? shipStation.shipments
    : Array.isArray(shipStation?.shipment)
      ? shipStation.shipment
      : [];

  for (const entry of shipments) {
    if (!entry || entry.voided === true) continue;
    candidates.push(
      entry?.trackingStatus,
      entry?.tracking_status,
      entry?.deliveryStatus,
      entry?.delivery_status,
      entry?.shipmentStatus,
      entry?.shipment_status,
      entry?.status,
    );
  }

  return candidates;
};

const resolveTrackingStatusRaw = (order?: AccountOrderSummary | null) => {
  if (!order || typeof order !== 'object') return null;
  for (const candidate of collectTrackingStatusCandidates(order)) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
};

const resolveTrackingStatusToken = (order?: AccountOrderSummary | null) => {
  for (const candidate of collectTrackingStatusCandidates(order)) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    const normalized = normalizeCarrierTrackingStatusToken(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const buildTrackingStatusLabel = (
  order?: AccountOrderSummary | null,
  options?: { includeDeliveredDate?: boolean },
) => {
  const rawStatus = resolveTrackingStatusRaw(order);
  const statusToken = resolveTrackingStatusToken(order);
  if (!rawStatus && !statusToken) return null;
  const trackingNumber = resolveTrackingNumber(order);
  const deliveredAtLabel = formatDeliveryDateLabel(resolveOrderDeliveredAt(order));
  const normalizedStatus = statusToken || normalizeTrackingStatusToken(rawStatus);
  const label = humanizeOrderStatus(statusToken || rawStatus);
  if (options?.includeDeliveredDate !== false && deliveredAtLabel && normalizedStatus?.includes('delivered')) {
    return `${label} on ${deliveredAtLabel}`;
  }
  return label;
};

const buildTrackingStatusLine = (order?: AccountOrderSummary | null) =>
  buildTrackingStatusLabel(order, { includeDeliveredDate: true });

const normalizeStringField = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const getOrderCacheKeys = (order: any): string[] => {
  if (!order) return [];
  return [
    order?.id,
    order?.wooOrderId,
    order?.wooOrderNumber,
    order?.number,
    order?.cancellationId,
  ]
    .map((value) => normalizeStringField(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value));
};

const resolveExpectedShipmentWindow = (order: any): string | null => {
  if (!order) {
    return null;
  }

  const direct = normalizeStringField(
    order?.expectedShipmentWindow ?? order?.expected_shipment_window,
  );
  if (direct) {
    return direct;
  }

  const integrations = parseMaybeJson(order?.integrationDetails || order?.integrations) || {};
  const wooIntegration =
    parseMaybeJson(integrations?.wooCommerce || integrations?.woocommerce) || {};
  const wooResponse = parseMaybeJson(wooIntegration?.response) || {};
  const wooPayload = parseMaybeJson(wooIntegration?.payload) || {};
  const mysqlIntegration = parseMaybeJson(integrations?.mysql) || {};
  const mysqlOrder = parseMaybeJson(mysqlIntegration?.order) || {};

  return normalizeStringField(
    wooResponse?.expectedShipmentWindow ??
      wooResponse?.expected_shipment_window ??
      wooPayload?.expectedShipmentWindow ??
      wooPayload?.expected_shipment_window ??
      mysqlOrder?.expectedShipmentWindow ??
      mysqlOrder?.expected_shipment_window,
  );
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
  const shippingStatus =
    (order.shippingEstimate as any)?.status ||
    carrierTrackingStatusRaw ||
    (order.integrationDetails as any)?.shipStation?.status;

  if (shouldDisplayShippingStatusForOrder(orderStatus, shippingStatus)) {
    const shippingStr = shippingStatus ? String(shippingStatus).trim() : '';
    if (shippingStr) {
      return shippingStr;
    }
  }

  return orderStatus.length > 0 ? orderStatus : null;
};

const describeOrderStatus = (order: AccountOrderSummary | null | undefined): string => {
  const orderStatusRaw = order?.status ? String(order.status) : '';
  const orderStatusNormalized = orderStatusRaw.trim().toLowerCase();
  const orderStatusToken = orderStatusNormalized.replace(/[\s-]+/g, '_');
  if (orderStatusNormalized === 'trash' || orderStatusNormalized === 'canceled' || orderStatusNormalized === 'cancelled') {
    return 'Canceled';
  }
  if (orderStatusNormalized === 'refunded') {
    return 'Refunded';
  }
  if (orderStatusToken === 'on_hold' || orderStatusToken === 'onhold') {
    return 'On-Hold';
  }

  const trackingStatusCandidate = resolveTrackingStatusToken(order) || resolveTrackingStatusRaw(order);
  const trackingStatusLabel = buildTrackingStatusLabel(order, { includeDeliveredDate: false });
  if (trackingStatusLabel && shouldDisplayShippingStatusForOrder(orderStatusRaw, trackingStatusCandidate)) {
    return trackingStatusLabel;
  }

  const raw = resolveOrderStatusSource(order);
  const statusRaw = raw ? String(raw) : '';
  const normalized = statusRaw.trim().toLowerCase();

  const tracking = resolveTrackingNumber(order) || '';
  const eta = (order?.shippingEstimate as any)?.estimatedArrivalDate || null;
  const hasEta = typeof eta === 'string' && eta.trim().length > 0;

  if (normalized === 'shipped') {
    return tracking ? 'Shipped' : 'Shipped';
  }
  if (normalized.includes('out_for_delivery') || normalized.includes('out-for-delivery')) {
    return 'Out for Delivery';
  }
  if (normalized.includes('in_transit') || normalized.includes('in-transit')) {
    return 'In transit';
  }
  if (normalized.includes('delivered')) {
    return 'Delivered';
  }
  if (
    normalized.includes('label_created') ||
    normalized.includes('awaiting_shipment') ||
    normalized.includes('awaiting')
  ) {
    return 'Label Created';
  }
  if (
    normalized.includes('exception') ||
    normalized.includes('delay') ||
    normalized.includes('held') ||
    normalized.includes('hold') ||
    normalized.includes('error')
  ) {
    return 'Exception';
  }

  if (tracking && !hasEta) {
    return 'Shipped';
  }
  if (tracking && hasEta) {
    return 'Shipped';
  }
  if (normalized === 'processing') {
    return 'Processing';
  }
  if (normalized === 'completed' || normalized === 'complete') {
    return 'Shipped';
  }
  if (normalized === 'awaiting_shipment' || normalized === 'awaiting shipment') {
    return 'Label Created';
  }

  if (!raw) return 'Pending';
  return humanizeOrderStatus(raw);
};

export function Header({
  user,
  delegateMode = false,
  delegateLogoUrl = null,
  delegateSecondaryColor = null,
  delegateDoctorName = null,
  researchDashboardEnabled = false,
  physicianThreePlEnabled = false,
  patientLinksEnabled = false,
  patientLinksDoctorUserIds = [],
  betaServices = [],
  onLogin,
  onResendVerificationEmail,
  onVerifyEmailCode,
  onLogout,
  cartItems,
  cartProductCount = 0,
  cartProductTokens = [],
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
  delegateLinksGuideStep = null,
  onDelegateLinksGuideAccountClick,
  onDelegateLinksGuideTabClick,
  suppressHomeButton = false,
  suppressSearch = false,
  showCanceledOrders = false,
  onToggleShowCanceled,
  onBuyOrderAgain,
  onCancelOrder,
  referralCodes = [],
  catalogLoading = false,
  catalogProducts = [],
  onEnsureCatalogProductMedia,
  apiHealthNetworkQuality = null,
  apiHealthNetworkReason = null,
  onLoadDelegateProposal,
  patientLinksRefreshToken = 0,
  onAccountIndicatorTotalChange,
  physicianReferralDashboardPanel = null,
	}: HeaderProps) {
  const delegateSessionSecondaryHex =
    normalizeDelegateSecondaryColor(delegateSecondaryColor) || DEFAULT_DELEGATE_SECONDARY_COLOR;
  const secondaryColor = delegateMode ? hexToRgbCss(delegateSessionSecondaryHex) : 'rgb(11, 6, 121)';
  const translucentSecondary = delegateMode ? hexToRgbaCss(delegateSessionSecondaryHex, 0.18) : 'rgba(11, 6, 121, 0.18)';
  const elevatedShadow = delegateMode
    ? `0 32px 60px -28px ${hexToRgbaCss(delegateSessionSecondaryHex, 0.55)}`
    : '0 32px 60px -28px rgba(11, 6, 121, 0.55)';
  const [loginOpen, setLoginOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [ordersSearchQuery, setOrdersSearchQuery] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'verify'>('login');
  const [signupName, setSignupName] = useState('');
  const [signupSuffix, setSignupSuffix] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const lastLoginPromptToken = useRef<number | null>(null);
  const [loginError, setLoginError] = useState('');
  const [loginNotice, setLoginNotice] = useState('');
  const [unverifiedLoginEmail, setUnverifiedLoginEmail] = useState('');
  const [verificationResendPending, setVerificationResendPending] = useState(false);
  const [verificationResendSent, setVerificationResendSent] = useState(false);
  const [signupError, setSignupError] = useState('');
  const [signupNotice, setSignupNotice] = useState('');
  const [signupVerificationEmail, setSignupVerificationEmail] = useState('');
  const [signupVerificationEmailSent, setSignupVerificationEmailSent] = useState(false);
  const [signupVerificationResendPending, setSignupVerificationResendPending] = useState(false);
  const [signupVerificationResendSent, setSignupVerificationResendSent] = useState(false);
  const [signupVerificationResendError, setSignupVerificationResendError] = useState('');
  const [signupVerificationStartedAt, setSignupVerificationStartedAt] = useState(0);
  const [signupVerificationCode, setSignupVerificationCode] = useState('');
  const [signupVerificationPending, setSignupVerificationPending] = useState(false);
  const [signupVerificationError, setSignupVerificationError] = useState('');
  const [signupVerificationSuccess, setSignupVerificationSuccess] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [legalModalOpen, setLegalModalOpen] = useState(false);
  const [researchToolRequestExpanded, setResearchToolRequestExpanded] = useState(false);
  const [researchToolRequestReport, setResearchToolRequestReport] = useState('');
  const [researchToolRequestSubmitting, setResearchToolRequestSubmitting] = useState(false);
  const [researchToolRequestSuccess, setResearchToolRequestSuccess] = useState('');
  const [researchToolRequestError, setResearchToolRequestError] = useState('');
  const [deleteAccountModalOpen, setDeleteAccountModalOpen] = useState(false);
  const [deleteAccountHoldCount, setDeleteAccountHoldCount] = useState(0);
  const [deleteAccountDeleting, setDeleteAccountDeleting] = useState(false);
  const [accountTab, setAccountTab] = useState<AccountTabId>('details');
  const [physicianDashboardTab, setPhysicianDashboardTab] = useState<PhysicianDashboardTabId>('links');
  const [physicianDashboardPortalReady, setPhysicianDashboardPortalReady] = useState(false);
  const physicianDashboardPortalReadyRef = useRef(false);
  const physicianDashboardTabsContainerRef = useRef<HTMLDivElement | null>(null);
  const [physicianDashboardTabIndicator, setPhysicianDashboardTabIndicator] = useState({
    left: 0,
    width: 0,
    opacity: 0,
  });
  const [patientLinksLoading, setPatientLinksLoading] = useState(false);
  const [patientLinksError, setPatientLinksError] = useState<string | null>(null);
  const [patientLinks, setPatientLinks] = useState<any[]>([]);
  const [patientLinksTypeFilter, setPatientLinksTypeFilter] = useState<PatientLinkTypeFilter>('all');
  const [pendingPatientLinkScrollTarget, setPendingPatientLinkScrollTarget] = useState<{
    delegateTokens: string[];
    orderIds: string[];
    referenceLabels: string[];
  } | null>(null);
  const patientLinksPrefetchedRef = useRef(false);
  const patientLinksLoadInFlightRef = useRef(false);
  const patientLinksQueuedReloadRef = useRef(false);
  const patientLinksActivatedTokenOverridesRef = useRef<Map<string, number>>(new Map());
  const loadPatientLinksRef = useRef<(() => Promise<void>) | null>(null);
  const patientLinkRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const patientLinkHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [patientLinkMarkupDraft, setPatientLinkMarkupDraft] = useState('0');
  const [patientLinkSubjectLabelDraft, setPatientLinkSubjectLabelDraft] = useState('');
  const [patientLinkStudyLabelDraft, setPatientLinkStudyLabelDraft] = useState('');
  const [patientLinkReferenceDraft, setPatientLinkReferenceDraft] = useState('');
  const [patientLinkDelegateNameDraft, setPatientLinkDelegateNameDraft] = useState('');
  const [patientLinkDelegateContactDraft, setPatientLinkDelegateContactDraft] = useState('');
  const [patientLinkBrochureNameDraft, setPatientLinkBrochureNameDraft] = useState('');
  const [patientLinkRecipientNameDraft, setPatientLinkRecipientNameDraft] = useState('');
  const [patientLinkRecipientContactDraft, setPatientLinkRecipientContactDraft] = useState('');
  const [patientLinkDelegateRoleDraft, setPatientLinkDelegateRoleDraft] = useState<DelegateRole>('patient');
  const [patientLinkProductScopeDraft, setPatientLinkProductScopeDraft] = useState<DelegateProductScope>('all_physician_approved');
  const [patientLinkApprovedProductIds, setPatientLinkApprovedProductIds] = useState<string[]>([]);
  const [patientLinkProductPickerOpen, setPatientLinkProductPickerOpen] = useState(false);
  const [createLinkLegalDocumentKey, setCreateLinkLegalDocumentKey] = useState<CreateLinkLegalDocumentKey | null>(null);
  const [patientLinkProductPickerQuery, setPatientLinkProductPickerQuery] = useState('');
  const [patientLinkProductPickerDomain, setPatientLinkProductPickerDomain] = useState('all');
  const [patientLinkDelegatePermissionDraft, setPatientLinkDelegatePermissionDraft] = useState<DelegatePermission>('submit_for_physician_review');
  const [patientLinkExpiryHoursDraft, setPatientLinkExpiryHoursDraft] = useState(DEFAULT_DELEGATE_LINK_EXPIRY_HOURS);
  const [patientLinkPricingDisclosureDraft, setPatientLinkPricingDisclosureDraft] = useState(DEFAULT_DELEGATE_PRICING_DISCLOSURE);
  const [patientLinkZelleRecipientNameDraft, setPatientLinkZelleRecipientNameDraft] = useState('');
  const [patientLinkPaymentConfirmationRequired, setPatientLinkPaymentConfirmationRequired] = useState(true);
  const [patientLinkResearchNoteDraft, setPatientLinkResearchNoteDraft] = useState('');
  const [patientLinkDelegateInstructionsDraft, setPatientLinkDelegateInstructionsDraft] = useState('');
  const [patientLinkInternalPhysicianNoteDraft, setPatientLinkInternalPhysicianNoteDraft] = useState('');
  const [patientLinkTermsAccepted, setPatientLinkTermsAccepted] = useState(false);
  const [patientLinkPaymentMethodDraft, setPatientLinkPaymentMethodDraft] = useState<PatientLinkPaymentMethod>('zelle');
  const [patientLinkInstructionsDraft, setPatientLinkInstructionsDraft] = useState<string>('');
  const createLinkLegalDocument = createLinkLegalDocumentKey
    ? CREATE_LINK_LEGAL_DOCUMENTS[createLinkLegalDocumentKey]
    : null;
  const [patientLinksCreating, setPatientLinksCreating] = useState(false);
  const [patientLinksUpdatingToken, setPatientLinksUpdatingToken] = useState<string | null>(null);
  const [patientLinksDeletingToken, setPatientLinksDeletingToken] = useState<string | null>(null);
  const [patientLinksSavingPaymentToken, setPatientLinksSavingPaymentToken] = useState<string | null>(null);
  const [patientLinksPaymentReceivedToken, setPatientLinksPaymentReceivedToken] = useState<string | null>(null);
  const [patientLinksSavingReviewNotesToken, setPatientLinksSavingReviewNotesToken] = useState<string | null>(null);
  const [patientLinkUpdateEmailSaving, setPatientLinkUpdateEmailSaving] = useState(false);
  const [patientLinkConfirmAction, setPatientLinkConfirmAction] = useState<PatientLinkConfirmAction | null>(null);
  const [patientLinkEditing, setPatientLinkEditing] = useState<PatientLinkEditingState | null>(null);
  const [createLinkDialogOpen, setCreateLinkDialogOpen] = useState(false);
  const [createLinkDialogMode, setCreateLinkDialogMode] = useState<CreateLinkDialogMode>('select');
  const [delegateProductPickerBrokenImages, setDelegateProductPickerBrokenImages] = useState<Set<string>>(() => new Set());
  const createLinkDialogContentRef = useRef<HTMLDivElement | null>(null);
  const createLinkDialogScrollPositionRef = useRef({ top: 0, left: 0 });
  const createLinkDialogScrollRestoreRafRef = useRef<number | null>(null);
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
  const [signupSubmitting, setSignupSubmitting] = useState(false);
  const [logoutThanksOpen, setLogoutThanksOpen] = useState(false);
  const [logoutThanksOpacity, setLogoutThanksOpacity] = useState(0);

  useEffect(() => {
    if (suppressSearch) {
      setMobileSearchOpen(false);
    }
  }, [suppressSearch]);

  useEffect(() => {
    return () => {
      if (patientLinksScrollRestoreRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(patientLinksScrollRestoreRafRef.current);
        patientLinksScrollRestoreRafRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!createLinkDialogOpen) {
      return;
    }
    const dialogContent = createLinkDialogContentRef.current;
    if (!dialogContent) {
      return;
    }
    dialogContent.scrollTop = 0;
    dialogContent.scrollLeft = 0;
  }, [createLinkDialogMode, createLinkDialogOpen]);

  useEffect(() => {
    if (!createLinkDialogOpen) {
      setCreateLinkLegalDocumentKey(null);
    }
  }, [createLinkDialogOpen]);

  const captureCreateLinkDialogScrollPosition = useCallback(() => {
    const dialogContent = createLinkDialogContentRef.current;
    if (!dialogContent) {
      return;
    }
    createLinkDialogScrollPositionRef.current = {
      top: dialogContent.scrollTop,
      left: dialogContent.scrollLeft,
    };
  }, []);

  const restoreCreateLinkDialogScrollPosition = useCallback(() => {
    const restore = () => {
      const dialogContent = createLinkDialogContentRef.current;
      if (!dialogContent) {
        return;
      }
      dialogContent.scrollTop = createLinkDialogScrollPositionRef.current.top;
      dialogContent.scrollLeft = createLinkDialogScrollPositionRef.current.left;
    };

    if (typeof window === 'undefined') {
      restore();
      return;
    }

    if (createLinkDialogScrollRestoreRafRef.current !== null) {
      window.cancelAnimationFrame(createLinkDialogScrollRestoreRafRef.current);
    }

    createLinkDialogScrollRestoreRafRef.current = window.requestAnimationFrame(() => {
      restore();
      createLinkDialogScrollRestoreRafRef.current = window.requestAnimationFrame(() => {
        createLinkDialogScrollRestoreRafRef.current = null;
        restore();
      });
    });
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && createLinkDialogScrollRestoreRafRef.current !== null) {
        window.cancelAnimationFrame(createLinkDialogScrollRestoreRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!patientLinkProductPickerOpen || typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    const body = document.body;
    const documentElement = document.documentElement;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const previousBodyOverscrollBehavior = body.style.overscrollBehavior;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;

    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    documentElement.style.overscrollBehavior = 'none';

    return () => {
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      body.style.overscrollBehavior = previousBodyOverscrollBehavior;
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
    };
  }, [patientLinkProductPickerOpen]);

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
  const displayedNetworkQuality: NetworkQuality =
    networkQuality === 'offline' || apiHealthNetworkQuality === 'offline'
      ? 'offline'
      : networkQuality === 'poor' || apiHealthNetworkQuality === 'poor'
        ? 'poor'
        : networkQuality;
  const networkIndicatorUsesApiHealth =
    Boolean(apiHealthNetworkQuality) && displayedNetworkQuality === apiHealthNetworkQuality;
  const [localUser, setLocalUser] = useState<HeaderUser | null>(user);
  const lastZelleContactRef = useRef<string | null>(null);
  const [zelleContactDraft, setZelleContactDraft] = useState('');
  const loginFormRef = useRef<HTMLFormElement | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<AccountOrderSummary | null>(null);
  const [selectedOrderStickyEstimateWindow, setSelectedOrderStickyEstimateWindow] = useState<string | null>(null);
  const selectedOrderEstimateWindowRef = useRef<Map<string, string>>(new Map());
  const selectedOrderStickyKeysRef = useRef<Set<string>>(new Set());
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
  const researchToolRequestFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const accountModalShellRef = useRef<HTMLDivElement | null>(null);
  const accountModalScrollRef = useRef<HTMLDivElement | null>(null);
  const accountTabScrollTopRef = useRef<Partial<Record<AccountTabId, number>>>({});
  const restoreAccountTabScrollRef = useRef<Partial<Record<AccountTabId, boolean>>>({});
  const patientLinksScrollRestoreRef = useRef<{ accountTop: number | null; windowY: number | null } | null>(null);
  const patientLinksScrollRestoreRafRef = useRef<number | null>(null);
  const patientLinksPreserveScrollOnNextLoadRef = useRef(false);
  const researchOverlayTimeoutRef = useRef<number | null>(null);
  const isResearchFullscreen = false;
  const modalFullscreenHeight =
    "calc(var(--viewport-height, 100dvh) - var(--modal-header-offset, 6rem) - clamp(1.5rem, 6vh, 3rem))";

  const storeAccountTabScrollPosition = useCallback((tabId: AccountTabId = accountTab) => {
    const scrollContainer = accountModalScrollRef.current;
    if (!scrollContainer) {
      return;
    }
    accountTabScrollTopRef.current[tabId] = scrollContainer.scrollTop;
    restoreAccountTabScrollRef.current[tabId] = true;
  }, [accountTab]);

  const applyStoredAccountTabScrollPosition = useCallback((
    tabId: AccountTabId = accountTab,
    options: { clearRestoreFlag?: boolean } = {},
  ) => {
    const scrollContainer = accountModalScrollRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollTop = accountTabScrollTopRef.current[tabId] ?? 0;
    if (options.clearRestoreFlag) {
      restoreAccountTabScrollRef.current[tabId] = false;
    }
  }, [accountTab]);

  const capturePatientLinksScrollPosition = useCallback(() => {
    patientLinksScrollRestoreRef.current = {
      accountTop: accountModalScrollRef.current?.scrollTop ?? null,
      windowY: typeof window !== 'undefined' ? window.scrollY : null,
    };
  }, []);

  const restorePatientLinksScrollPosition = useCallback(() => {
    const restore = () => {
      const saved = patientLinksScrollRestoreRef.current;
      if (!saved) {
        return;
      }
      if (saved.accountTop !== null && accountModalScrollRef.current) {
        accountModalScrollRef.current.scrollTop = saved.accountTop;
      }
      if (saved.windowY !== null && typeof window !== 'undefined') {
        window.scrollTo({
          top: saved.windowY,
          left: window.scrollX,
          behavior: 'auto',
        });
      }
    };

    if (typeof window === 'undefined') {
      restore();
      patientLinksScrollRestoreRef.current = null;
      return;
    }

    if (patientLinksScrollRestoreRafRef.current !== null) {
      window.cancelAnimationFrame(patientLinksScrollRestoreRafRef.current);
    }

    patientLinksScrollRestoreRafRef.current = window.requestAnimationFrame(() => {
      restore();
      patientLinksScrollRestoreRafRef.current = window.requestAnimationFrame(() => {
        restore();
        patientLinksScrollRestoreRafRef.current = null;
        patientLinksScrollRestoreRef.current = null;
      });
    });
  }, []);

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

  const handleResearchToolRequestClick = useCallback((event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    event?.preventDefault();
    event?.stopPropagation();
    storeAccountTabScrollPosition();
    setResearchToolRequestExpanded(true);
    setResearchToolRequestError('');
    setResearchToolRequestSuccess('');
    void import('../services/api')
      .then((api) =>
        api.usageTrackingAPI.track({
          event: 'tool_request_clicked',
          metadata: { source: 'research_tab' },
        }),
      )
      .catch(() => {});
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => researchToolRequestFieldRef.current?.focus());
    }
  }, [storeAccountTabScrollPosition]);

  const handleResearchToolRequestSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResearchToolRequestError('');
    setResearchToolRequestSuccess('');
    const report = researchToolRequestReport.trim();
    if (!report) {
      setResearchToolRequestError('Please describe the tool you want.');
      return;
    }
    setResearchToolRequestSubmitting(true);
    try {
      const { api } = await import('../services/api');
      const res = await api.post('/tool-requests', { report, source: 'research_tab' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Unable to submit tool request.');
      }
      setResearchToolRequestReport('');
      setResearchToolRequestSuccess('Thanks. Your tool request has been submitted.');
      setResearchToolRequestExpanded(false);
    } catch (error: any) {
      setResearchToolRequestError(
        error?.message || 'Unable to submit tool request. Please try again.',
      );
    } finally {
      setResearchToolRequestSubmitting(false);
    }
  }, [researchToolRequestReport]);

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
  const resellerPermitInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUploadPercent, setAvatarUploadPercent] = useState(0);
  const [showAvatarControls, setShowAvatarControls] = useState(false);
  const [resellerPermitUploading, setResellerPermitUploading] = useState(false);
  const [resellerPermitDownloading, setResellerPermitDownloading] = useState(false);
  const [resellerPermitDeleting, setResellerPermitDeleting] = useState(false);
  const accountModalRequestTokenRef = useRef<number | null>(null);

  useEffect(() => {
    if (user?.shadowContext?.active) {
      setNetworkQuality('good');
      setNetworkSpeedSummary((prev) => ({
        ...prev,
        measuredAt: Date.now(),
      }));
      return;
    }
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
	      const conn =
	        (navigator as any).connection ||
	        (navigator as any).mozConnection ||
	        (navigator as any).webkitConnection;
	      const latencyMs = typeof conn?.rtt === 'number' && Number.isFinite(conn.rtt) && conn.rtt > 0
	        ? Math.round(conn.rtt)
	        : null;
	      if (!mounted || requestId !== pingRequestId) return null;
	      if (latencyMs != null) {
	        lastLatencyMsRef.current = latencyMs;
	        setNetworkSpeedSummary((prev) => ({
	          ...prev,
	          latencyMs,
            measuredAt: Date.now(),
          }));
	      }
	      if (navigator.onLine !== false) {
	        markReachable();
	      }
	      return deriveFromConnection();
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
        // Frontend-only throughput: fetch a bundled static asset so this does not rely on
        // the backend. Use a cache-busting query param to avoid cached responses.
        const blueLeafTextureUrl = resolveStaticAssetUrl('/blueleafTexture-email.png');
        const separator = blueLeafTextureUrl.includes('?') ? '&' : '?';
        const downloadMbps = await measureFetchMbps({
          url: `${blueLeafTextureUrl}${separator}networkTest=1&t=${Date.now()}`,
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
    window.addEventListener('trufusion:api-reachability', apiListener as any);
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
      window.removeEventListener('trufusion:api-reachability', apiListener as any);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (conn && typeof conn.removeEventListener === 'function') {
        conn.removeEventListener('change', updateFromConnection);
      }
    };
  }, [user?.shadowContext?.active]);
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
  const rememberSelectedOrderEstimateWindow = useCallback((order: AccountOrderSummary | null | undefined) => {
    const estimateWindow = resolveExpectedShipmentWindow(order);
    if (!estimateWindow) {
      return;
    }
    getOrderCacheKeys(order).forEach((key) => {
      selectedOrderEstimateWindowRef.current.set(key, estimateWindow);
    });
  }, []);
  const getRememberedSelectedOrderEstimateWindow = useCallback((order: AccountOrderSummary | null | undefined) => {
    const keys = getOrderCacheKeys(order);
    for (const key of keys) {
      const remembered = selectedOrderEstimateWindowRef.current.get(key);
      if (remembered) {
        return remembered;
      }
    }
    return null;
  }, []);
  const syncSelectedOrderStickyEstimateWindow = useCallback((order: AccountOrderSummary | null | undefined) => {
    if (!order) {
      selectedOrderStickyKeysRef.current = new Set();
      setSelectedOrderStickyEstimateWindow(null);
      return;
    }

    const nextKeys = getOrderCacheKeys(order);
    if (!nextKeys.length) {
      return;
    }

    const nextEstimateWindow =
      resolveExpectedShipmentWindow(order) ||
      getRememberedSelectedOrderEstimateWindow(order);
    const currentKeys = selectedOrderStickyKeysRef.current;
    const isSameOpenOrder =
      currentKeys.size > 0 && nextKeys.some((key) => currentKeys.has(key));

    if (!isSameOpenOrder) {
      selectedOrderStickyKeysRef.current = new Set(nextKeys);
      setSelectedOrderStickyEstimateWindow(nextEstimateWindow);
      return;
    }

    selectedOrderStickyKeysRef.current = new Set([...currentKeys, ...nextKeys]);
    if (nextEstimateWindow) {
      setSelectedOrderStickyEstimateWindow((current) =>
        current === nextEstimateWindow ? current : nextEstimateWindow,
      );
    }
  }, [getRememberedSelectedOrderEstimateWindow]);
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
      rememberSelectedOrderEstimateWindow(accountModalRequest.order);
      mergeOrderIntoCache(accountModalRequest.order);
      setSelectedOrder(accountModalRequest.order);
    }
    const requestRole = localUser?.role ?? user?.role ?? null;
    const requestIsDoctor = isDoctorRole(requestRole);
    if (requestIsDoctor && accountModalRequest.tab === 'orders') {
      setPhysicianDashboardTab('orders');
      setWelcomeOpen(false);
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          document
            .getElementById(PHYSICIAN_DASHBOARD_PORTAL_ID)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } else if (requestIsDoctor && accountModalRequest.tab === 'patient_links') {
      setPhysicianDashboardTab('links');
      setWelcomeOpen(false);
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          document
            .getElementById(PHYSICIAN_DASHBOARD_PORTAL_ID)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } else if (accountModalRequest.tab) {
      setAccountTab(accountModalRequest.tab);
      if (accountModalRequest.open || accountModalRequest.order) {
        setWelcomeOpen(true);
      }
    } else if (accountModalRequest.open || accountModalRequest.order) {
      setWelcomeOpen(true);
    }
    onAccountModalRequestHandled?.(token);
  }, [accountModalRequest, localUser?.role, mergeOrderIntoCache, onAccountModalRequestHandled, rememberSelectedOrderEstimateWindow, user?.role]);
  useEffect(() => { setLocalUser(user); }, [user]);
  useEffect(() => {
    rememberSelectedOrderEstimateWindow(selectedOrder);
  }, [selectedOrder, rememberSelectedOrderEstimateWindow]);
  useEffect(() => {
    syncSelectedOrderStickyEstimateWindow(selectedOrder);
  }, [selectedOrder, syncSelectedOrderStickyEstimateWindow]);
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
        || patientLinkInstructionsDraft.trim() === prevDefault.trim()
        || isGeneratedPatientLinkDefaultInstructions(patientLinkInstructionsDraft, localUser?.name ?? user?.name ?? null);
      if (shouldReplace && nextDefault.trim() !== patientLinkInstructionsDraft.trim()) {
        setPatientLinkInstructionsDraft(nextDefault);
      }
    }

    setPatientLinkInstructionsDraftByToken((prev) => {
      let changed = false;
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
        const shouldReplace =
          !existing.trim()
          || existing.trim() === prevDefault.trim()
          || isGeneratedPatientLinkDefaultInstructions(existing, localUser?.name ?? user?.name ?? null);
        if (shouldReplace) {
          const nextDefault = buildPatientLinkDefaultInstructions('zelle', nextZelleContact, localUser?.name ?? user?.name ?? null);
          if (next[token] !== nextDefault) {
            next[token] = nextDefault;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
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
  const accountDetailsRefreshKeyRef = useRef<string | null>(null);
  const physicianDashboardRefreshSeqRef = useRef(0);
  const physicianDashboardRefreshKeyRef = useRef<string | null>(null);
  const onUserUpdatedRef = useRef(onUserUpdated);
  useEffect(() => {
    onUserUpdatedRef.current = onUserUpdated;
  }, [onUserUpdated]);
  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'details' || !user) {
      accountDetailsRefreshKeyRef.current = null;
      return;
    }
    const refreshKey = `${String(user.id || user.email || 'account')}:details`;
    if (accountDetailsRefreshKeyRef.current === refreshKey) {
      return;
    }
    accountDetailsRefreshKeyRef.current = refreshKey;
    const seq = ++accountDetailsRefreshSeqRef.current;
    (async () => {
      try {
        const api = await import('../services/api');
        const fresh = await api.authAPI.getCurrentUser({ background: true });
        if (seq !== accountDetailsRefreshSeqRef.current) return;
        if (!fresh) return;
        let nextUserState: HeaderUser | null = null;
        setLocalUser((previous) => {
          nextUserState = {
            ...(previous || user || {}),
            ...(fresh as any),
          };
          return nextUserState;
        });
        if (nextUserState) {
          onUserUpdatedRef.current?.(nextUserState);
        }
      } catch (error) {
        console.warn('[Header] Failed to refresh account details', error);
      }
    })();
  }, [welcomeOpen, accountTab, user]);
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
  const accountSourceUser = delegateMode ? null : (localUser ?? user ?? null);
  const accountRole = accountSourceUser?.role ?? null;
  const accountPartnerFlag = coerceOptionalBoolean(accountSourceUser?.salesRep?.isPartner ?? null);
  const accountAllowedRetail = coerceOptionalBoolean(accountSourceUser?.salesRep?.allowedRetail ?? null);
  const accountIsAdmin = isAdmin(accountRole);
  const accountIsSalesRep = isRep(accountRole) || isSalesLead(accountRole);
  const accountIsDoctor = isDoctorRole(accountRole);
  const accountIsPartner = !accountIsDoctor && isSalesPartner(accountRole, accountPartnerFlag);
  const accountPartnerLabel = accountIsPartner ? getSalesPartnerLabel(accountAllowedRetail) : null;
  const accountCanUploadResellerPermit = accountIsDoctor || accountIsPartner;
  const accountModalBaseName = (accountSourceUser?.name || 'Account').trim();
  const accountModalDisplayName =
    accountIsDoctor && accountModalBaseName && !/^(dr\.?|doctor)\s+/i.test(accountModalBaseName)
      ? `Dr. ${accountModalBaseName}`
      : accountModalBaseName || 'Account';
  const accountModalRoleLabel = accountIsAdmin
    ? 'Admin'
    : accountIsDoctor
      ? 'Physician'
      : accountIsPartner && accountPartnerLabel
        ? accountPartnerLabel
        : accountIsSalesRep
          ? 'Sales'
          : null;
  const headerDisplayName = accountSourceUser
    ? accountIsAdmin
      ? `Admin: ${accountSourceUser.name}`
      : isSalesLead(accountRole)
        ? `Lead: ${accountSourceUser.name}`
      : accountIsPartner && accountPartnerLabel
        ? `${accountPartnerLabel}: ${accountSourceUser.name}`
      : accountIsSalesRep
        ? `Rep: ${accountSourceUser.name}`
        : accountSourceUser.name
    : '';
  const profileImageUrl = accountSourceUser?.profileImageUrl ?? null;
  const userInitials = getInitials(accountSourceUser?.name || headerDisplayName);
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
  const accountOrdersPanelVisible =
    (welcomeOpen && accountTab === 'orders') ||
    (accountIsDoctor && physicianDashboardTab === 'orders');
  const patientLinksPanelVisible =
    (welcomeOpen && accountTab === 'patient_links') ||
    (accountIsDoctor && physicianDashboardTab === 'links');

  useLayoutEffect(() => {
    const setPortalReady = (nextReady: boolean) => {
      if (physicianDashboardPortalReadyRef.current === nextReady) {
        return;
      }
      physicianDashboardPortalReadyRef.current = nextReady;
      setPhysicianDashboardPortalReady(nextReady);
    };
    const syncPortalReady = () => {
      const nextReady = Boolean(document.getElementById(PHYSICIAN_DASHBOARD_PORTAL_ID));
      setPortalReady(nextReady);
    };

    if (delegateMode || typeof document === 'undefined' || !accountIsDoctor || suppressHomeButton) {
      setPortalReady(false);
      return;
    }

    syncPortalReady();
    if (typeof window === 'undefined') {
      return;
    }

    const raf = window.requestAnimationFrame(() => {
      syncPortalReady();
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [accountIsDoctor, delegateMode, suppressHomeButton, user?.id]);

  const physicianDashboardPortalTarget =
    physicianDashboardPortalReady && typeof document !== 'undefined'
      ? document.getElementById(PHYSICIAN_DASHBOARD_PORTAL_ID)
      : null;

  useEffect(() => {
    if (delegateMode || !accountIsDoctor || !physicianDashboardPortalTarget || !user) {
      physicianDashboardRefreshKeyRef.current = null;
      return;
    }
    const refreshKey = `${String(user.id || user.email || 'account')}:physician-dashboard`;
    if (physicianDashboardRefreshKeyRef.current === refreshKey) {
      return;
    }
    physicianDashboardRefreshKeyRef.current = refreshKey;
    const seq = ++physicianDashboardRefreshSeqRef.current;
    (async () => {
      try {
        const api = await import('../services/api');
        const fresh = await api.authAPI.getCurrentUser({ background: true });
        if (seq !== physicianDashboardRefreshSeqRef.current) return;
        if (!fresh) return;
        let nextUserState: HeaderUser | null = null;
        setLocalUser((previous) => {
          nextUserState = {
            ...(previous || user || {}),
            ...(fresh as any),
          };
          return nextUserState;
        });
        if (nextUserState) {
          onUserUpdatedRef.current?.(nextUserState);
        }
      } catch (error) {
        console.warn('[Header] Failed to refresh physician dashboard user', error);
      }
    })();
  }, [accountIsDoctor, delegateMode, physicianDashboardPortalTarget, user]);

  const updatePhysicianDashboardTabIndicator = useCallback(() => {
    const container = physicianDashboardTabsContainerRef.current;
    if (!container) {
      setPhysicianDashboardTabIndicator((current) =>
        current.opacity === 0 ? current : { left: 0, width: 0, opacity: 0 },
      );
      return;
    }
    const activeBtn =
      container.querySelector<HTMLButtonElement>(`button[data-physician-dashboard-tab="${physicianDashboardTab}"]`) ||
      container.querySelector<HTMLButtonElement>('button[data-physician-dashboard-tab]');
    if (!activeBtn) {
      setPhysicianDashboardTabIndicator((current) =>
        current.opacity === 0 ? current : { left: 0, width: 0, opacity: 0 },
      );
      return;
    }
    const inset = 8;
    const left = Math.max(0, activeBtn.offsetLeft - (container.scrollLeft || 0) + inset);
    const width = Math.max(24, activeBtn.offsetWidth - inset * 2);
    setPhysicianDashboardTabIndicator((current) => {
      if (current.left === left && current.width === width && current.opacity === 1) {
        return current;
      }
      return { left, width, opacity: 1 };
    });
  }, [physicianDashboardTab]);

  useLayoutEffect(() => {
    if (delegateMode || !accountIsDoctor || !physicianDashboardPortalTarget) {
      return;
    }
    updatePhysicianDashboardTabIndicator();
  }, [
    accountIsDoctor,
    delegateMode,
    physicianDashboardPortalTarget,
    physicianDashboardTab,
    updatePhysicianDashboardTabIndicator,
  ]);

  useEffect(() => {
    if (delegateMode || !accountIsDoctor || !physicianDashboardPortalTarget) {
      return undefined;
    }
    const handleResize = () => updatePhysicianDashboardTabIndicator();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [accountIsDoctor, delegateMode, physicianDashboardPortalTarget, updatePhysicianDashboardTabIndicator]);

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

  const clearSignupVerificationState = useCallback(() => {
    setSignupVerificationEmail('');
    setSignupVerificationEmailSent(false);
    setSignupVerificationResendPending(false);
    setSignupVerificationResendSent(false);
    setSignupVerificationResendError('');
    setSignupVerificationStartedAt(0);
    setSignupVerificationCode('');
    setSignupVerificationPending(false);
    setSignupVerificationError('');
    setSignupVerificationSuccess(false);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const applyVerificationBroadcast = (rawPayload: unknown) => {
      const payload = parseEmailVerificationBroadcastPayload(rawPayload);
      if (!payload || authMode !== 'verify') {
        return;
      }
      if (Date.now() - payload.at > EMAIL_VERIFICATION_EVENT_MAX_AGE_MS) {
        return;
      }
      if (signupVerificationStartedAt && payload.at < signupVerificationStartedAt - 1000) {
        return;
      }
      const waitingEmail = normalizeVerificationEmail(signupVerificationEmail);
      const verifiedEmail = normalizeVerificationEmail(payload.email);
      if (waitingEmail && verifiedEmail && waitingEmail !== verifiedEmail) {
        return;
      }

      const emailForLogin = verifiedEmail || waitingEmail;
      if (emailForLogin) {
        queueLoginPrefill({ email: emailForLogin, password: '' });
      }
      clearSignupVerificationState();
      setLoginError('');
      setLoginNotice('Email verified. Sign in to continue.');
      setAuthMode('login');
    };

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(EMAIL_VERIFICATION_BROADCAST_CHANNEL);
      channel.addEventListener('message', (event) => {
        applyVerificationBroadcast(event.data);
      });
    } catch {
      channel = null;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== EMAIL_VERIFICATION_STORAGE_KEY || !event.newValue) {
        return;
      }
      try {
        applyVerificationBroadcast(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed cross-tab messages.
      }
    };

    window.addEventListener('storage', handleStorage);
    try {
      const latest = window.localStorage.getItem(EMAIL_VERIFICATION_STORAGE_KEY);
      if (latest) {
        applyVerificationBroadcast(JSON.parse(latest));
      }
    } catch {
      // Ignore localStorage access failures.
    }

    return () => {
      window.removeEventListener('storage', handleStorage);
      try {
        channel?.close();
      } catch {
        // Ignore close failures.
      }
    };
  }, [
    authMode,
    clearSignupVerificationState,
    queueLoginPrefill,
    signupVerificationEmail,
    signupVerificationStartedAt,
  ]);

	  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
	    event.preventDefault();

	    if (loginSubmitting) {
	      return;
	    }

	    setLoginError('');
	    setLoginNotice('');
	    setUnverifiedLoginEmail('');
	    setVerificationResendSent(false);
	    setSignupError('');
	    setSignupNotice('');
	    setLoginSubmitting(true);

	    const formElement = event.currentTarget;
	    const emailValue = loginEmailRef.current?.value ?? '';
	    const passwordValue = loginPasswordRef.current?.value ?? '';

	    const backendDownLoginMessage = LOGIN_BACKEND_DOWN_MESSAGE;
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
	            ? backendDownLoginMessage
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
      setLoginNotice('');
      setSignupError('');
      setSignupNotice('');
      clearSignupVerificationState();
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

    if (result.status === 'email_not_verified') {
      setLoginError('Please verify your email before signing in. Send a new code to continue.');
      setUnverifiedLoginEmail(result.email || emailValue);
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

    if (result.status === 'maintenance_unavailable') {
      toast.error(backendDownLoginMessage, { id: LOGIN_BACKEND_DOWN_TOAST_ID });
      setLoginError(backendDownLoginMessage);
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
	            ? backendDownLoginMessage
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
    clearSignupVerificationState();
    if (!user) {
      setLoginOpen(true);
    }
    setWelcomeOpen(false);
  }, [clearSignupVerificationState, loginPromptToken, user]);

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
    const shippingChanged =
      JSON.stringify(match.shippingAddress ?? null) !== JSON.stringify(selectedOrder.shippingAddress ?? null);
    const billingChanged =
      JSON.stringify(match.billingAddress ?? null) !== JSON.stringify(selectedOrder.billingAddress ?? null);
    const trackingChanged = resolveTrackingNumber(match) !== resolveTrackingNumber(selectedOrder);
    const paymentChanged =
      normalize(match.paymentDetails ?? match.paymentMethod ?? '') !==
      normalize(selectedOrder.paymentDetails ?? selectedOrder.paymentMethod ?? '');
    const integrationChanged =
      JSON.stringify(match.integrationDetails ?? null) !== JSON.stringify(selectedOrder.integrationDetails ?? null);
    const matchedFacilityPickupRecipientName = isSalesOrderFacilityPickup(match)
      ? resolveFacilityPickupRecipientNameFromOrder(match)
      : null;
    const selectedFacilityPickupRecipientName = isSalesOrderFacilityPickup(selectedOrder)
      ? resolveFacilityPickupRecipientNameFromOrder(selectedOrder)
      : null;
    const recipientChanged =
      normalize(matchedFacilityPickupRecipientName) !== normalize(selectedFacilityPickupRecipientName);
    const selectedExpectedShipmentWindow =
      selectedOrderStickyEstimateWindow ||
      resolveExpectedShipmentWindow(selectedOrder) ||
      getRememberedSelectedOrderEstimateWindow(selectedOrder);
    const nextExpectedShipmentWindow =
      resolveExpectedShipmentWindow(match) ||
      selectedExpectedShipmentWindow ||
      getRememberedSelectedOrderEstimateWindow(match);
    const estimateChanged = nextExpectedShipmentWindow !== selectedExpectedShipmentWindow;

    if (
      statusChanged ||
      updatedAtChanged ||
      shippingChanged ||
      billingChanged ||
      trackingChanged ||
      paymentChanged ||
      integrationChanged ||
      recipientChanged ||
      estimateChanged
    ) {
      if (nextExpectedShipmentWindow) {
        rememberSelectedOrderEstimateWindow({
          ...selectedOrder,
          ...match,
          expectedShipmentWindow: nextExpectedShipmentWindow,
        });
      }
      const mergedExpectedShipmentWindow =
        resolveExpectedShipmentWindow(match) ||
        resolveExpectedShipmentWindow(selectedOrder) ||
        getRememberedSelectedOrderEstimateWindow(match) ||
        getRememberedSelectedOrderEstimateWindow(selectedOrder) ||
        null;
      const mergedFacilityPickupRecipientName =
        matchedFacilityPickupRecipientName || selectedFacilityPickupRecipientName;
      const mergedShippingAddress =
        match.shippingAddress ?? selectedOrder.shippingAddress ?? null;
      const mergedBillingAddress =
        match.billingAddress ?? selectedOrder.billingAddress ?? null;
      setSelectedOrder({
        ...selectedOrder,
        ...match,
        ...(mergedFacilityPickupRecipientName
          ? {
              facilityPickupRecipientName: mergedFacilityPickupRecipientName,
              facility_pickup_recipient_name: mergedFacilityPickupRecipientName,
              pickupRecipientName: mergedFacilityPickupRecipientName,
              pickup_recipient_name: mergedFacilityPickupRecipientName,
              recipientName: mergedFacilityPickupRecipientName,
              recipient_name: mergedFacilityPickupRecipientName,
              orderRecipientName: mergedFacilityPickupRecipientName,
              order_recipient_name: mergedFacilityPickupRecipientName,
            }
          : {}),
        expectedShipmentWindow: mergedExpectedShipmentWindow,
        shippingEstimate: match.shippingEstimate ?? selectedOrder.shippingEstimate ?? null,
        shippingAddress: mergedFacilityPickupRecipientName
          ? withFacilityPickupRecipientName(mergedShippingAddress, {
              preferredName: mergedFacilityPickupRecipientName,
              billingAddress: mergedBillingAddress,
            }) || mergedShippingAddress
          : mergedShippingAddress,
        billingAddress: mergedFacilityPickupRecipientName
          ? withFacilityPickupRecipientName(mergedBillingAddress, {
              preferredName: mergedFacilityPickupRecipientName,
              billingAddress: mergedShippingAddress,
            }) || mergedBillingAddress
          : mergedBillingAddress,
        integrationDetails: match.integrationDetails ?? selectedOrder.integrationDetails ?? null,
      });
    }
  }, [
    cachedAccountOrders,
    getRememberedSelectedOrderEstimateWindow,
    rememberSelectedOrderEstimateWindow,
    selectedOrderStickyEstimateWindow,
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

  // Orders are kept current through app data events, focus refreshes, and user actions.
  useEffect(() => {
    if (!accountOrdersPanelVisible || !onRefreshOrders || !user) {
      return undefined;
    }
    void Promise.resolve(onRefreshOrders()).catch((error) => {
      console.debug('[Orders] Panel refresh skipped', error);
    });
    return undefined;
	  }, [accountOrdersPanelVisible, onRefreshOrders, user]);

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
      "trufusion:logout-with-thanks",
      handleLogoutWithThanks as EventListener,
    );
    return () => {
      window.removeEventListener(
        "trufusion:logout-with-thanks",
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

    document.documentElement.classList.add('app-fixed-header-active');
    document.body.classList.add('app-fixed-header-active');

    const updateHeightVariable = () => {
      const layoutHeight = headerElement.offsetHeight;
      const { height } = headerElement.getBoundingClientRect();
      const nextHeight = layoutHeight > 0 ? layoutHeight : height;
      if (nextHeight > 0) {
        document.documentElement.style.setProperty(
          '--app-header-height',
          `${Math.ceil(nextHeight)}px`,
        );
      }
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
      document.documentElement.classList.remove('app-fixed-header-active');
      document.body.classList.remove('app-fixed-header-active');
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
    window.addEventListener('trufusion:close-dialogs', handleGlobalClose);
    return () => {
      window.removeEventListener('trufusion:close-dialogs', handleGlobalClose);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleLegalState = (event: Event) => {
      const custom = event as CustomEvent<{ open?: boolean }>;
      setLegalModalOpen(Boolean(custom.detail?.open));
    };
    window.addEventListener('trufusion:legal-state', handleLegalState);
    return () => {
      window.removeEventListener('trufusion:legal-state', handleLegalState);
    };
  }, []);

  useLayoutEffect(() => {
    if (!welcomeOpen) {
      accountTabScrollTopRef.current = {};
      restoreAccountTabScrollRef.current = {};
      return;
    }
    if (legalModalOpen) {
      if (!restoreAccountTabScrollRef.current[accountTab]) {
        storeAccountTabScrollPosition(accountTab);
      }
      applyStoredAccountTabScrollPosition(accountTab);
      return;
    }
    if (!restoreAccountTabScrollRef.current[accountTab]) {
      return;
    }
    applyStoredAccountTabScrollPosition(accountTab, { clearRestoreFlag: true });
  }, [accountTab, applyStoredAccountTabScrollPosition, legalModalOpen, storeAccountTabScrollPosition, welcomeOpen]);

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
    if (signupSubmitting) {
      return;
    }
    const fullName = signupSuffix ? `${signupSuffix} ${signupName}`.trim() : signupName;

    const details = {
      name: fullName,
      email: signupEmail,
      password: signupPassword,
      confirmPassword: signupConfirmPassword,
      code: signupCode,
    };

    setSignupError('');
    setSignupNotice('');
    setLoginError('');
    setLoginNotice('');

    let result: AuthActionResult;
    setSignupSubmitting(true);
    try {
      result = onCreateAccount
        ? await onCreateAccount(details)
        : onLogin
          ? await onLogin(signupEmail, signupPassword)
          : ({ status: 'error', message: 'LOGIN_UNAVAILABLE' } as AuthActionResult);
    } catch (error) {
      console.warn('[Auth] Signup submit failed', error);
      setSignupError('Unable to submit your account right now. Please try again.');
      setSignupSubmitting(false);
      return;
    }
    setSignupSubmitting(false);

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
      setSignupNotice('');
      setLoginError('');
      setLoginNotice('');
      if (loginContext !== 'checkout') {
        setWelcomeOpen(true);
      }
      return;
    }

    if (result.status === 'email_verification_required') {
      const destination = result.email || details.email;
      setSignupVerificationEmail(destination);
      setSignupVerificationEmailSent(Boolean(result.emailSent));
      setSignupVerificationResendPending(false);
      setSignupVerificationResendSent(false);
      setSignupVerificationResendError('');
      setSignupVerificationStartedAt(Date.now());
      setSignupVerificationCode('');
      setSignupVerificationPending(false);
      setSignupVerificationError('');
      setSignupVerificationSuccess(false);
      queueLoginPrefill({ email: destination, password: '' });
      setAuthMode('verify');
      setSignupError('');
      setSignupNotice('');
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
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

    if (result.status === 'maintenance_unavailable') {
      setSignupError('');
      toast.error(LOGIN_BACKEND_DOWN_MESSAGE, { id: LOGIN_BACKEND_DOWN_TOAST_ID });
      setLoginError(LOGIN_BACKEND_DOWN_MESSAGE);
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
      setSignupNotice('');
      clearSignupVerificationState();
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
      triggerBrowserDownload(blob, filename || `TruFusion_Labs_Invoice_${resolvedId}.pdf`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to download invoice right now.';
      toast.error(message);
    } finally {
      invoiceDownloadInflightRef.current.delete(resolvedId);
    }
  }, []);

  useEffect(() => {
    if (!accountOrdersPanelVisible) {
      return;
    }

    const visibleOrders = cachedAccountOrders
      .filter((order) => {
        const source = (order.source || '').toLowerCase();
        const hasWooIntegration = Boolean(
          (order.integrationDetails as any)?.wooCommerce ||
          (order.integrationDetails as any)?.woocommerce,
        );
        return source === 'woocommerce' || source === 'trufusion' || source === 'local' || hasWooIntegration;
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
    accountOrdersPanelVisible,
    cachedAccountOrders,
    showCanceledOrders,
    ensureOrderLineImageLoaded,
    extractWooLineItemsFromOrder,
    extractOrderLineImageKey,
    isCanceledOrRefundedStatus,
  ]);

  useEffect(() => {
    if (!accountOrdersPanelVisible || !selectedOrder) {
      return;
    }
    const wooLineItems = extractWooLineItemsFromOrder(selectedOrder);
    const lines = Array.isArray(selectedOrder.lineItems) ? selectedOrder.lineItems : [];
    lines.forEach((line) => {
      void ensureOrderLineImageLoaded(line, wooLineItems);
    });
  }, [accountOrdersPanelVisible, selectedOrder, ensureOrderLineImageLoaded, extractWooLineItemsFromOrder]);

  useEffect(() => {
    if (!accountOrdersPanelVisible || !selectedOrder) {
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
  }, [accountOrdersPanelVisible, selectedOrder?.id]);

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
          className="header-cart-button inline-flex squircle-sm transition-all duration-300"
        >
          {delegateMode ? (
            <ClipboardDocumentListIcon className="h-4 w-4" />
          ) : (
            <ShoppingCart className="h-4 w-4" />
          )}
        </Button>
        <span
          className="header-action-count-badge header-count-indicator"
          aria-label={`${cartItems} item${cartItems === 1 ? "" : "s"} in cart`}
        >
          {cartItems}
        </span>
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
      textColor?: string | null;
    },
  ) => {
    const searchBorderColor =
      options?.borderColor || (delegateMode ? secondaryColor : HEADER_BRAND_BLUE);
    const searchTextColor =
      options?.textColor || (delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY);
    return (
      <div
        className="header-search-field relative isolate"
        style={{
          '--header-search-border-color': searchBorderColor,
          '--header-search-text-color': searchTextColor,
          color: searchTextColor,
        } as CSSProperties}
      >
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
          className={`header-search-input relative z-0 squircle-sm !h-[2.4rem] !min-h-[2.4rem] !max-h-[2.4rem] box-border pl-10 pr-12 placeholder:text-white focus-visible:outline-none focus-visible:!ring-0 ${inputClassName}`.trim()}
          style={{
            minWidth: '100%',
            color: searchTextColor,
            caretColor: searchTextColor,
          }}
          readOnly={Boolean(options?.readOnly)}
        />
        <Search
          aria-hidden="true"
          focusable="false"
          className="header-search-icon pointer-events-none absolute left-3 top-1/2 z-20 block h-4 w-4 -translate-y-1/2 transform"
          style={{ color: searchTextColor, stroke: searchTextColor, zIndex: 20 }}
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
		          className="header-search-clear-button absolute right-3 left-auto top-1/2 z-20 -translate-y-1/2 rounded-full p-1 text-slate-900/70 transition-colors hover:bg-white/50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.4)]"
            style={{ right: '0.75rem', left: 'auto' }}
	        >
	          <X className="h-4 w-4" />
	        </button>
	      )}
      </div>
    );
  };

  const normalizedRole = String((localUser as any)?.role || '').toLowerCase();
  const showPatientLinksTab = Boolean(
    localUser && (
      normalizedRole === 'test_doctor'
      || normalizedRole === 'doctor'
    ),
  );
  const normalizedPatientLinksDoctorIds = useMemo(
    () => (Array.isArray(patientLinksDoctorUserIds) ? patientLinksDoctorUserIds : [])
      .map((entry) => String(entry || '').trim())
      .filter((entry) => entry.length > 0),
    [patientLinksDoctorUserIds],
  );
  const currentUserId = String(localUser?.id || user?.id || '').trim();
  const physicianDelegateLinksEnabled =
    showPatientLinksTab
    && (
      coerceOptionalBoolean(
        localUser?.delegateLinksEnabled ?? (localUser as any)?.delegate_links_enabled,
      ) === true
      || (currentUserId.length > 0 && normalizedPatientLinksDoctorIds.includes(currentUserId))
    );
  const showPatientLinksBetaLabel = Array.isArray(betaServices)
    && betaServices.includes('patientLinks')
    && physicianDelegateLinksEnabled;
  const delegateOptInEnabled = coerceOptionalBoolean(
    localUser?.delegateOptIn ?? (localUser as any)?.delegate_opt_in,
  ) === true;
  const delegateLinkCreationEnabled = physicianDelegateLinksEnabled;
  const brochureLinkCreationEnabled = showPatientLinksTab;
  const hasCreateLinkTypeOptions = delegateLinkCreationEnabled || brochureLinkCreationEnabled;
  const showCreateLinkTypeChooser = delegateLinkCreationEnabled && brochureLinkCreationEnabled;
  useEffect(() => {
    if (!brochureLinkCreationEnabled) {
      return;
    }
    if (
      (!delegateLinkCreationEnabled && createLinkDialogMode === 'delegate')
      || (!showCreateLinkTypeChooser && createLinkDialogMode === 'select')
    ) {
      setCreateLinkDialogMode('brochure');
    }
  }, [
    brochureLinkCreationEnabled,
    createLinkDialogMode,
    delegateLinkCreationEnabled,
    showCreateLinkTypeChooser,
  ]);
  useEffect(() => {
    if (!delegateLinkCreationEnabled && patientLinksTypeFilter !== 'all') {
      setPatientLinksTypeFilter('all');
    }
  }, [delegateLinkCreationEnabled, patientLinksTypeFilter]);
  const accountHeaderTabs = useMemo(() => {
    const tabs: Array<{ id: AccountTabId; label: string; Icon: any }> = [
      { id: 'details', label: 'Details', Icon: Info },
    ];
    if (!accountIsDoctor) {
      tabs.push({ id: 'orders', label: 'Orders', Icon: Package });
    }
    if (!accountIsDoctor && showPatientLinksTab) {
      tabs.push({ id: 'patient_links', label: 'Delegate Links', Icon: Link2 });
    }
    tabs.push({ id: 'research', label: 'Research', Icon: Users });
    return tabs;
  }, [accountIsDoctor, showPatientLinksTab]);

  useEffect(() => {
    if (accountIsDoctor && welcomeOpen && (accountTab === 'orders' || accountTab === 'patient_links')) {
      setAccountTab('details');
    }
  }, [accountIsDoctor, accountTab, welcomeOpen]);

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
      const sanitizedLinks = links.filter((link: any) => {
        const token = typeof (link as any)?.token === 'string' ? (link as any).token.trim() : '';
        return !token.startsWith('node-ui-dummy-link');
      });
      const now = Date.now();
      const activationOverrides = patientLinksActivatedTokenOverridesRef.current;
      const hydratedLinks = sanitizedLinks.map((link: any) => {
        const token = readPatientLinkText(link, ['token']);
        const overrideUntil = token ? activationOverrides.get(token) : null;
        if (!token || !overrideUntil) {
          return link;
        }
        if (overrideUntil <= now) {
          activationOverrides.delete(token);
          return link;
        }
        if (!isPatientLinkRevoked(link)) {
          activationOverrides.delete(token);
          return link;
        }
        return {
          ...link,
          revokedAt: null,
          revoked_at: null,
          status: 'active',
        };
      });
      if (isNodePatientLinkDummyMode) {
        setPatientLinks([
          ...createNodeDummyPatientLinks(localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null),
          ...hydratedLinks,
        ]);
      } else {
        setPatientLinks(hydratedLinks);
      }
      setPatientLinkMarkupDraft(String(markupPercent));
    } catch (error: any) {
      const status = typeof error?.status === 'number' ? error.status : null;
      const delegationRouteMissing = status === 404 || status === 405;
      if (delegationRouteMissing && isNodePatientLinkDummyMode) {
        setPatientLinks(createNodeDummyPatientLinks(localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null));
        setPatientLinkMarkupDraft('15');
        setPatientLinksError(null);
        return;
      }
      if (isNodePatientLinkDummyMode) {
        setPatientLinks(createNodeDummyPatientLinks(localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null));
        setPatientLinkMarkupDraft('15');
        setPatientLinksError(null);
        return;
      }
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'Unable to load delegate links right now.';
      setPatientLinksError(message);
      setPatientLinks([]);
    } finally {
      const shouldRestorePatientLinksScroll = patientLinksPreserveScrollOnNextLoadRef.current;
      patientLinksPreserveScrollOnNextLoadRef.current = false;
      setPatientLinksLoading(false);
      patientLinksLoadInFlightRef.current = false;
      if (shouldRestorePatientLinksScroll) {
        restorePatientLinksScrollPosition();
      }
      if (patientLinksQueuedReloadRef.current) {
        patientLinksQueuedReloadRef.current = false;
        if (shouldRestorePatientLinksScroll) {
          patientLinksPreserveScrollOnNextLoadRef.current = true;
        }
        void loadPatientLinksRef.current?.();
      }
    }
  }, [
    localUser?.name,
    localUser?.zelleContact,
    normalizeMarkupPercent,
    restorePatientLinksScrollPosition,
    showPatientLinksTab,
    user?.name,
  ]);

  useEffect(() => {
    loadPatientLinksRef.current = loadPatientLinks;
  }, [loadPatientLinks]);

  const requestPatientLinksRefresh = useCallback((options?: { force?: boolean; preserveScroll?: boolean }) => {
    if (!showPatientLinksTab) {
      return;
    }
    if (options?.preserveScroll) {
      capturePatientLinksScrollPosition();
      patientLinksPreserveScrollOnNextLoadRef.current = true;
    }
    if (patientLinksLoadInFlightRef.current) {
      if (options?.force) {
        patientLinksQueuedReloadRef.current = true;
      }
      return;
    }
    void loadPatientLinks();
  }, [capturePatientLinksScrollPosition, loadPatientLinks, showPatientLinksTab]);

  const patientLinksTypeCounts = useMemo(() => {
    const counts: Record<PatientLinkTypeFilter, number> = {
      all: patientLinks.length,
      delegate: 0,
      brochure: 0,
    };
    for (const link of patientLinks) {
      counts[normalizePatientLinkType(link)] += 1;
    }
    return counts;
  }, [patientLinks]);

  const filteredPatientLinks = useMemo(() => {
    if (patientLinksTypeFilter === 'all') {
      return patientLinks;
    }
    return patientLinks.filter((link) => normalizePatientLinkType(link) === patientLinksTypeFilter);
  }, [patientLinks, patientLinksTypeFilter]);

  useEffect(() => {
    if (!Array.isArray(patientLinks) || patientLinks.length === 0) {
      return;
    }

    setPatientLinkPaymentMethodDraftByToken((prev) => {
      let changed = false;
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
        changed = true;
      }
      return changed ? next : prev;
    });

    setPatientLinkInstructionsDraftByToken((prev) => {
      let changed = false;
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
        changed = true;
      }
      return changed ? next : prev;
    });

    setPatientLinkReviewNotesDraftByToken((prev) => {
      let changed = false;
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
        changed = true;
      }
      return changed ? next : prev;
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
        requestPatientLinksRefresh({ force: true, preserveScroll: true });
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
      localUser?.name,
      localUser?.zelleContact,
      patientLinkInstructionsDraftByToken,
      patientLinkPaymentMethodDraftByToken,
      patientLinksSavingPaymentToken,
      requestPatientLinksRefresh,
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
        && proposalStatus !== 'modified'
        && proposalStatus !== 'rejected';
      return count + (isOutstanding ? 1 : 0);
    }, 0);
  }, [patientLinks]);

  useLayoutEffect(() => {
    if (delegateMode || !accountIsDoctor || !physicianDashboardPortalTarget) {
      return;
    }
    updatePhysicianDashboardTabIndicator();
  }, [
    accountIsDoctor,
    delegateMode,
    outstandingPatientProposalCount,
    physicianDashboardPortalTarget,
    updatePhysicianDashboardTabIndicator,
  ]);

  const accountTabIndicatorCounts = useMemo<Partial<Record<AccountTabId, number>>>(() => {
    const counts: Partial<Record<AccountTabId, number>> = {};
    if (showPatientLinksTab && outstandingPatientProposalCount > 0) {
      counts.patient_links = outstandingPatientProposalCount;
    }
    return counts;
  }, [outstandingPatientProposalCount, showPatientLinksTab]);

  const accountButtonIndicatorTotal = useMemo(() => {
    const visibleAccountTabIds = new Set(accountHeaderTabs.map((tab) => tab.id));
    return Object.entries(accountTabIndicatorCounts).reduce((sum, [tabId, count]) => {
      if (!visibleAccountTabIds.has(tabId as AccountTabId)) {
        return sum;
      }
      return sum + (Number(count) || 0);
    }, 0);
  }, [accountHeaderTabs, accountTabIndicatorCounts]);

  useEffect(() => {
    onAccountIndicatorTotalChange?.(accountButtonIndicatorTotal);
  }, [accountButtonIndicatorTotal, onAccountIndicatorTotalChange]);

  useEffect(() => {
    if (!showPatientLinksTab) {
      patientLinksPrefetchedRef.current = false;
      patientLinksQueuedReloadRef.current = false;
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
    requestPatientLinksRefresh({ force: true });
  }, [patientLinksRefreshToken, requestPatientLinksRefresh, showPatientLinksTab]);

  const delegateProductPickerItems = useMemo(() => {
    const items = (catalogProducts || [])
      .map((product) => {
        const key = getDelegatePickerProductKey(product);
        if (!key) return null;
        return {
          key,
          name: String(product?.name || 'Untitled product').trim() || 'Untitled product',
          sku: typeof product?.sku === 'string' ? product.sku.trim() : '',
          category: typeof product?.category === 'string' ? product.category.trim() : '',
          researchDomains: getDelegatePickerProductResearchDomains(product),
          image: getDelegatePickerProductImage(product),
          inStock: product?.inStock !== false,
          tokens: getDelegatePickerProductTokens(product),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }, [catalogProducts]);

  const patientLinkApprovedProductIdSet = useMemo(
    () => new Set(patientLinkApprovedProductIds),
    [patientLinkApprovedProductIds],
  );

  const patientLinkApprovedProductTokens = useMemo(() => {
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const item of delegateProductPickerItems) {
      if (!patientLinkApprovedProductIdSet.has(item.key)) continue;
      for (const token of item.tokens) {
        const normalized = String(token || '').trim();
        if (!normalized) continue;
        const dedupeKey = normalized.toUpperCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        tokens.push(normalized);
      }
    }
    return tokens;
  }, [delegateProductPickerItems, patientLinkApprovedProductIdSet]);

  const patientLinkCartProductTokens = useMemo(() => {
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const token of Array.isArray(cartProductTokens) ? cartProductTokens : []) {
      const normalized = String(token || '').trim();
      if (!normalized) continue;
      const dedupeKey = normalized.toUpperCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tokens.push(normalized);
    }
    return formatAllowedProductsForDisplay(tokens);
  }, [cartProductTokens]);

  const patientLinkCartProductCount = Math.max(
    0,
    Math.floor(Number(cartProductCount) || 0),
  );

  const getPatientLinkProductIdsForTokens = useCallback((tokens: string[]) => {
    const normalizedTokens = new Set(
      (Array.isArray(tokens) ? tokens : [])
        .map((token) => String(token || '').trim().toUpperCase())
        .filter(Boolean),
    );
    if (normalizedTokens.size === 0) {
      return [];
    }
    return delegateProductPickerItems
      .filter((item) => item.tokens.some((token) => normalizedTokens.has(String(token || '').trim().toUpperCase())))
      .map((item) => item.key);
  }, [delegateProductPickerItems]);

  const openPatientLinkModifyModal = useCallback((link: any) => {
    const token = readPatientLinkText(link, ['token']);
    if (!token) {
      toast.error('Unable to modify this link because the token is missing.');
      return;
	    }
	    const linkType = normalizePatientLinkType(link);
	    if (linkType === 'delegate' && !delegateLinkCreationEnabled) {
	      toast.error('Proposal links are not enabled for this physician.');
	      return;
	    }
	    const subjectLabel = readPatientLinkText(link, ['subjectLabel', 'subject_label', 'patientId', 'patient_id']);
    const brochureName = readPatientLinkText(link, ['brochureName', 'brochure_name']);
    const linkName =
      readPatientLinkText(link, ['linkName', 'link_name'])
      || (linkType === 'brochure' ? brochureName : subjectLabel)
      || readPatientLinkText(link, ['referenceLabel', 'reference_label', 'label']);
    const studyLabel = readPatientLinkText(link, ['studyLabel', 'study_label']);
    const patientReference = readPatientLinkText(link, ['patientReference', 'patient_reference']);
    const delegateName = readPatientLinkText(link, ['delegateName', 'delegate_name']);
    const delegateContact = readPatientLinkText(link, ['delegateContact', 'delegate_contact']);
    const recipientName = readPatientLinkText(link, ['recipientName', 'recipient_name']) || delegateName;
    const recipientContact = readPatientLinkText(link, ['recipientContact', 'recipient_contact']) || delegateContact;
    const productScopeRaw = readPatientLinkText(link, ['productScope', 'product_scope']) as DelegateProductScope;
    const productScope: DelegateProductScope =
      productScopeRaw === 'specific_products' || productScopeRaw === 'specific_cart_only'
        ? productScopeRaw
        : 'all_physician_approved';
    const productTokens = readPatientLinkStringList(link, [
      'allowedProducts',
      'allowed_products',
      'productScopeItems',
      'product_scope_items',
    ]);
    const delegateRoleRaw = readPatientLinkText(link, ['delegateRole', 'delegate_role']) as DelegateRole;
    const delegateRole = delegateRoleOptions.some((option) => option.value === delegateRoleRaw)
      ? delegateRoleRaw
      : 'patient';
    const delegatePermissionRaw = readPatientLinkText(link, ['delegatePermission', 'delegate_permission']) as DelegatePermission;
    const delegatePermission = delegatePermissionRaw === 'view_products_only'
      ? 'view_products_only'
      : 'submit_for_physician_review';
    const paymentMethod = normalizePatientLinkPaymentMethod(
      readPatientLinkText(link, ['paymentMethod', 'payment_method', 'payment_method_id']),
    );
    const createdAt = readPatientLinkText(link, ['createdAt', 'created_at']);
    const expiresAt = readPatientLinkText(link, ['expiresAt', 'expires_at']);
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    const durationHours =
      Number.isFinite(createdMs) && Number.isFinite(expiresMs) && expiresMs > createdMs
        ? Math.ceil((expiresMs - createdMs) / 3_600_000)
        : Number.isFinite(expiresMs) && expiresMs > Date.now()
          ? Math.ceil((expiresMs - Date.now()) / 3_600_000)
          : Number(DEFAULT_DELEGATE_LINK_EXPIRY_HOURS);
    const paymentInstructions =
      readPatientLinkText(link, ['paymentInstructions', 'payment_instructions'])
      || buildPatientLinkDefaultInstructions(paymentMethod, zelleContactDraft.trim() || localUser?.zelleContact || null, localUser?.name ?? user?.name ?? null);

    setPatientLinkEditing({
      token,
      linkType,
      label: linkName || `${getPatientLinkTypeLabel(linkType)} link`,
      originalProductTokens: productTokens,
    });
    setCreateLinkLegalDocumentKey(null);
    setPatientLinkProductPickerOpen(false);
    setPatientLinkSubjectLabelDraft(linkType === 'brochure' ? '' : linkName);
    setPatientLinkBrochureNameDraft(linkType === 'brochure' ? linkName : '');
    setPatientLinkStudyLabelDraft(studyLabel);
    setPatientLinkReferenceDraft(patientReference);
    setPatientLinkDelegateNameDraft(delegateName);
    setPatientLinkDelegateContactDraft(delegateContact);
    setPatientLinkRecipientNameDraft(recipientName);
    setPatientLinkRecipientContactDraft(recipientContact);
    setPatientLinkDelegateRoleDraft(delegateRole);
    setPatientLinkProductScopeDraft(productScope);
    setPatientLinkApprovedProductIds(getPatientLinkProductIdsForTokens(productTokens));
    setPatientLinkProductPickerQuery('');
    setPatientLinkProductPickerDomain('all');
    setPatientLinkDelegatePermissionDraft(linkType === 'brochure' ? 'view_products_only' : delegatePermission);
    setPatientLinkExpiryHoursDraft(String(Math.max(1, durationHours || Number(DEFAULT_DELEGATE_LINK_EXPIRY_HOURS))));
    setPatientLinkMarkupDraft(String(normalizeMarkupPercent((link as any)?.markupPercent ?? (link as any)?.markup_percent ?? 0)));
    setPatientLinkPricingDisclosureDraft(
      readPatientLinkText(link, ['pricingDisclosure', 'pricing_disclosure']) || DEFAULT_DELEGATE_PRICING_DISCLOSURE,
    );
    setPatientLinkZelleRecipientNameDraft(readPatientLinkText(link, ['zelleRecipientName', 'zelle_recipient_name']));
    setPatientLinkPaymentConfirmationRequired(
      coerceOptionalBoolean((link as any)?.paymentConfirmationRequired ?? (link as any)?.payment_confirmation_required) ?? true,
    );
    setPatientLinkResearchNoteDraft(readPatientLinkText(link, ['instructions']));
    setPatientLinkDelegateInstructionsDraft(readPatientLinkText(link, ['delegateInstructions', 'delegate_instructions']));
    setPatientLinkInternalPhysicianNoteDraft(readPatientLinkText(link, ['internalPhysicianNote', 'internal_physician_note']));
    setPatientLinkPaymentMethodDraft(paymentMethod);
    setPatientLinkInstructionsDraft(paymentInstructions);
    setPatientLinkTermsAccepted(true);
    setCreateLinkDialogMode(linkType === 'brochure' ? 'brochure' : 'delegate');
    setCreateLinkDialogOpen(true);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const dialogContent = createLinkDialogContentRef.current;
        if (!dialogContent) return;
        dialogContent.scrollTop = 0;
        dialogContent.scrollLeft = 0;
      });
    }
	  }, [
	    delegateLinkCreationEnabled,
	    getPatientLinkProductIdsForTokens,
    localUser?.name,
    localUser?.zelleContact,
    normalizeMarkupPercent,
    user?.name,
    zelleContactDraft,
  ]);

  const delegateProductPickerDomainOptions = useMemo(() => {
    const domains = new Map<string, { label: string; count: number }>();
    for (const item of delegateProductPickerItems) {
      for (const domain of item.researchDomains) {
        const key = domain.slug.trim();
        if (!key) continue;
        const existing = domains.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          domains.set(key, { label: domain.name, count: 1 });
        }
      }
    }
    return Array.from(domains.entries())
      .map(([key, domain]) => ({ key, label: domain.label, count: domain.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [delegateProductPickerItems]);

  const filteredDelegateProductPickerItems = useMemo(() => {
    const query = patientLinkProductPickerQuery.trim().toLowerCase();
    const domain = patientLinkProductPickerDomain.trim().toLowerCase();
    return delegateProductPickerItems.filter((item) => {
      if (domain && domain !== 'all' && !item.researchDomains.some((entry) => entry.slug === domain)) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = `${item.name} ${item.sku} ${item.category} ${item.researchDomains.map((entry) => entry.name).join(' ')}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [delegateProductPickerItems, patientLinkProductPickerDomain, patientLinkProductPickerQuery]);

  useEffect(() => {
    if (!patientLinkProductPickerOpen || !onEnsureCatalogProductMedia) {
      return;
    }
    let cancelled = false;
    const candidates = (catalogProducts || [])
      .filter((product) => {
        const image = getDelegatePickerProductImage(product);
        return !image || isDelegatePickerPlaceholderImage(image);
      })
      .slice(0, 12);

    void (async () => {
      for (const product of candidates) {
        if (cancelled) break;
        try {
          await onEnsureCatalogProductMedia(product);
        } catch {
          // Catalog media repair is best-effort; the row fallback still renders.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [catalogProducts, onEnsureCatalogProductMedia, patientLinkProductPickerOpen]);

  useEffect(() => {
    if (!patientLinkProductPickerOpen || typeof window === 'undefined') {
      return;
    }
    const imagesToWarm = filteredDelegateProductPickerItems
      .map((item) => item.image)
      .filter((src): src is string => Boolean(src && !isDelegatePickerPlaceholderImage(src)))
      .slice(0, 80);
    for (const src of imagesToWarm) {
      const image = new Image();
      image.decoding = 'async';
      image.loading = 'eager';
      image.src = src;
    }
  }, [filteredDelegateProductPickerItems, patientLinkProductPickerOpen]);

  const togglePatientLinkApprovedProduct = useCallback((productKey: string) => {
    const normalized = String(productKey || '').trim();
    if (!normalized) return;
    setPatientLinkApprovedProductIds((prev) => {
      if (prev.includes(normalized)) {
        return prev.filter((entry) => entry !== normalized);
      }
      return [...prev, normalized];
    });
  }, []);

  const closePatientLinkProductPicker = useCallback((event?: MouseEvent<HTMLElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    setCreateLinkDialogOpen(true);
    setCreateLinkDialogMode(createLinkDialogMode === 'brochure' ? 'brochure' : 'delegate');
    setPatientLinkProductPickerOpen(false);
    restoreCreateLinkDialogScrollPosition();
  }, [createLinkDialogMode, restoreCreateLinkDialogScrollPosition]);

  const handleCreateLinkBackToSelect = useCallback((event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setPatientLinkProductPickerOpen(false);
    setCreateLinkDialogOpen(true);
    setCreateLinkDialogMode(showCreateLinkTypeChooser ? 'select' : 'brochure');
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const dialogContent = createLinkDialogContentRef.current;
        if (!dialogContent) {
          return;
        }
        dialogContent.scrollTop = 0;
        dialogContent.scrollLeft = 0;
      });
    }
  }, [showCreateLinkTypeChooser]);

	  const handleCreatePatientLink = useCallback(async () => {
    if (!showPatientLinksTab || !delegateLinkCreationEnabled || patientLinksCreating) {
      return;
    }
    if (!patientLinkTermsAccepted) {
      toast.error('Accept the terms to continue.');
      return;
    }
    const expiresInHours = Number(patientLinkExpiryHoursDraft);
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
      toast.error('Expiration hours must be greater than zero.');
      return;
    }
    setPatientLinksCreating(true);
    try {
      const api = await import('../services/api');
      const zelleContact = zelleContactDraft.trim();
      const savedZelleContact =
        typeof localUser?.zelleContact === 'string' ? localUser.zelleContact.trim() : '';
      if (patientLinkPaymentMethodDraft === 'zelle' && zelleContact !== savedZelleContact) {
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
      const linkName = patientLinkSubjectLabelDraft.trim();
      const studyLabel = patientLinkStudyLabelDraft.trim();
      const patientReference = patientLinkReferenceDraft.trim();
      const delegateName = patientLinkDelegateNameDraft.trim();
      const delegateContact = patientLinkDelegateContactDraft.trim();
      const pricingDisclosure = patientLinkPricingDisclosureDraft.trim();
      const zelleRecipientName = patientLinkZelleRecipientNameDraft.trim();
      const delegateInstructions = patientLinkDelegateInstructionsDraft.trim();
      const internalPhysicianNote = patientLinkInternalPhysicianNoteDraft.trim();
      const approvedProductTokensForPayload =
        patientLinkProductScopeDraft === 'specific_cart_only'
          ? patientLinkCartProductTokens
          : patientLinkProductScopeDraft === 'all_physician_approved' || patientLinkProductScopeDraft === 'specific_products'
          ? patientLinkApprovedProductTokens
          : [];
      if (patientLinkProductScopeDraft === 'specific_products' && approvedProductTokensForPayload.length === 0) {
        toast.error('Choose at least one product for this proposal.');
        setPatientLinksCreating(false);
        return;
      }
      if (patientLinkProductScopeDraft === 'specific_cart_only' && approvedProductTokensForPayload.length === 0) {
        toast.error('Add at least one cart product for this proposal.');
        setPatientLinksCreating(false);
        return;
      }
      const markupPercent = normalizeMarkupPercent(patientLinkMarkupDraft);
      const paymentMethod = patientLinkPaymentMethodDraft === 'zelle' ? 'zelle' : '';
      const paymentInstructionsDraft = patientLinkInstructionsDraft.trim();
      const paymentInstructions = paymentMethod === 'zelle'
        ? (paymentInstructionsDraft || buildPatientLinkDefaultInstructions('zelle', zelleContact || null, localUser?.name ?? user?.name ?? null))
        : '';
      await api.delegationAPI.createLink({
        linkName: linkName ? linkName : null,
        referenceLabel: linkName ? linkName : null,
        patientId: null,
        subjectLabel: null,
        studyLabel: studyLabel ? studyLabel : null,
        patientReference: patientReference ? patientReference : null,
        delegateName: delegateName ? delegateName : null,
        delegateContact: delegateContact ? delegateContact : null,
        delegateRole: patientLinkDelegateRoleDraft,
        productScope: patientLinkProductScopeDraft,
        productScopeItems: approvedProductTokensForPayload,
        delegatePermission: patientLinkDelegatePermissionDraft,
        markupPercent,
        pricingDisclosure: pricingDisclosure || DEFAULT_DELEGATE_PRICING_DISCLOSURE,
        zelleRecipientName: paymentMethod === 'zelle' && zelleRecipientName ? zelleRecipientName : null,
        paymentConfirmationRequired: paymentMethod === 'zelle' ? patientLinkPaymentConfirmationRequired : false,
        delegateInstructions: delegateInstructions ? delegateInstructions : null,
        internalPhysicianNote: internalPhysicianNote ? internalPhysicianNote : null,
        termsVersion: CURRENT_TERMS_VERSION,
        shippingPolicyVersion: CURRENT_SHIPPING_POLICY_VERSION,
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        instructions: patientLinkResearchNoteDraft.trim() ? patientLinkResearchNoteDraft.trim() : null,
        allowedProducts: approvedProductTokensForPayload,
        expiresInHours,
        paymentMethod,
        paymentInstructions,
        physicianCertified: patientLinkTermsAccepted,
      });
      setPatientLinkSubjectLabelDraft('');
      setPatientLinkStudyLabelDraft('');
      setPatientLinkReferenceDraft('');
      setPatientLinkDelegateNameDraft('');
      setPatientLinkDelegateContactDraft('');
      setPatientLinkDelegateRoleDraft('patient');
      setPatientLinkProductScopeDraft('all_physician_approved');
      setPatientLinkApprovedProductIds([]);
      setPatientLinkProductPickerQuery('');
      setPatientLinkProductPickerOpen(false);
      setPatientLinkDelegatePermissionDraft('submit_for_physician_review');
      setPatientLinkExpiryHoursDraft(DEFAULT_DELEGATE_LINK_EXPIRY_HOURS);
      setPatientLinkPricingDisclosureDraft(DEFAULT_DELEGATE_PRICING_DISCLOSURE);
      setPatientLinkZelleRecipientNameDraft('');
      setPatientLinkPaymentConfirmationRequired(true);
      setPatientLinkResearchNoteDraft('');
      setPatientLinkDelegateInstructionsDraft('');
      setPatientLinkInternalPhysicianNoteDraft('');
      setPatientLinkTermsAccepted(false);
      setCreateLinkDialogOpen(false);
      setCreateLinkDialogMode('select');
      toast.success('Proposal link created.');
      requestPatientLinksRefresh({ force: true });
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to create a proposal link right now.',
      );
    } finally {
      setPatientLinksCreating(false);
    }
  }, [
	    loadPatientLinks,
    delegateLinkCreationEnabled,
	    normalizeMarkupPercent,
    patientLinkDelegateContactDraft,
    patientLinkDelegateInstructionsDraft,
    patientLinkDelegateNameDraft,
    patientLinkDelegatePermissionDraft,
    patientLinkDelegateRoleDraft,
    patientLinkApprovedProductTokens,
    patientLinkCartProductTokens,
    patientLinkExpiryHoursDraft,
    patientLinkInternalPhysicianNoteDraft,
    patientLinkMarkupDraft,
    patientLinkPaymentConfirmationRequired,
    patientLinkReferenceDraft,
    patientLinkPricingDisclosureDraft,
    patientLinkProductScopeDraft,
    patientLinkResearchNoteDraft,
    patientLinkStudyLabelDraft,
    patientLinkSubjectLabelDraft,
    patientLinkTermsAccepted,
    patientLinkZelleRecipientNameDraft,
    patientLinkInstructionsDraft,
    patientLinkPaymentMethodDraft,
    patientLinksCreating,
    localUser?.name,
    localUser?.zelleContact,
    onUserUpdated,
    requestPatientLinksRefresh,
    setLocalUser,
    setCreateLinkDialogOpen,
    setCreateLinkDialogMode,
    showPatientLinksTab,
    user?.name,
    zelleContactDraft,
  ]);

  const handleCreateBrochureLink = useCallback(async () => {
    if (!showPatientLinksTab || patientLinksCreating) {
      return;
    }
    const expiresInHours = Number(patientLinkExpiryHoursDraft);
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
      toast.error('Expiration hours must be greater than zero.');
      return;
    }
    const brochureName = patientLinkBrochureNameDraft.trim();
    if (!brochureName) {
      toast.error('Link name is required.');
      return;
    }
    setPatientLinksCreating(true);
    try {
      const api = await import('../services/api');
      const recipientName = patientLinkRecipientNameDraft.trim();
      const recipientContact = patientLinkRecipientContactDraft.trim();
      const studyLabel = patientLinkStudyLabelDraft.trim();
      const patientReference = patientLinkReferenceDraft.trim();
      const approvedProductTokensForPayload =
        patientLinkProductScopeDraft === 'specific_products'
          ? patientLinkApprovedProductTokens
          : [];
      if (patientLinkProductScopeDraft === 'specific_products' && approvedProductTokensForPayload.length === 0) {
        toast.error('Choose at least one product for this brochure.');
        setPatientLinksCreating(false);
        return;
      }
      await api.delegationAPI.createLink({
        linkType: 'brochure',
        linkName: brochureName ? brochureName : null,
        referenceLabel: brochureName ? brochureName : null,
        brochureName: brochureName ? brochureName : null,
        studyLabel: studyLabel ? studyLabel : null,
        patientReference: patientReference ? patientReference : null,
        recipientName: recipientName ? recipientName : null,
        recipientContact: recipientContact ? recipientContact : null,
        productScope: patientLinkProductScopeDraft,
        productScopeItems: approvedProductTokensForPayload,
        allowedProducts: approvedProductTokensForPayload,
        delegatePermission: 'view_products_only',
        expiresInHours,
      });
      setPatientLinkBrochureNameDraft('');
      setPatientLinkRecipientNameDraft('');
      setPatientLinkRecipientContactDraft('');
      setPatientLinkStudyLabelDraft('');
      setPatientLinkReferenceDraft('');
      setPatientLinkProductScopeDraft('all_physician_approved');
      setPatientLinkApprovedProductIds([]);
      setPatientLinkProductPickerQuery('');
      setPatientLinkProductPickerOpen(false);
      setPatientLinkExpiryHoursDraft(DEFAULT_DELEGATE_LINK_EXPIRY_HOURS);
      setCreateLinkDialogOpen(false);
      setCreateLinkDialogMode('select');
      toast.success('Brochure link created.');
      requestPatientLinksRefresh({ force: true });
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to create a brochure link right now.',
      );
    } finally {
      setPatientLinksCreating(false);
    }
  }, [
    patientLinkApprovedProductTokens,
    patientLinkBrochureNameDraft,
    patientLinkExpiryHoursDraft,
    patientLinkProductScopeDraft,
    patientLinkRecipientContactDraft,
    patientLinkRecipientNameDraft,
    patientLinkReferenceDraft,
    patientLinkStudyLabelDraft,
    patientLinksCreating,
    requestPatientLinksRefresh,
    showPatientLinksTab,
  ]);

  const handleActivateModifiedPatientLink = useCallback(async () => {
    if (!showPatientLinksTab || patientLinksCreating || !patientLinkEditing) {
      return;
    }
    const token = patientLinkEditing.token.trim();
    if (!token) {
      toast.error('Unable to activate this link because the token is missing.');
      return;
    }
    const expiresInHours = Number(patientLinkExpiryHoursDraft);
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
      toast.error('Expiration hours must be greater than zero.');
      return;
    }

    setPatientLinksCreating(true);
    try {
      const api = await import('../services/api');
      let activatedLink: any = null;
      if (patientLinkEditing.linkType === 'brochure') {
        const brochureName = patientLinkBrochureNameDraft.trim();
        if (!brochureName) {
          toast.error('Link name is required.');
          setPatientLinksCreating(false);
          return;
        }
        const studyLabel = patientLinkStudyLabelDraft.trim();
        const patientReference = patientLinkReferenceDraft.trim();
        const recipientName = patientLinkRecipientNameDraft.trim();
        const recipientContact = patientLinkRecipientContactDraft.trim();
        const approvedProductTokensForPayload =
          patientLinkProductScopeDraft === 'specific_products'
            ? (patientLinkApprovedProductTokens.length > 0
              ? patientLinkApprovedProductTokens
              : patientLinkEditing.originalProductTokens)
            : [];
        if (patientLinkProductScopeDraft === 'specific_products' && approvedProductTokensForPayload.length === 0) {
          toast.error('Choose at least one product for this brochure.');
          setPatientLinksCreating(false);
          return;
        }
        const response = await api.delegationAPI.updateLink(token, {
          revoke: false,
          linkName: brochureName,
          referenceLabel: brochureName,
          brochureName,
          studyLabel: studyLabel ? studyLabel : null,
          patientReference: patientReference ? patientReference : null,
          delegateName: recipientName ? recipientName : null,
          delegateContact: recipientContact ? recipientContact : null,
          productScope: patientLinkProductScopeDraft,
          productScopeItems: approvedProductTokensForPayload,
          allowedProducts: approvedProductTokensForPayload,
          delegatePermission: 'view_products_only',
          expiresInHours,
        });
        activatedLink = (response as any)?.link && typeof (response as any).link === 'object'
          ? (response as any).link
          : null;
      } else {
        if (!patientLinkTermsAccepted) {
          toast.error('Accept the terms to continue.');
          setPatientLinksCreating(false);
          return;
        }
        const zelleContact = zelleContactDraft.trim();
        const savedZelleContact =
          typeof localUser?.zelleContact === 'string' ? localUser.zelleContact.trim() : '';
        if (patientLinkPaymentMethodDraft === 'zelle' && zelleContact !== savedZelleContact) {
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
        const linkName = patientLinkSubjectLabelDraft.trim();
        const studyLabel = patientLinkStudyLabelDraft.trim();
        const patientReference = patientLinkReferenceDraft.trim();
        const delegateName = patientLinkDelegateNameDraft.trim();
        const delegateContact = patientLinkDelegateContactDraft.trim();
        const pricingDisclosure = patientLinkPricingDisclosureDraft.trim();
        const zelleRecipientName = patientLinkZelleRecipientNameDraft.trim();
        const delegateInstructions = patientLinkDelegateInstructionsDraft.trim();
        const internalPhysicianNote = patientLinkInternalPhysicianNoteDraft.trim();
        const approvedProductTokensForPayload =
          patientLinkProductScopeDraft === 'specific_cart_only'
            ? patientLinkCartProductTokens
            : patientLinkProductScopeDraft === 'all_physician_approved'
              ? []
              : patientLinkProductScopeDraft === 'specific_products'
                ? (patientLinkApprovedProductTokens.length > 0
                  ? patientLinkApprovedProductTokens
                  : patientLinkEditing.originalProductTokens)
                : [];
        if (patientLinkProductScopeDraft === 'specific_products' && approvedProductTokensForPayload.length === 0) {
          toast.error('Choose at least one product for this proposal.');
          setPatientLinksCreating(false);
          return;
        }
        if (patientLinkProductScopeDraft === 'specific_cart_only' && approvedProductTokensForPayload.length === 0) {
          toast.error('Add at least one cart product for this proposal.');
          setPatientLinksCreating(false);
          return;
        }
        const markupPercent = normalizeMarkupPercent(patientLinkMarkupDraft);
        const paymentMethod = patientLinkPaymentMethodDraft === 'zelle' ? 'zelle' : '';
        const paymentInstructionsDraft = patientLinkInstructionsDraft.trim();
        const paymentInstructions = paymentMethod === 'zelle'
          ? (paymentInstructionsDraft || buildPatientLinkDefaultInstructions('zelle', zelleContact || null, localUser?.name ?? user?.name ?? null))
          : '';
        const response = await api.delegationAPI.updateLink(token, {
          revoke: false,
          linkName: linkName ? linkName : null,
          referenceLabel: linkName ? linkName : null,
          patientId: null,
          subjectLabel: null,
          studyLabel: studyLabel ? studyLabel : null,
          patientReference: patientReference ? patientReference : null,
          delegateName: delegateName ? delegateName : null,
          delegateContact: delegateContact ? delegateContact : null,
          delegateRole: patientLinkDelegateRoleDraft,
          productScope: patientLinkProductScopeDraft,
          productScopeItems: approvedProductTokensForPayload,
          delegatePermission: patientLinkDelegatePermissionDraft,
          markupPercent,
          pricingDisclosure: pricingDisclosure || DEFAULT_DELEGATE_PRICING_DISCLOSURE,
          zelleRecipientName: paymentMethod === 'zelle' && zelleRecipientName ? zelleRecipientName : null,
          paymentConfirmationRequired: paymentMethod === 'zelle' ? patientLinkPaymentConfirmationRequired : false,
          delegateInstructions: delegateInstructions ? delegateInstructions : null,
          internalPhysicianNote: internalPhysicianNote ? internalPhysicianNote : null,
          termsVersion: CURRENT_TERMS_VERSION,
          shippingPolicyVersion: CURRENT_SHIPPING_POLICY_VERSION,
          privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
          instructions: patientLinkResearchNoteDraft.trim() ? patientLinkResearchNoteDraft.trim() : null,
          allowedProducts: approvedProductTokensForPayload,
          expiresInHours,
          paymentMethod,
          paymentInstructions,
        });
        activatedLink = (response as any)?.link && typeof (response as any).link === 'object'
          ? (response as any).link
          : null;
      }

      patientLinksActivatedTokenOverridesRef.current.set(token, Date.now() + 30_000);
      setPatientLinks((prev) => prev.map((link) => {
        const linkToken = readPatientLinkText(link, ['token']);
        if (linkToken !== token) {
          return link;
        }
        return {
          ...link,
          ...(activatedLink || {}),
          token,
          revokedAt: null,
          revoked_at: null,
          status: 'active',
        };
      }));
      setPatientLinkEditing(null);
      setPatientLinkSubjectLabelDraft('');
      setPatientLinkStudyLabelDraft('');
      setPatientLinkReferenceDraft('');
      setPatientLinkDelegateNameDraft('');
      setPatientLinkDelegateContactDraft('');
      setPatientLinkBrochureNameDraft('');
      setPatientLinkRecipientNameDraft('');
      setPatientLinkRecipientContactDraft('');
      setPatientLinkDelegateRoleDraft('patient');
      setPatientLinkProductScopeDraft('all_physician_approved');
      setPatientLinkApprovedProductIds([]);
      setPatientLinkProductPickerQuery('');
      setPatientLinkProductPickerOpen(false);
      setPatientLinkDelegatePermissionDraft('submit_for_physician_review');
      setPatientLinkExpiryHoursDraft(DEFAULT_DELEGATE_LINK_EXPIRY_HOURS);
      setPatientLinkPricingDisclosureDraft(DEFAULT_DELEGATE_PRICING_DISCLOSURE);
      setPatientLinkZelleRecipientNameDraft('');
      setPatientLinkPaymentConfirmationRequired(true);
      setPatientLinkResearchNoteDraft('');
      setPatientLinkDelegateInstructionsDraft('');
      setPatientLinkInternalPhysicianNoteDraft('');
      setPatientLinkTermsAccepted(false);
      setCreateLinkDialogOpen(false);
      setCreateLinkDialogMode('select');
      toast.success('Link activated.');
      requestPatientLinksRefresh({ force: true });
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to activate this link right now.',
      );
    } finally {
      setPatientLinksCreating(false);
    }
  }, [
    localUser,
    normalizeMarkupPercent,
    onUserUpdated,
    patientLinkApprovedProductTokens,
    patientLinkBrochureNameDraft,
    patientLinkCartProductTokens,
    patientLinkDelegateContactDraft,
    patientLinkDelegateInstructionsDraft,
    patientLinkDelegateNameDraft,
    patientLinkDelegatePermissionDraft,
    patientLinkDelegateRoleDraft,
    patientLinkEditing,
    patientLinkExpiryHoursDraft,
    patientLinkInstructionsDraft,
    patientLinkInternalPhysicianNoteDraft,
    patientLinkMarkupDraft,
    patientLinkPaymentConfirmationRequired,
    patientLinkPaymentMethodDraft,
    patientLinkPricingDisclosureDraft,
    patientLinkProductScopeDraft,
    patientLinkRecipientContactDraft,
    patientLinkRecipientNameDraft,
    patientLinkReferenceDraft,
    patientLinkResearchNoteDraft,
    patientLinkStudyLabelDraft,
    patientLinkSubjectLabelDraft,
    patientLinkTermsAccepted,
    patientLinkZelleRecipientNameDraft,
    patientLinksCreating,
    requestPatientLinksRefresh,
    setLocalUser,
    showPatientLinksTab,
    user?.name,
    zelleContactDraft,
  ]);

  const getPatientLinkUrl = useCallback((
    token: string,
    linkType: PatientLinkType = 'delegate',
    linkLabel?: string | null,
  ): string => {
    if (typeof window === 'undefined') return '';
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) return '';
    const slugLabel =
      typeof linkLabel === 'string' && linkLabel.trim()
        ? linkLabel.trim()
        : localUser?.name ?? user?.name ?? null;
    if (linkType === 'brochure') {
      return buildBrochureLinkUrl(window.location.origin, normalized, slugLabel);
    }
    return buildResearchSupplyLinkUrl(window.location.origin, normalized, slugLabel);
  }, [localUser?.name, user?.name]);

  const openLegalDocument = useCallback((key: CreateLinkLegalDocumentKey) => {
    captureCreateLinkDialogScrollPosition();
    setCreateLinkLegalDocumentKey(key);
    restoreCreateLinkDialogScrollPosition();
  }, [captureCreateLinkDialogScrollPosition, restoreCreateLinkDialogScrollPosition]);

  const closeCreateLinkLegalDocument = useCallback((event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setCreateLinkLegalDocumentKey(null);
    restoreCreateLinkDialogScrollPosition();
  }, [restoreCreateLinkDialogScrollPosition]);

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

  const trackPatientLinkUsageEvent = useCallback((
    linkType: PatientLinkType,
    eventSuffix: string,
    metadata?: Record<string, unknown>,
  ) => {
    const normalizedSuffix = typeof eventSuffix === 'string' ? eventSuffix.trim() : '';
    if (!normalizedSuffix) return;
    const normalizedLinkType: PatientLinkType = linkType === 'brochure' ? 'brochure' : 'delegate';
    trackUsageEvent(`${getPatientLinkTrackingPrefix(normalizedLinkType)}_${normalizedSuffix}`, {
      linkType: normalizedLinkType,
      ...(metadata || {}),
    });
  }, [trackUsageEvent]);

  useEffect(() => {
    const delegateOptInStepVisible =
      createLinkDialogOpen && createLinkDialogMode === 'delegate' && !delegateOptInEnabled;

    if (!delegateOptInStepVisible || !patientLinksPanelVisible || !showPatientLinksTab) {
      return;
    }

    let cancelled = false;
    const zeroCounts = Object.fromEntries(DELEGATE_LINK_FUNNEL_STAGES.map((stage) => [stage.event, 0]));

    setDelegateFunnelLoading(true);
    setDelegateFunnelError(null);

    void import('../services/api')
      .then((api) => api.usageTrackingAPI.getFunnel(DELEGATE_LINK_FUNNEL_STAGES.map((stage) => stage.event)))
      .then((result: any) => {
        if (cancelled) return;
        const nextCounts = Object.fromEntries(
          DELEGATE_LINK_FUNNEL_STAGES.map((stage) => {
            const rawCount = Number((result?.counts || {})?.[stage.event]);
            return [stage.event, Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0];
          }),
        );
        setDelegateFunnelCounts(nextCounts);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setDelegateFunnelCounts(zeroCounts);
        setDelegateFunnelError(
          error?.status === 404
            ? 'Usage funnel data is not available on this backend.'
            : 'Unable to load usage funnel right now.',
        );
      })
      .finally(() => {
        if (!cancelled) {
          setDelegateFunnelLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [createLinkDialogMode, createLinkDialogOpen, delegateOptInEnabled, patientLinksPanelVisible, showPatientLinksTab]);

  const trackPatientLinkFieldEntry = useCallback((field: string, value: string, linkType: PatientLinkType = 'delegate') => {
    const normalizedField = typeof field === 'string' ? field.trim() : '';
    const normalizedValue = typeof value === 'string' ? value.trim() : '';
    if (!normalizedField || !normalizedValue) {
      return;
    }
    const normalizedLinkType: PatientLinkType = linkType === 'brochure' ? 'brochure' : 'delegate';
    const trackingKey = `${normalizedLinkType}:${normalizedField}`;
    if (patientLinkTrackedFieldsRef.current.has(trackingKey)) {
      return;
    }
    patientLinkTrackedFieldsRef.current.add(trackingKey);
    trackPatientLinkUsageEvent(normalizedLinkType, 'text_field_entry', { field: normalizedField });
  }, [trackPatientLinkUsageEvent]);

  const handleCopyPatientLink = useCallback(async (
    token: string,
    linkType: PatientLinkType = 'delegate',
    linkLabel?: string | null,
  ) => {
	    const url = getPatientLinkUrl(token, linkType, linkLabel);
	    if (!url) return;
	    try {
	      if (!navigator?.clipboard) {
	        throw new Error('Clipboard API unavailable');
	      }
      const displayLabel =
        typeof linkLabel === 'string' && linkLabel.trim()
          ? linkLabel.trim()
          : linkType === 'brochure'
            ? 'Brochure link'
            : 'Proposal link';
      const escapeClipboardHtml = (value: string) =>
        value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      const ClipboardItemCtor = typeof window !== 'undefined' ? (window as any).ClipboardItem : null;
      if (typeof navigator.clipboard.write === 'function' && typeof ClipboardItemCtor === 'function') {
        await navigator.clipboard.write([
          new ClipboardItemCtor({
            'text/plain': new Blob([url], { type: 'text/plain' }),
            'text/html': new Blob(
              [`<a href="${escapeClipboardHtml(url)}">${escapeClipboardHtml(displayLabel)}</a>`],
              { type: 'text/html' },
            ),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(url);
      }
	      if (linkType !== 'brochure') {
	      trackPatientLinkUsageEvent(linkType, 'copied', { source: 'manage_links' });
	      }
	      toast.success('Link copied.');
    } catch {
      toast.error('Unable to copy link.');
    }
  }, [getPatientLinkUrl, trackPatientLinkUsageEvent]);

  const handleViewPatientLink = useCallback((
    token: string,
    linkType: PatientLinkType = 'delegate',
    linkLabel?: string | null,
  ) => {
    if (typeof window === 'undefined') return;
    const url = getPatientLinkUrl(token, linkType, linkLabel);
    if (!url) return;
    if (linkType !== 'brochure') {
      trackPatientLinkUsageEvent(linkType, 'preview_opened', { source: 'manage_links' });
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [getPatientLinkUrl, trackPatientLinkUsageEvent]);

  const handleRevokePatientLink = useCallback(async (token: string) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized || patientLinksUpdatingToken) {
      return;
    }
    setPatientLinksUpdatingToken(normalized);
    try {
      const api = await import('../services/api');
      await api.delegationAPI.updateLink(normalized, { revoke: true });
      patientLinksActivatedTokenOverridesRef.current.delete(normalized);
      toast.success('Link revoked.');
      requestPatientLinksRefresh({ force: true, preserveScroll: true });
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to revoke link right now.',
      );
    } finally {
      setPatientLinksUpdatingToken(null);
    }
  }, [patientLinksUpdatingToken, requestPatientLinksRefresh]);

  const handleDeletePatientLink = useCallback(async (token: string) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized || patientLinksDeletingToken) {
      return;
    }
    setPatientLinksDeletingToken(normalized);
    try {
      const api = await import('../services/api');
      await api.delegationAPI.updateLink(normalized, { delete: true });
      patientLinksActivatedTokenOverridesRef.current.delete(normalized);
      toast.success('Link deleted.');
      requestPatientLinksRefresh({ force: true, preserveScroll: true });
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to delete link right now.',
      );
    } finally {
      setPatientLinksDeletingToken(null);
    }
  }, [patientLinksDeletingToken, requestPatientLinksRefresh]);

  const handleModifyPatientLink = useCallback(async (token: string, revokeBeforeModify: boolean) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized || patientLinksUpdatingToken) {
      return;
    }
    const targetLink = patientLinks.find((link) => {
      const linkToken = readPatientLinkText(link, ['token']);
      return linkToken === normalized;
    });
    if (!targetLink) {
      toast.error('Unable to find this link to modify.');
      return;
    }
    if (!revokeBeforeModify) {
      openPatientLinkModifyModal(targetLink);
      return;
    }
    setPatientLinksUpdatingToken(normalized);
    try {
      const api = await import('../services/api');
      await api.delegationAPI.updateLink(normalized, { revoke: true });
      patientLinksActivatedTokenOverridesRef.current.delete(normalized);
      setPatientLinks((prev) => prev.map((link) => {
        const linkToken = readPatientLinkText(link, ['token']);
        if (linkToken !== normalized) {
          return link;
        }
        return {
          ...link,
          revokedAt: new Date().toISOString(),
          status: 'revoked',
        };
      }));
      openPatientLinkModifyModal({
        ...(targetLink || {}),
        revokedAt: new Date().toISOString(),
        status: 'revoked',
      });
      toast.success('Link revoked for modification.');
      requestPatientLinksRefresh({ force: true, preserveScroll: true });
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to revoke this link for modification right now.',
      );
    } finally {
      setPatientLinksUpdatingToken(null);
    }
  }, [
    openPatientLinkModifyModal,
    patientLinks,
    patientLinksUpdatingToken,
    requestPatientLinksRefresh,
  ]);

  const handleRequestPatientLinkConfirmAction = useCallback((
    action: PatientLinkConfirmAction['action'],
    token: string,
    label: string,
    linkType: PatientLinkType,
  ) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) return;
    const displayLabel = typeof label === 'string' && label.trim()
      ? label.trim()
      : `${getPatientLinkTypeLabel(linkType)} link`;
    setPatientLinkConfirmAction({
      action,
      token: normalized,
      label: displayLabel,
      linkType,
    });
  }, []);

  const patientLinkConfirmBusy = Boolean(
    patientLinkConfirmAction
      && (patientLinkConfirmAction.action === 'delete'
        ? patientLinksDeletingToken === patientLinkConfirmAction.token
        : patientLinksUpdatingToken === patientLinkConfirmAction.token),
  );

  const handlePatientLinkConfirmOpenChange = useCallback((open: boolean) => {
    if (open || patientLinkConfirmBusy) return;
    setPatientLinkConfirmAction(null);
  }, [patientLinkConfirmBusy]);

  const handleConfirmPatientLinkAction = useCallback(async () => {
    if (!patientLinkConfirmAction || patientLinkConfirmBusy) return;
    const pending = patientLinkConfirmAction;
    if (pending.action === 'delete') {
      await handleDeletePatientLink(pending.token);
    } else if (pending.action === 'modify') {
      await handleModifyPatientLink(pending.token, true);
    } else {
      await handleRevokePatientLink(pending.token);
    }
    setPatientLinkConfirmAction(null);
  }, [
    handleDeletePatientLink,
    handleModifyPatientLink,
    handleRevokePatientLink,
    patientLinkConfirmAction,
    patientLinkConfirmBusy,
  ]);

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
        capturePatientLinksScrollPosition();
        setPatientLinks((prev) => {
          if (!Array.isArray(prev)) {
            return prev;
          }
          return prev.map((link) => {
            const linkToken = typeof link?.token === 'string' ? link.token.trim() : '';
            if (linkToken !== normalized) {
              return link;
            }
            return {
              ...link,
              receivedPayment: received,
              received_payment: received ? 1 : 0,
              paymentReceived: received,
            };
          });
        });
        restorePatientLinksScrollPosition();
        toast.success(received ? 'Marked as paid.' : 'Marked as unpaid.');
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
    [capturePatientLinksScrollPosition, patientLinksPaymentReceivedToken, restorePatientLinksScrollPosition],
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
        requestPatientLinksRefresh({ force: true, preserveScroll: true });
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
    [patientLinksProposalToken, requestPatientLinksRefresh],
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
        requestPatientLinksRefresh({ force: true, preserveScroll: true });
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
    [patientLinkReviewNotesDraftByToken, patientLinksSavingReviewNotesToken, requestPatientLinksRefresh],
  );

  const saveProfileField = useCallback(
    async (label: string, payload: Record<string, string | boolean | null>) => {
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
        const isMaintenanceReadOnlyError =
          error?.code === 'SHADOW_READ_ONLY'
          || (
            typeof error?.message === 'string'
            && error.message.trim().toLowerCase() === 'maintenance mode is read-only'
          );
        if (isMaintenanceReadOnlyError) {
          toast.error('Unable to update in maintenance mode', { id: toastId });
        } else if (error?.status === 413) {
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

  const handlePatientLinkUpdateEmailToggle = useCallback(
    async (checked: boolean) => {
      if (patientLinkUpdateEmailSaving) {
        return;
      }
      setPatientLinkUpdateEmailSaving(true);
      try {
        await saveProfileField('Patient link update emails', {
          receivePatientLinkUpdateEmails: checked,
        });
      } finally {
        setPatientLinkUpdateEmailSaving(false);
      }
    },
    [patientLinkUpdateEmailSaving, saveProfileField],
  );

  const handleAccountResellerPermitUpload = useCallback(
    async (file: File | null) => {
      if (!file || resellerPermitUploading || resellerPermitDeleting) {
        return;
      }

      const maxBytes = 25 * 1024 * 1024;
      if (file.size > maxBytes) {
        toast.error('Upload too large. Please choose a file 25MB or smaller.');
        if (resellerPermitInputRef.current) {
          resellerPermitInputRef.current.value = '';
        }
        return;
      }

      setResellerPermitUploading(true);
      try {
        const api = await import('../services/api');
        const updated = await api.authAPI.uploadResellerPermit(file);
        const nextUserState: HeaderUser = {
          ...(localUser || {}),
          ...(updated || {}),
          resellerPermitOnboardingPresented: true,
        };
        setLocalUser(nextUserState);
        onUserUpdated?.(nextUserState);
        toast.success('Reseller permit uploaded.');
      } catch (error: any) {
        const message =
          typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : 'Unable to upload your reseller permit right now.';
        toast.error(message);
      } finally {
        setResellerPermitUploading(false);
        if (resellerPermitInputRef.current) {
          resellerPermitInputRef.current.value = '';
        }
      }
    },
    [localUser, onUserUpdated, resellerPermitDeleting, resellerPermitUploading],
  );

  const handleAccountResellerPermitDelete = useCallback(
    async () => {
      if (resellerPermitUploading || resellerPermitDeleting || !hasUploadedResellerPermit(localUser)) {
        return;
      }
      if (!window.confirm('Delete this reseller permit file?')) {
        return;
      }

      setResellerPermitDeleting(true);
      try {
        const api = await import('../services/api');
        const updated = await api.authAPI.deleteResellerPermit();
        const nextUserState: HeaderUser = {
          ...(localUser || {}),
          ...(updated || {}),
          resellerPermitFilePath: null,
          resellerPermitFileName: null,
          resellerPermitUploadedAt: null,
          resellerPermitOnboardingPresented: true,
        };
        setLocalUser(nextUserState);
        onUserUpdated?.(nextUserState);
        toast.success('Reseller permit deleted.');
      } catch (error: any) {
        const message =
          typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : 'Unable to delete your reseller permit right now.';
        toast.error(message);
      } finally {
        setResellerPermitDeleting(false);
        if (resellerPermitInputRef.current) {
          resellerPermitInputRef.current.value = '';
        }
      }
    },
    [localUser, onUserUpdated, resellerPermitDeleting, resellerPermitUploading],
  );

  const delegateLogoInputRef = useRef<HTMLInputElement | null>(null);
  const delegateBackgroundImageInputRef = useRef<HTMLInputElement | null>(null);
  const [delegateLogoUploading, setDelegateLogoUploading] = useState(false);
  const [delegateSecondaryColorSaving, setDelegateSecondaryColorSaving] = useState(false);
  const [delegateBackgroundImageUploading, setDelegateBackgroundImageUploading] = useState(false);
  const [delegateBackgroundColorSaving, setDelegateBackgroundColorSaving] = useState(false);
  const [delegateOptInSaving, setDelegateOptInSaving] = useState(false);
  const [delegateFunnelLoading, setDelegateFunnelLoading] = useState(false);
  const [delegateFunnelError, setDelegateFunnelError] = useState<string | null>(null);
  const [delegateFunnelCounts, setDelegateFunnelCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(DELEGATE_LINK_FUNNEL_STAGES.map((stage) => [stage.event, 0])),
  );

  const downscaleImageDataUrl = useCallback(async (
    dataUrl: string,
    maxWidthPx: number,
    maxHeightPx: number,
    options?: {
      forceRender?: boolean;
      outputMime?: 'image/jpeg' | 'image/png';
      quality?: number;
      fillColor?: string | null;
    },
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

    if (dstW === srcW && dstH === srcH && !options?.forceRender) {
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
    if (options?.fillColor) {
      ctx.fillStyle = options.fillColor;
      ctx.fillRect(0, 0, dstW, dstH);
    }
    ctx.drawImage(img, 0, 0, dstW, dstH);

    const outputMime = options?.outputMime || (dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg');
    return canvas.toDataURL(outputMime, outputMime === 'image/jpeg' ? (options?.quality ?? 0.85) : undefined);
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

  const handleSelectDelegateBackgroundImage = useCallback(async (file: File | null) => {
    if (!file || delegateBackgroundImageUploading) {
      return;
    }
    const maxBytes = 5_000_000;
    if (file.size > maxBytes) {
      toast.error('Image is too large. Please choose a smaller file.');
      return;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      toast.error('Please choose an image file.');
      return;
    }
    setDelegateBackgroundImageUploading(true);
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
        const resp = await moderationAPI.checkImage({ dataUrl, purpose: 'delegate_background' });
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
      const preserveTransparency = /^data:image\/png(?:;|,)/i.test(dataUrl) || file.type === 'image/png';
      const backgroundResizeOptions = {
        forceRender: true,
        outputMime: preserveTransparency ? 'image/png' : 'image/jpeg',
        quality: 0.82,
        fillColor: preserveTransparency ? null : '#ffffff',
      } as const;
      let resized = await downscaleImageDataUrl(dataUrl, 1800, 1200, backgroundResizeOptions);
      if (preserveTransparency && resized.length > 2_400_000) {
        const fallbackSizes: Array<[number, number]> = [
          [1400, 933],
          [1100, 733],
          [900, 600],
        ];
        for (const [width, height] of fallbackSizes) {
          if (resized.length <= 2_400_000) {
            break;
          }
          resized = await downscaleImageDataUrl(dataUrl, width, height, backgroundResizeOptions);
        }
      }
      await saveProfileField('Delegate session background', {
        delegateBackgroundImageUrl: resized,
      });
    } catch {
      // saveProfileField handles toasts
    } finally {
      setDelegateBackgroundImageUploading(false);
      if (delegateBackgroundImageInputRef.current) {
        delegateBackgroundImageInputRef.current.value = '';
      }
    }
  }, [delegateBackgroundImageUploading, downscaleImageDataUrl, saveProfileField]);

  const handleRemoveDelegateBackgroundImage = useCallback(async () => {
    if (delegateBackgroundImageUploading) return;
    setDelegateBackgroundImageUploading(true);
    try {
      await saveProfileField('Delegate session background', {
        delegateBackgroundImageUrl: null,
      });
    } catch {
      // saveProfileField handles toasts
    } finally {
      setDelegateBackgroundImageUploading(false);
    }
  }, [delegateBackgroundImageUploading, saveProfileField]);

  const handleDelegateBackgroundColorChange = useCallback(async (value: string) => {
    const normalized = normalizeDelegateBackgroundColor(value) || DEFAULT_DELEGATE_BACKGROUND_COLOR;
    const current = normalizeDelegateBackgroundColor(localUser?.delegateBackgroundColor ?? null) || DEFAULT_DELEGATE_BACKGROUND_COLOR;
    if (delegateBackgroundColorSaving || normalized === current) {
      return;
    }
    setDelegateBackgroundColorSaving(true);
    try {
      await saveProfileField('Delegate session background color', { delegateBackgroundColor: normalized });
    } catch {
      // saveProfileField handles toasts
    } finally {
      setDelegateBackgroundColorSaving(false);
    }
  }, [delegateBackgroundColorSaving, localUser?.delegateBackgroundColor, saveProfileField]);

  useEffect(() => {
    if (!showPatientLinksTab && accountTab === 'patient_links') {
      setAccountTab('details');
    }
  }, [accountTab, showPatientLinksTab]);

  const identityFields: Array<{ key: 'name' | 'email' | 'phone' | 'websiteUrl'; label: string; type?: string; autoComplete?: string }> = [
    { key: 'name', label: 'Full Name', autoComplete: 'name' },
    { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
    { key: 'phone', label: 'Phone', autoComplete: 'tel' },
    { key: 'websiteUrl', label: 'Practice Website or LinkedIn', type: 'url', autoComplete: 'url' },
  ];

  const directShippingFields: Array<{ key: DirectShippingField; label: string; type?: string; autoComplete?: string }> = [
    { key: 'officeAddressLine1', label: 'Street', autoComplete: 'shipping address-line1' },
    { key: 'officeAddressLine2', label: 'Suite / Unit', autoComplete: 'shipping address-line2' },
    { key: 'officeCity', label: 'City', autoComplete: 'shipping address-level2' },
    { key: 'officeState', label: 'State', autoComplete: 'shipping address-level1' },
    { key: 'officePostalCode', label: 'Postal Code', autoComplete: 'shipping postal-code' },
  ];
  const accountResellerPermitFileName =
    typeof localUser?.resellerPermitFileName === 'string'
      ? localUser.resellerPermitFileName.trim()
      : '';
  const accountResellerPermitFilePath =
    typeof localUser?.resellerPermitFilePath === 'string'
      ? localUser.resellerPermitFilePath.trim()
      : '';
  const accountHasResellerPermitFile = hasUploadedResellerPermit(localUser);
  const accountResellerPermitDisplayName =
    accountResellerPermitFileName
    || accountResellerPermitFilePath.split('/').pop()
    || 'reseller_permit';
  const resellerPermitBusy =
    resellerPermitUploading || resellerPermitDownloading || resellerPermitDeleting;
  const accountResellerPermitUploadedLabel = useMemo(() => {
    const raw = typeof localUser?.resellerPermitUploadedAt === 'string'
      ? localUser.resellerPermitUploadedAt.trim()
      : '';
    if (!raw) {
      return '';
    }
    const parsed = parseBackendTimestamp(raw);
    if (!parsed) {
      return '';
    }
    return parsed.toLocaleDateString();
  }, [localUser?.resellerPermitUploadedAt]);
  const handleAccountResellerPermitDownload = useCallback(
    async () => {
      if (!accountHasResellerPermitFile || resellerPermitBusy) {
        return;
      }

      setResellerPermitDownloading(true);
      try {
        const api = await import('../services/api');
        const result = await api.authAPI.downloadResellerPermit();
        const objectUrl = URL.createObjectURL(result.blob);
        const opened = window.open(objectUrl, '_blank', 'noopener,noreferrer');
        if (!opened) {
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = result.filename || accountResellerPermitDisplayName || 'reseller_permit';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } catch (error: any) {
        const message =
          typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : 'Unable to download your reseller permit right now.';
        toast.error(message);
      } finally {
        setResellerPermitDownloading(false);
      }
    },
    [accountHasResellerPermitFile, accountResellerPermitDisplayName, resellerPermitBusy],
  );

  const resellerPermitUploadPanel = accountCanUploadResellerPermit ? (
    <div className="reseller-permit-settings-card glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-3">
      <div>
        <h3 className="text-base font-semibold text-slate-800">Reseller Permit</h3>
        <p className="text-sm text-slate-600">
          Upload an applicable reseller permit for tax exemption.
        </p>
      </div>

      <div className="space-y-3">
        <Input
          ref={resellerPermitInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif"
          className="hidden"
          disabled={resellerPermitBusy}
          onChange={(event) => {
            void handleAccountResellerPermitUpload(event.target.files?.[0] || null);
          }}
        />
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-slate-700">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              {accountHasResellerPermitFile ? (
                <button
                  type="button"
                  className="block w-full min-w-0 whitespace-normal text-left [overflow-wrap:anywhere] [text-align:left] transition-colors hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                  style={{ textAlign: 'left' }}
                  disabled={resellerPermitBusy}
                  aria-label="Download uploaded reseller permit"
                  title="Download uploaded reseller permit"
                  onClick={() => {
                    void handleAccountResellerPermitDownload();
                  }}
                >
                  <span className="font-medium text-slate-900">On file:</span>{' '}
                  <span className="reseller-permit-file-name underline decoration-dotted underline-offset-2">
                    {accountResellerPermitDisplayName}
                  </span>
                  <ArrowDownTrayIcon className="ml-1 inline h-4 w-4 shrink-0 align-[-2px] text-slate-700" aria-hidden="true" />
                  {accountResellerPermitUploadedLabel
                    ? ` Uploaded ${accountResellerPermitUploadedLabel}`
                    : ''}
                </button>
              ) : (
                <span className="block text-slate-500">No reseller permit on file.</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="header-home-button squircle-sm bg-white text-slate-900"
                disabled={resellerPermitBusy}
                onClick={() => resellerPermitInputRef.current?.click()}
              >
                Choose file
              </Button>
              {accountHasResellerPermitFile && (
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-transparent text-black transition-colors hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={resellerPermitBusy}
                  aria-label="Delete uploaded reseller permit"
                  title="Delete uploaded permit"
                  onClick={() => {
                    void handleAccountResellerPermitDelete();
                  }}
                >
                  <TrashIcon className="h-4 w-4 text-black" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Accepted file types: PDF, PNG, JPG, WEBP, HEIC, GIF. Maximum 25MB.
          </p>
        </div>
        {resellerPermitUploading && (
          <p className="text-sm text-slate-600">Uploading reseller permit…</p>
        )}
        {resellerPermitDownloading && (
          <p className="text-sm text-slate-600">Downloading reseller permit…</p>
        )}
        {resellerPermitDeleting && (
          <p className="text-sm text-slate-600">Deleting reseller permit…</p>
        )}
      </div>
    </div>
  ) : null;

  const receivePatientLinkUpdateEmails = localUser?.receivePatientLinkUpdateEmails !== false;

  const physicianDashboardSettingsPanel = accountIsDoctor ? (
    <div className="physician-dashboard-settings-panel space-y-4">
      <div className="glass-card squircle-md border border-[var(--brand-glass-border-2)] bg-white/80 p-4">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="physician-patient-link-update-emails"
            checked={receivePatientLinkUpdateEmails}
            disabled={patientLinkUpdateEmailSaving}
            onChange={(event) => {
              void handlePatientLinkUpdateEmailToggle(event.target.checked);
            }}
            className="brand-checkbox mt-0.5"
          />
          <Label
            htmlFor="physician-patient-link-update-emails"
            className="min-w-0 cursor-pointer text-sm leading-5 text-slate-700"
          >
            <span className="block font-semibold text-slate-900">
              Receive patient link update emails
            </span>
            <span className="block text-xs text-slate-500">
              {patientLinkUpdateEmailSaving
                ? 'Saving preference...'
                : receivePatientLinkUpdateEmails
                  ? 'Enabled'
                  : 'Disabled'}
            </span>
          </Label>
        </div>
      </div>
      {resellerPermitUploadPanel}
    </div>
  ) : (
    <div className="physician-dashboard-settings-empty" aria-label="Settings" />
  );

  const physicianThreePlRepresentativeEmail =
    String(localUser?.salesRep?.email || '').trim();
  const canSeePhysicianThreePlTab =
    normalizeRole(localUser?.role ?? user?.role) === 'test_doctor' ||
    physicianThreePlEnabled === true;
  const physicianThreePlPanel = (
    <div className="physician-dashboard-3pl-panel glass-card squircle-md border border-[var(--brand-glass-border-2)] bg-white/80 p-4 text-sm text-slate-700">
      Please contact your representative
      {physicianThreePlRepresentativeEmail ? (
        <>
          {' '}
          at{' '}
          <a
            href={`mailto:${physicianThreePlRepresentativeEmail}`}
            className="font-semibold text-[rgb(11,6,121)] hover:underline"
          >
            {physicianThreePlRepresentativeEmail}
          </a>
        </>
      ) : (
        '.'
      )}
    </div>
  );

  const accountInfoPanel = localUser ? (
    <div className="space-y-4">
      {accountIsDoctor ? (
        <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-3">
          <DoctorProfileForm
            user={localUser}
            title="Physician Profile"
            description="Manage the profile used for your research platform account."
            bioSectionClassName="mt-2"
            submitLabel="Save profile"
            submittingLabel="Saving profile…"
            onNetworkPresenceAgreementChange={async (networkPresenceAgreement) => {
              await saveProfileField('Physician network visibility', {
                networkPresenceAgreement,
              });
            }}
            onSubmit={async (payload) => {
              await saveProfileField('Physician profile', payload);
            }}
          />
        </div>
      ) : (
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
                  const maxBytes = 50 * 1024 * 1024;
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
                    className="header-home-button squircle-sm bg-white text-slate-900 text-xs"
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
      )}

      <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">
            {accountIsDoctor ? 'Contact & Shipping' : 'Direct Shipping'}
          </h3>
          <p className="text-sm text-slate-600">
            {accountIsDoctor
              ? 'Update your phone number and the address where orders should ship.'
              : 'Update the address where orders should ship.'}
          </p>
        </div>

        <div className="grid gap-3">
          {accountIsDoctor && (
            <EditableRow
              label="Phone"
              value={(localUser?.phone as string | null) || ''}
              autoComplete="tel"
              onSave={async (next) => {
                await saveProfileField('Phone', { phone: next });
              }}
            />
          )}
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

      {!accountIsDoctor && resellerPermitUploadPanel}

	      <div className="pt-1">
	        <button
	          type="button"
	          onClick={() => setDeleteAccountModalOpen(true)}
	          className="text-sm font-medium !text-[rgb(11,6,121)] transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.35)] focus-visible:ring-offset-2"
	          style={{ color: 'rgb(11, 6, 121)', marginLeft: '16px' }}
	        >
	          Need to delete your account?
	        </button>
	      </div>
    </div>
  ) : null;

  const effectiveRole = localUser?.role || user?.role || null;
  const canSubmitResearchToolRequest = isDoctorRole(effectiveRole) || isAdmin(effectiveRole);
  const researchDevelopmentCopy = "This section is currently in development. Soon you'll be able to access research tools and resources here to share your findings securely and anonymously with the TrufusionLabs network of physicians. We work for you. Think of us as a dedicated workflow development team.";
  const researchToolRequestCta = canSubmitResearchToolRequest ? (
    <div className="mx-auto mt-1 flex w-full max-w-xl flex-col items-center gap-3">
      <button
        type="button"
        className="inline-flex h-auto min-h-8 max-w-full items-center justify-center gap-2 whitespace-normal squircle-sm px-4 py-2 text-center leading-snug text-white shadow-lg shadow-[rgba(11,6,121,0.18)] transition duration-200 hover:-translate-y-0.5 hover:shadow-xl focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.35)]"
        style={{ backgroundColor: 'rgb(11, 6, 121)' }}
        onClick={handleResearchToolRequestClick}
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
        <span>Have a tool request? We are listening</span>
      </button>
      {researchToolRequestExpanded ? (
        <form className="w-full space-y-3 text-left" onSubmit={handleResearchToolRequestSubmit}>
          <label className="sr-only" htmlFor="research-tool-request-inline">
            Tool request
          </label>
          <Textarea
            ref={researchToolRequestFieldRef}
            id="research-tool-request-inline"
            value={researchToolRequestReport}
            onChange={(event) => {
              setResearchToolRequestReport(event.target.value);
              if (researchToolRequestError) setResearchToolRequestError('');
              if (researchToolRequestSuccess) setResearchToolRequestSuccess('');
            }}
            rows={4}
            placeholder="Tell us what workflow or research tool would help you."
            className="research-tool-request-field min-h-[7rem] resize-y border-2 bg-white text-sm text-slate-800 shadow-inner placeholder:text-slate-400 focus:ring-slate-200"
            disabled={researchToolRequestSubmitting}
          />
          {researchToolRequestError ? (
            <p className="text-xs font-medium text-red-600">{researchToolRequestError}</p>
          ) : null}
          <div className="flex justify-center sm:justify-end">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="header-home-button squircle-sm bg-white text-slate-900"
              disabled={researchToolRequestSubmitting}
            >
              {researchToolRequestSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Submitting...
                </span>
              ) : (
                'Submit request'
              )}
            </Button>
          </div>
        </form>
      ) : researchToolRequestSuccess ? (
        <p className="text-center text-xs font-medium text-emerald-700">
          {researchToolRequestSuccess}
        </p>
      ) : null}
    </div>
  ) : null;

  const researchPlaceholderPanel = (
    <div
      ref={researchPanelRef}
      className="glass-card squircle-md p-6 border border-[var(--brand-glass-border-2)] text-center space-y-3 bg-white"
    >
      <h3 className="text-base font-semibold text-slate-800">Research</h3>
      <p className="text-sm text-slate-600">
        {researchDevelopmentCopy}
      </p>
      {researchToolRequestCta}
    </div>
  );

  const researchWipPanel = (
    <div
      ref={researchPanelRef}
      className="space-y-4 bg-white"
      >
      <div className="glass-card squircle-md p-6 border border-[var(--brand-glass-border-2)] text-center space-y-3 bg-white">
        <h3 className="text-base font-semibold text-slate-800">Research</h3>
        <p className="text-sm text-slate-600">
          {researchDevelopmentCopy}
        </p>
        {researchToolRequestCta}
      </div>
    </div>
  );

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
    const isDraftLabel =
      normalized === 'draft'
      || normalized === 'delegate draft'
      || normalized === 'delegate proposal'
      || normalized === 'proposal'
      || normalized === 'pending delegate'
      || normalized === 'delegate pending';
    if (isDraftLabel) return '';
    const isGenericLabel =
      normalized === 'label'
      || normalized === 'delegate'
      || normalized === 'delegate order';
    if (isGenericLabel) return 'Delegate proposal';

    const delegatePrefix = trimmed.match(/^delegate\s*:\s*(.+)$/i);
    if (delegatePrefix && delegatePrefix[1]?.trim()) {
      return `Proposal: ${delegatePrefix[1].trim()}`;
    }

    const delegateOf = trimmed.match(/^delegate\s+of\s+(.+)$/i);
    if (delegateOf && delegateOf[1]?.trim()) {
      return `Proposal: ${delegateOf[1].trim()}`;
    }

    return `Proposal: ${trimmed}`;
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
        withLegacyMetaKeys(keys).map((key) => String(key || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')),
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
        'trufusion_delegate_proposal_token',
      ]),
      readMetaValue(wooPayload?.meta_data, [
        'delegate_proposal_token',
        'proposal_token',
        'delegation_token',
        'trufusion_delegate_proposal_token',
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
    if (accountIsDoctor) {
      setPhysicianDashboardTab('links');
    } else {
      setAccountTab('patient_links');
    }
    setPendingPatientLinkScrollTarget(target);
    requestPatientLinksRefresh({ force: true });
  }, [accountIsDoctor, buildOrderToPatientLinkTarget, requestPatientLinksRefresh, showPatientLinksTab]);
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
    if (!patientLinksPanelVisible || !pendingPatientLinkScrollTarget) {
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
    findMatchingPatientLinkToken,
    patientLinks,
    patientLinksLoading,
    patientLinksPanelVisible,
    pendingPatientLinkScrollTarget,
  ]);

		  const renderOrdersList = () => {
		    const repView = false;
		    const doctorView = Boolean(isDoctorRole(accountRole));
		    const salesRepEmail = (localUser?.salesRep?.email || '').trim();
        const normalizedQuery = ordersSearchQuery.trim().toLowerCase();
        const renderOrdersStatusState = ({
          title,
          subtitle,
          loading = false,
        }: {
          title: string;
          subtitle?: string;
          loading?: boolean;
        }) => {
          const subtitleText = subtitle || (loading ? "Your recent orders will appear here" : "");
          return (
            <div className="text-center py-12" aria-live="polite" aria-busy={loading}>
              <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] inline-block">
                <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
                <p className="text-sm font-medium text-slate-700 mb-1">{title}</p>
                {subtitleText ? (
                  <p className={clsx("text-xs text-slate-500", !subtitle && "invisible")} aria-hidden={!subtitle}>
                    {subtitleText}
                  </p>
                ) : null}
              </div>
            </div>
          );
        };
		    const visibleOrders = cachedAccountOrders
	      .filter((order) => {
        const source = (order.source || '').toLowerCase();
        const hasWooIntegration = Boolean(
          (order.integrationDetails as any)?.wooCommerce ||
          (order.integrationDetails as any)?.woocommerce,
        );
        return source === 'woocommerce' || source === 'trufusion' || source === 'local' || hasWooIntegration;
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
      return renderOrdersStatusState({ title: "Loading your orders...", loading: true });
    }

    if (!visibleOrders.length) {
      return renderOrdersStatusState({
        title: "No orders found",
        subtitle: "Your recent orders will appear here",
      });
    }

	    return (
	      <div className="space-y-4 pb-4">
		      {visibleOrders.map((order) => {
		        const status = describeOrderStatus(order);
		        const trackingNumber = resolveTrackingNumber(order);
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
            const showDelegateOrderJumpButton = showDelegateOrderLabel && showPatientLinksTab;
	            const wooShippingLine =
	              (wooResponse?.shipping_lines && wooResponse.shipping_lines[0]) ||
	              (wooPayload?.shipping_lines && wooPayload.shipping_lines[0]);
	            const wooService = wooShippingLine?.method_title || wooShippingLine?.method_id || '';
	            const trackingCarrierCode =
	              normalizeStringField((order.shippingEstimate as any)?.carrierId) ||
	              normalizeStringField((order.shippingEstimate as any)?.carrier_id) ||
	              normalizeStringField((order.shippingEstimate as any)?.carrierCode) ||
	              normalizeStringField((order.shippingEstimate as any)?.carrier_code) ||
	              normalizeStringField(integrationDetails?.shipStation?.carrierCode) ||
	              normalizeStringField(integrationDetails?.shipStation?.carrier_code) ||
	              normalizeStringField(integrationDetails?.shipstation?.carrierCode) ||
	              normalizeStringField(integrationDetails?.shipstation?.carrier_code) ||
	              (wooService.toLowerCase().includes('ups') ? 'ups' : null);
	            const trackingHref = trackingNumber ? buildTrackingUrl(trackingNumber, trackingCarrierCode) : null;
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
              const normalizedKeys = withLegacyMetaKeys(key).map((entry) => String(entry).trim().toLowerCase());
              const match = Array.isArray(wooMeta)
                ? wooMeta.find((entry: any) => normalizedKeys.includes(String(entry?.key || '').trim().toLowerCase()))
                : null;
              return match?.value ?? null;
            };
            const discountCodeAmountFromWoo = findWooMetaValue('trufusion_discount_code_amount');
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
            const orderRecipientDisplayName =
              order.doctorName ||
              "Physician";
            
          return (
            <div
              key={`${order.source}-${order.id}`}
              className={clsx(
                "account-order-card squircle-lg bg-white border overflow-hidden",
                doctorView && "physician-dashboard-order-card",
              )}
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
	                        <span>{status}</span>
	                        {trackingNumber ? (
	                          <>
	                            <span aria-hidden="true">-</span>
	                            {trackingHref ? (
	                              <a
	                                href={trackingHref}
	                                target="_blank"
	                                rel="noreferrer"
	                                className="text-[rgb(11,6,121)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.25)]"
	                              >
	                                {trackingNumber}
	                              </a>
	                            ) : (
	                              <span>{trackingNumber}</span>
	                            )}
	                          </>
	                        ) : null}
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
                              className="text-[rgb(11,6,121)] font-semibold hover:underline"
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
                        className="text-[rgb(11,6,121)] font-semibold hover:underline"
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
		                        <p className="text-base font-bold text-slate-900 break-words flex flex-wrap items-center gap-2">
		                          <span>{orderNumberLabel}</span>
                              {showDelegateOrderLabel && (
                                showDelegateOrderJumpButton ? (
                                  <Badge
                                    asChild
                                    variant="secondary"
                                    className="uppercase cursor-pointer hover:opacity-90"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleDelegateLabelNavigateToPatientLink(order as any)}
                                      title={delegateOrderLabel || "Open associated delegate link"}
                                    >
                                      Delegate Proposal
                                    </button>
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="secondary"
                                    className="uppercase"
                                    title={delegateOrderLabel || undefined}
                                  >
                                    Delegate Proposal
                                  </Badge>
                                )
                              )}
		                          {showItemCount && (
		                            <span className="text-slate-700 font-semibold">
		                              {itemLabel}
		                            </span>
		                          )}
		                        </p>
                          {repView && (order.doctorName || order.doctorEmail) && (
                            <p className="text-sm text-slate-700 break-words">
                              <span className="font-semibold">
                                {orderRecipientDisplayName}
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
			                              className="order-line-item flex items-center gap-3 min-h-[48px]"
			                            >
	                              <div
	                                className="order-line-thumbnail rounded-lg border border-[#d5d9d9] bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0"
	                              >
	                                {lineImage ? (
	                                  <img
	                                    src={lineImage}
	                                    alt={line.name || 'Item thumbnail'}
	                                    className="order-line-thumbnail__img"
	                                    onError={(event) => {
	                                      event.currentTarget.style.display = 'none';
	                                    }}
	                                  />
                                ) : (
                                  <Package className="h-5 w-5 text-black" />
                                )}
                              </div>
                              <div className="flex-1 space-y-1">
                                <p className="text-[rgb(11,6,121)] font-semibold leading-snug">
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
	                      className={clsx(
                          "header-home-button squircle-sm bg-white text-slate-900 px-6 justify-center font-semibold gap-2 w-full lg:w-full",
                          !repView && "order-buy-again-button",
                        )}
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
	                    className="underline hover:text-[rgb(11,6,121)]"
	                  >
	                    {salesRepEmail}
	                  </a>
	                </p>
	              )}
	              <p>
	                Support:{' '}
	                <a
	                  href="mailto:support@trufusionlabs.com"
	                  className="underline hover:text-[rgb(11,6,121)]"
	                >
	                  support@trufusionlabs.com
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
    const normalizedStatus = String(selectedOrder.status || '').trim().toLowerCase();
    const expectedShipmentWindow =
      selectedOrderStickyEstimateWindow ||
      resolveExpectedShipmentWindow(selectedOrder) ||
      getRememberedSelectedOrderEstimateWindow(selectedOrder);
    const shippingMethod =
      formatShippingMethod(selectedOrder.shippingEstimate) ||
      titleCase(wooShippingLine?.method_title || wooShippingLine?.method_id);
    const shippingRate =
      selectedOrder.shippingEstimate?.rate ??
      (wooShippingLine && typeof wooShippingLine.total === 'string' ? Number(wooShippingLine.total) : undefined);

    const wooShippingAddress = convertWooAddress(wooResponse?.shipping || wooPayload?.shipping);
    const wooBillingAddress = convertWooAddress(wooResponse?.billing || wooPayload?.billing);
    const trackingNumber = resolveTrackingNumber(selectedOrder);
    const shippedAtLabel = formatOrderShippedAtForLocalDisplay(selectedOrder);
    const deliveredAtLabel = formatDeliveryDateLabel(resolveOrderDeliveredAt(selectedOrder));
    const trackingStatusLine = buildTrackingStatusLine(selectedOrder);
    const isFacilityPickupOrder = isSalesOrderFacilityPickup(selectedOrder);
    const isHandDeliveredOrder = isSalesOrderHandDelivered(selectedOrder);
    const estimateRangeLabel =
      normalizeEstimateDisplayLabel(expectedShipmentWindow) ||
      normalizeEstimateDisplayLabel(expectedDelivery) ||
      '';
    const deliverySummaryLabel =
      isFacilityPickupOrder
        ? 'Facility Pickup'
        : isHandDeliveredOrder
          ? 'Hand delivery'
          : deliveredAtLabel
            ? `Delivered on ${deliveredAtLabel}`
            : estimateRangeLabel
              ? estimateRangeLabel
              : shippedAtLabel
                ? `Shipped ${shippedAtLabel}`
                : null;
    const showEstimateDetails = Boolean(
      estimateRangeLabel &&
      !trackingNumber &&
      !deliveredAtLabel &&
      !isFacilityPickupOrder &&
      !isHandDeliveredOrder,
    );
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
    const facilityPickupRecipientName =
      resolveFacilityPickupRecipientNameFromOrder(selectedOrder as any);
    const shippingRecipientName = typeof shippingAddress?.name === 'string'
      ? shippingAddress.name.trim()
      : '';
    const shippingAddressForDisplay = isFacilityPickupOrder
      ? withFacilityPickupRecipientName(shippingAddress, {
          preferredName: facilityPickupRecipientName,
          billingAddress: billingAddressBase,
          fallbackName:
            (typeof (selectedOrder as any)?.doctorName === 'string' && (selectedOrder as any).doctorName.trim())
              ? String((selectedOrder as any).doctorName).trim()
              : (typeof user?.name === 'string' && user.name.trim())
                ? user.name.trim()
                : null,
        })
      : shippingAddress;
    const shippingRecipientDisplayName = typeof shippingAddressForDisplay?.name === 'string'
      ? shippingAddressForDisplay.name.trim()
      : shippingRecipientName;
    const billingAddress =
      billingAddressBase && shippingRecipientDisplayName
        ? { ...billingAddressBase, name: shippingRecipientDisplayName }
        : billingAddressBase;
    const shippingMethodLabel = isFacilityPickupOrder ? 'Facility Pickup' : shippingMethod;
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
      const normalizedKeys = withLegacyMetaKeys(key).map((entry) => String(entry).trim().toLowerCase());
      const match = Array.isArray(wooMeta)
        ? wooMeta.find((entry: any) => normalizedKeys.includes(String(entry?.key || '').trim().toLowerCase()))
        : null;
      return match?.value ?? null;
    };
    const discountCodeFromWoo = findWooMetaValue('trufusion_discount_code');
    const discountCodeAmountFromWoo = findWooMetaValue('trufusion_discount_code_amount');
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
      normalizeStringField(
        selectedOrder.paymentDetails ||
        (selectedOrder as any).payment_details ||
        (selectedOrder as any).paymentMethodTitle ||
        (selectedOrder as any).payment_method_title ||
        wooResponse?.payment_method_title ||
        wooPayload?.payment_method_title ||
        selectedOrder.paymentMethod ||
        (selectedOrder as any).payment_method ||
        (selectedOrder as any).rawPaymentMethod ||
        (selectedOrder as any).raw_payment_method ||
        wooResponse?.payment_method ||
        wooPayload?.payment_method,
      ) ||
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
    const orderDetailHasResellerPermit = hasUploadedResellerPermit(selectedOrder, localUser);
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
	        <div
            className={clsx(
              "account-order-card squircle-lg bg-white border overflow-hidden text-left",
              accountIsDoctor && "physician-dashboard-order-card",
            )}
          >
	          <div className="px-6 py-4 bg-[#f5f6f6] flex flex-wrap items-center justify-between gap-4">
	            <div className="space-y-1">
	              <p className="text-xs uppercase tracking-[0.08em] text-slate-500">Order</p>
	              <div className="flex flex-wrap items-center gap-2">
                  <p className="text-lg font-semibold text-slate-900">
                    {selectedOrder.number ? `Order #${selectedOrder.number}` : selectedOrder.id}
                  </p>
                  {resolveDelegateOrderLabel(selectedOrder as any) ? (
                    <Badge
                      variant="secondary"
                      className="uppercase"
                      title={resolveDelegateOrderLabel(selectedOrder as any) || undefined}
                    >
                      Delegate Proposal
                    </Badge>
                  ) : null}
                </div>
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
              {isFacilityPickupOrder || isHandDeliveredOrder || deliveredAtLabel ? (
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Delivery</p>
                  <div className="text-sm font-semibold text-slate-900">
                    {renderOrderTextOrShimmer(
                      isFacilityPickupOrder || isHandDeliveredOrder
                        ? deliverySummaryLabel
                        : deliveredAtLabel,
                      'w-32',
                    )}
                  </div>
                </div>
              ) : showEstimateDetails && (
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Estimate</p>
                  <div className="text-sm font-semibold text-slate-900">
                    {renderOrderTextOrShimmer(estimateRangeLabel, 'w-32')}
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

	          <div className="p-6 space-y-6">
	            <div className="grid gap-4 md:grid-cols-2">
	              <div className="space-y-3">
	                <h4 className="text-base font-semibold text-slate-900">Shipping Information</h4>
	                {renderAddressLinesForOrderDetail(shippingAddressForDisplay)}
	                <div className="text-sm text-slate-700 space-y-1">
	                  {shippedAtLabel && (
	                    <p>
	                      <span className="font-semibold">Shipped:</span>{' '}
	                      {shippedAtLabel}
	                    </p>
	                  )}
	                  {shippingMethodLabel && (
	                    <p>
	                      <span className="font-semibold">Service:</span> {shippingMethodLabel}
	                    </p>
	                  )}
	                  {!isFacilityPickupOrder && (
	                    <p>
	                      <span className="font-semibold">Tracking:</span>{' '}
	                      {trackingNumber ? (
	                        trackingHref ? (
	                          <a
	                            href={trackingHref}
	                            target="_blank"
	                            rel="noreferrer"
	                            className="text-[rgb(11,6,121)] hover:underline"
	                          >
	                            {trackingNumber}
	                          </a>
	                        ) : (
	                          trackingNumber
	                        )
	                      ) : (
	                        'Provided when shipped'
	                      )}
	                    </p>
	                  )}
	                  {!isFacilityPickupOrder && trackingStatusLine && (
	                    <p>
	                      <span className="font-semibold">Tracking Status:</span>{' '}
	                      {trackingStatusLine}
	                    </p>
	                  )}
	                </div>
	              </div>

	              <div className="space-y-3">
	                <h4 className="text-base font-semibold text-slate-900">Billing Information</h4>
	                {!isFacilityPickupOrder && renderAddressLinesForOrderDetail(billingAddress)}
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
	                  {orderDetailHasResellerPermit && (
	                    <p>
	                      <span className="font-semibold">Permit:</span>{' '}
	                      Reseller permit uploaded
	                    </p>
	                  )}
	                  {selectedOrder.physicianCertified && !orderDetailHasResellerPermit && accountIsDoctor && (
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
	                          className="order-detail-line-thumbnail rounded-xl border border-[#d5d9d9] bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0"
	                        >
	                          {lineImage ? (
	                            <img
	                              src={lineImage}
	                              alt={line.name || 'Item thumbnail'}
	                              className="order-detail-line-thumbnail__img"
	                              onError={(event) => {
	                                event.currentTarget.style.display = 'none';
	                              }}
                            />
                          ) : (
                            <Package className="h-6 w-6 text-black" />
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
                    <div className="flex justify-between text-[rgb(11,6,121)]">
                      <span>{discountCode ? `Discount (${discountCode})` : 'Discount'}</span>
                      <span>-{formatCurrency(resolvedDiscountCodeAmount, selectedOrder.currency || 'USD')}</span>
                    </div>
                  )}
                  {hasDiscountCode && resolvedDiscountCodeAmount <= 0 && (
                    <div className="flex justify-between text-[rgb(11,6,121)]">
                      <span>{`Discount code used (${discountCode})`}</span>
                      <span>Applied</span>
                    </div>
                  )}
                  {resolvedHasExplicitDiscounts && appliedReferralCredit > 0 && (
                    <div className="flex justify-between text-[rgb(11,6,121)]">
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
	                  <div className="flex justify-between text-[rgb(11,6,121)]">
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
		                <div className="flex justify-between text-base font-semibold text-slate-900 pt-3">
		                  <span>Total</span>
		                  <span>{formatCurrency(Math.max(grandTotal, 0), selectedOrder.currency || 'USD')}</span>
		                </div>
		              </div>
		            </div>

		            {typeof selectedOrder.notes === 'string' && selectedOrder.notes.trim().length > 0 && (
		              <div className="space-y-2">
		                <h4 className="text-base font-semibold text-slate-900">
		                  Notes <span className="label-paren">(from TrufusionLabs)</span>
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
		          <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
		            <div
		              className="orders-updated-status-button inline-flex shrink-0 items-center gap-1 text-xs text-slate-500 px-3 py-1.5 squircle-sm bg-transparent shadow-none"
		              aria-live="polite"
		            >
		              {accountOrdersLoading && <RefreshActionIcon spinning />}
		              <span>Auto-updating</span>
		            </div>

		            <div
		              className="header-search-field relative isolate min-w-0 flex-1 sm:w-[16rem] sm:flex-none md:w-[18rem]"
		              style={{
		                '--header-search-border-color': delegateMode ? secondaryColor : HEADER_BRAND_BLUE,
		                '--header-search-text-color': delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		                color: delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		              } as CSSProperties}
		            >
		              <Input
		                type="text"
		                inputMode="search"
		                enterKeyHint="search"
		                value={ordersSearchQuery}
		                onChange={(event) => setOrdersSearchQuery(event.target.value)}
		                placeholder="Search orders..."
		                className="header-search-input orders-search-input relative z-0 squircle-sm !h-[2.4rem] !min-h-[2.4rem] !max-h-[2.4rem] w-full box-border pl-10 pr-12 placeholder:text-slate-500 focus-visible:outline-none focus-visible:!ring-0"
		                style={{
		                  '--header-search-border-color': delegateMode ? secondaryColor : undefined,
		                  '--header-search-text-color': delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		                  color: delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		                  caretColor: delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		                } as CSSProperties}
		              />
		              <Search
		                aria-hidden="true"
		                focusable="false"
		                className="header-search-icon pointer-events-none absolute left-3 top-1/2 z-20 block h-4 w-4 -translate-y-1/2 transform"
		                style={{
		                  color: delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		                  stroke: delegateMode ? secondaryColor : HEADER_SEARCH_TEXT_GREY,
		                  zIndex: 20,
		                }}
		              />
		              {ordersSearchQuery.trim().length > 0 && (
		                <button
		                  type="button"
		                  aria-label="Clear order search"
		                  onClick={() => setOrdersSearchQuery('')}
		                  className="absolute right-3 left-auto top-1/2 z-20 -translate-y-1/2 rounded-full p-1 text-slate-900/70 transition-colors hover:bg-white/50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.4)]"
		                >
		                  <X className="h-4 w-4" />
		                </button>
		              )}
		            </div>
		          </div>

	          <div className="flex items-center gap-2 ml-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onToggleShowCanceled?.()}
              className="orders-canceled-toggle-button header-home-button order-buy-again-button squircle-sm bg-white text-slate-900 px-6 justify-center font-semibold gap-2 my-0 !h-[2.4rem] !min-h-[2.4rem] !max-h-[2.4rem] py-0 leading-none"
            >
              {showCanceledOrders ? (
                <>
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                  Hide canceled
                </>
  ) : (
    <>
                  <Eye className="h-4 w-4" aria-hidden="true" />
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
          <div className="glass-card squircle-md p-4 border border-[rgba(11,6,121,0.35)] bg-white/80 flex items-center gap-3">
            <RefreshActionIcon spinning />
            <div>
              <p className="text-sm font-semibold text-slate-900">Loading product and order catalog…</p>
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
  const showInfoHeaderWelcome = suppressSearch && !delegateMode && Boolean(user);
  const infoHeaderWelcomeText =
    ((localUser?.visits ?? user?.visits ?? 1) > 1)
      ? 'Welcome back!'
      : 'Welcome!';
  const delegateUserIconClassName = 'h-5 w-5 flex-shrink-0';
  const delegatePreviewSecondaryHex =
    normalizeDelegateSecondaryColor(localUser?.delegateSecondaryColor ?? user?.delegateSecondaryColor ?? null)
    || DEFAULT_DELEGATE_SECONDARY_COLOR;
  const delegatePreviewSecondaryColor = hexToRgbCss(delegatePreviewSecondaryHex);
  const delegatePreviewTranslucentSecondary = hexToRgbaCss(delegatePreviewSecondaryHex, 0.18);
  const delegatePreviewBackgroundColorRaw = normalizeDelegateBackgroundColor(
    localUser?.delegateBackgroundColor ?? user?.delegateBackgroundColor ?? null,
  );
  const delegatePreviewBackgroundColorHex = delegatePreviewBackgroundColorRaw || DEFAULT_DELEGATE_BACKGROUND_COLOR;
  const delegatePreviewBackgroundImageUrl = normalizeDelegateImageUrl(
    localUser?.delegateBackgroundImageUrl ?? user?.delegateBackgroundImageUrl ?? null,
  );
  const delegatePreviewBackgroundImageCss = delegatePreviewBackgroundImageUrl
    ? toCssUrlValue(delegatePreviewBackgroundImageUrl)
    : 'none';
  const delegateSupportEmail = 'support@trufusionlabs.com';
  const delegateSalesRepEmail = String(localUser?.salesRep?.email || '').trim();
  const hasDelegateSalesRepEmail = delegateSalesRepEmail.length > 0;
  const delegateFunnelStageData = DELEGATE_LINK_FUNNEL_STAGES.map((stage) => ({
    ...stage,
    count: Math.max(0, Math.floor(Number(delegateFunnelCounts[stage.event]) || 0)),
  }));
  const delegateFunnelMaxCount = delegateFunnelStageData.reduce(
    (max, stage) => Math.max(max, stage.count),
    0,
  );

  const showCreateLinkDialogBackButton =
    createLinkDialogMode !== 'select' && showCreateLinkTypeChooser && !patientLinkEditing;
  const createLinkDialogIntroClassName = clsx(
    'create-link-dialog-intro',
    createLinkDialogMode === 'select' && 'create-link-dialog-intro--select',
    !showCreateLinkDialogBackButton && 'create-link-dialog-intro--close-only',
  );
  const createLinkDialogActionControls = (
    <div
      className={clsx(
        'create-link-dialog-actions',
        showCreateLinkDialogBackButton
          ? 'create-link-dialog-actions--with-back'
          : 'create-link-dialog-actions--close-only',
      )}
      aria-label="Create link dialog controls"
    >
      {showCreateLinkDialogBackButton && (
        <Button
          type="button"
          variant="outline"
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) {
              return;
            }
            handleCreateLinkBackToSelect(event);
          }}
          onClick={handleCreateLinkBackToSelect}
          className="create-link-dialog-back-button header-home-button squircle-sm !h-[38px] min-h-[38px] bg-white px-4 text-slate-900"
        >
          Back
        </Button>
      )}
      <DialogClose asChild>
        <button
          type="button"
          className="create-link-dialog-close-button dialog-close-btn"
          aria-label="Close create link dialog"
        >
          <X className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </button>
      </DialogClose>
    </div>
  );

  const delegateOptInStep = (
    <div className="space-y-5">
      <div className={createLinkDialogIntroClassName}>
        <div className="create-link-dialog-title-copy">
          <DialogTitle className="text-xl font-semibold text-slate-900">
            Welcome to Delegate Links!
          </DialogTitle>
          <DialogDescription className="sr-only">
            Enable access to create delegate links.
          </DialogDescription>
        </div>
        {createLinkDialogActionControls}
      </div>
      <div className="rounded-xl bg-white/55 px-5 py-5 sm:px-6">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-slate-700">
            This service has been enabled for your account in a beta capacity. Delegate Links allows you to initiate and manage white-labeled delegate proposal sessions. A trusted delegate can review physician-authorized research material information and submit selections for your review, approval, modification, or rejection.
          </p>
          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
            {[
              { src: delegateLinkBetaImage1, alt: 'Delegate Links beta preview 1' },
              { src: delegateLinkBetaImage2, alt: 'Delegate Links beta preview 2' },
            ].map((image) => (
              <div
                key={image.src}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-sm"
              >
                <img
                  src={image.src}
                  alt={image.alt}
                  className="h-48 w-full object-cover bg-white"
                />
              </div>
            ))}
          </div>
          <p className="text-sm leading-relaxed text-slate-700">
            The intention for this tool is to reduce administrative friction in your physician-directed research workflow. By enabling Delegate Links, you understand that you are solely responsible for its appropriate use within your independent research and professional context. Links can be viewed and tested before being shared with authorized delegates.
          </p>
          <p className="text-sm leading-relaxed text-slate-700">
            If you have any questions or recommendations, please contact{' '}
            {hasDelegateSalesRepEmail ? (
              <>
                your rep at{' '}
                <a
                  href={`mailto:${delegateSalesRepEmail}`}
                  className="font-semibold text-[rgb(11,6,121)] underline decoration-[rgb(11,6,121)] underline-offset-2 hover:opacity-80"
                >
                  {delegateSalesRepEmail}
                </a>
                {' '}or our support team at{' '}
              </>
            ) : (
              <>our support team at{' '}</>
            )}
            <a
              href={`mailto:${delegateSupportEmail}`}
              className="font-semibold text-[rgb(11,6,121)] underline decoration-[rgb(11,6,121)] underline-offset-2 hover:opacity-80"
            >
              {delegateSupportEmail}
            </a>
            .
          </p>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          onClick={async () => {
            if (delegateOptInSaving) {
              return;
            }
            setDelegateOptInSaving(true);
            try {
              await saveProfileField('Delegate Links opt-in', { delegateOptIn: true });
            } finally {
              setDelegateOptInSaving(false);
            }
          }}
          disabled={delegateOptInSaving}
          className="header-home-button squircle-sm bg-white text-slate-900"
        >
          {delegateOptInSaving ? 'Enabling access…' : 'Enable Access'}
        </Button>
      </div>
    </div>
  );

		  const patientLinksPanel = showPatientLinksTab ? (
      <div className="space-y-6">
        <div className="flex flex-col gap-6">
      <Dialog
        modal={!patientLinkProductPickerOpen && !createLinkLegalDocument}
        open={createLinkDialogOpen}
        onOpenChange={(open) => {
          if (!open && createLinkLegalDocument) {
            setCreateLinkDialogOpen(true);
            return;
          }
          if (!open && patientLinkProductPickerOpen) {
            setCreateLinkDialogOpen(true);
            setCreateLinkDialogMode(createLinkDialogMode === 'brochure' ? 'brochure' : 'delegate');
            return;
          }
	          setCreateLinkDialogOpen(open);
	          if (!open) {
	            setCreateLinkDialogMode(showCreateLinkTypeChooser ? 'select' : 'brochure');
	            setPatientLinkEditing(null);
	          }
        }}
      >
        <DialogContent
          ref={createLinkDialogContentRef}
          trapFocus={!createLinkLegalDocument && !patientLinkProductPickerOpen}
          disableOutsidePointerEvents={false}
          onEscapeKeyDown={(event) => {
            if (createLinkLegalDocument) {
              event.preventDefault();
              closeCreateLinkLegalDocument(event);
            }
          }}
          onPointerDownOutside={(event) => {
            if (patientLinkProductPickerOpen || createLinkLegalDocument) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (patientLinkProductPickerOpen || createLinkLegalDocument) {
              event.preventDefault();
            }
          }}
          onFocusOutside={(event) => {
            if (patientLinkProductPickerOpen || createLinkLegalDocument) {
              event.preventDefault();
            }
          }}
          className={
            createLinkDialogMode === 'select'
              ? "create-link-dialog-content max-w-[min(720px,calc(100vw-2rem))] overflow-x-hidden sm:max-w-[min(720px,calc(100vw-2rem))] lg:max-w-[min(720px,calc(100vw-2rem))]"
              : "create-link-dialog-content max-w-[min(920px,calc(100vw-2rem))] overflow-x-hidden sm:max-w-[min(920px,calc(100vw-2rem))] lg:max-w-[min(920px,calc(100vw-2rem))]"
          }
          overlayClassName="bg-slate-950/45"
          overlayStyle={{ zIndex: 15000 }}
          containerClassName="fixed inset-0 flex items-center justify-center px-3 py-6 sm:px-4 sm:py-8"
          containerStyle={{
            zIndex: 15000,
          }}
          hideCloseButton
          style={{
            zIndex: 15001,
            width:
              createLinkDialogMode === 'select'
                ? 'min(720px, calc(100vw - 2rem))'
                : 'min(920px, calc(100vw - 2rem))',
            maxWidth:
              createLinkDialogMode === 'select'
                ? 'min(720px, calc(100vw - 2rem))'
                : 'min(920px, calc(100vw - 2rem))',
          }}
        >
          {createLinkDialogMode !== 'select' && (
            <VisuallyHidden>
              <DialogTitle>
                {createLinkDialogMode === 'brochure'
                  ? patientLinkEditing ? 'Modify brochure link' : 'Create brochure link'
                  : patientLinkEditing ? 'Modify proposal link' : 'Create proposal link'}
              </DialogTitle>
              <DialogDescription>
                {createLinkDialogMode === 'brochure'
                  ? 'Configure a view-only brochure link.'
                  : 'Configure a delegate proposal link.'}
              </DialogDescription>
            </VisuallyHidden>
          )}
          {createLinkDialogMode === 'select' ? (
            <div key="create-link-select" className="create-link-dialog-panel space-y-5">
              <div className={createLinkDialogIntroClassName}>
                <div className="create-link-dialog-title-copy">
                  <DialogTitle className="text-xl font-semibold text-slate-900">
                    What kind of link would you like to create?
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    Choose a link type.
                  </DialogDescription>
                </div>
                {createLinkDialogActionControls}
              </div>
              <div className="create-link-type-options">
                {brochureLinkCreationEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setPatientLinkEditing(null);
                      trackPatientLinkUsageEvent('brochure', 'button_clicked', { source: 'create_link_dialog' });
                      setPatientLinkBrochureNameDraft('');
                      setPatientLinkProductScopeDraft('all_physician_approved');
                      setCreateLinkDialogMode('brochure');
                    }}
                    className="create-link-type-button"
                  >
                    <BookOpenIcon className="create-link-type-button__icon" aria-hidden="true" />
                    <span className="create-link-type-button__copy">
                      <span className="create-link-type-button__label">Brochure</span>
                      <span className="create-link-type-button__subtext">
                        Create a shareable product brochure page with descriptions.
                      </span>
                    </span>
                  </button>
                )}
                {delegateLinkCreationEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setPatientLinkEditing(null);
                      trackPatientLinkUsageEvent('delegate', 'create_started', { source: 'create_link_dialog' });
                      setCreateLinkDialogMode('delegate');
                    }}
                    className="create-link-type-button"
                  >
                    <CursorArrowRippleIcon className="create-link-type-button__icon" aria-hidden="true" />
                    <span className="create-link-type-button__copy">
	                      <span className="create-link-type-button__label">
	                        Proposal
	                        <span className="create-link-type-button__beta">Beta</span>
	                      </span>
                      <span className="create-link-type-button__subtext">
                        Create a delegate proposal session for physician review.
                      </span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          ) : createLinkDialogMode === 'brochure' ? (
            <div key="create-link-brochure" className="create-link-dialog-panel space-y-5">
              <div className={createLinkDialogIntroClassName}>
                <div className="create-link-dialog-title-copy">
                  <h3 className="text-lg font-semibold leading-tight text-slate-900">
                    {patientLinkEditing ? 'Modify brochure link' : 'Create a brochure link'}
                  </h3>
                  <p className="mt-1 mb-0 text-sm leading-relaxed text-slate-700">
                    Configure a view-only brochure link for sharing approved product information.
                  </p>
                </div>
                {createLinkDialogActionControls}
              </div>
              <div className="delegate-link-create-form patient-link-form patient-link-form--generate patient-link-form--grouped">
                <div className="patient-link-group rounded-xl bg-white/55 px-0 py-4 sm:px-5">
                  <div className="pt-1">
                    <p className="text-base font-semibold uppercase text-[rgb(11,6,121)]">
                      Brochure, Recipient & Scope
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Brochure links are view-only and never show pricing, cart, or checkout.
                    </p>
                  </div>
                  <Label htmlFor="brochure-name" className="patient-link-form__label text-sm font-semibold text-slate-700">
                    Link name
                  </Label>
                  <Input
                    id="brochure-name"
                    required
                    value={patientLinkBrochureNameDraft}
                    onChange={(event) => {
                      setPatientLinkBrochureNameDraft(event.target.value);
                      trackPatientLinkFieldEntry('link_name', event.target.value, 'brochure');
                    }}
                    className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  />
                  <Label htmlFor="brochure-recipient-name" className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700">
                    Recipient name or alias <span className="label-paren label-paren--right">(optional)</span>
                  </Label>
                  <Input
                    id="brochure-recipient-name"
                    value={patientLinkRecipientNameDraft}
                    onChange={(event) => {
                      setPatientLinkRecipientNameDraft(event.target.value);
                      trackPatientLinkFieldEntry('recipient_name', event.target.value, 'brochure');
                    }}
                    className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  />
                  <Label htmlFor="brochure-recipient-contact" className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700">
                    Recipient email or phone <span className="label-paren label-paren--right">(optional)</span>
                  </Label>
                  <Input
                    id="brochure-recipient-contact"
                    value={patientLinkRecipientContactDraft}
                    onChange={(event) => {
                      setPatientLinkRecipientContactDraft(event.target.value);
                      trackPatientLinkFieldEntry('recipient_contact', event.target.value, 'brochure');
                    }}
                    className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  />
                  <Label htmlFor="brochure-study-label" className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700">
                    Study label <span className="label-paren label-paren--right">(optional)</span>
                  </Label>
                  <Input
                    id="brochure-study-label"
                    value={patientLinkStudyLabelDraft}
                    onChange={(event) => {
                      setPatientLinkStudyLabelDraft(event.target.value);
                      trackPatientLinkFieldEntry('study_label', event.target.value, 'brochure');
                    }}
                    className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  />
                  <Label htmlFor="brochure-reference" className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700">
                    Internal reference <span className="label-paren label-paren--right">(optional)</span>
                  </Label>
                  <Input
                    id="brochure-reference"
                    value={patientLinkReferenceDraft}
                    onChange={(event) => {
                      setPatientLinkReferenceDraft(event.target.value);
                      trackPatientLinkFieldEntry('internal_reference', event.target.value, 'brochure');
                    }}
                    className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  />
                  <Label htmlFor="brochure-product-scope" className="patient-link-form__label text-sm font-semibold text-slate-700">
                    Brochure product scope
                  </Label>
                  <select
                    id="brochure-product-scope"
                    value={patientLinkProductScopeDraft}
                    onChange={(event) => {
                      const nextScope = event.target.value as DelegateProductScope;
                      setPatientLinkProductScopeDraft(nextScope);
                      trackPatientLinkFieldEntry('product_scope', event.target.value, 'brochure');
                    }}
                    className="patient-link-form__select h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  >
                    <option value="all_physician_approved">All brochure-safe products</option>
                    <option value="specific_products">Selected products only</option>
                  </select>
                  {patientLinkProductScopeDraft === 'specific_products' && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        captureCreateLinkDialogScrollPosition();
                        setPatientLinkProductPickerOpen(true);
                      }}
                      className="delegate-product-picker-trigger h-10 w-full justify-between squircle-sm border-0 !border-0 bg-transparent text-slate-900 shadow-none focus-visible:!border-transparent focus-visible:!ring-0"
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <Package className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">
                          {patientLinkApprovedProductIds.length > 0
                            ? `${patientLinkApprovedProductIds.length} selected product${patientLinkApprovedProductIds.length === 1 ? '' : 's'}`
                            : 'Choose selected products'}
                        </span>
                      </span>
                      <span className="text-xs font-semibold text-slate-500">
                        {catalogLoading ? 'Loading' : `${delegateProductPickerItems.length}`}
                      </span>
                    </Button>
                  )}
                  <Label htmlFor="brochure-expiry-hours" className="patient-link-form__label text-sm font-semibold text-slate-700">
                    Expiration hours
                  </Label>
                  <Input
                    id="brochure-expiry-hours"
                    type="text"
                    inputMode="numeric"
                    value={patientLinkExpiryHoursDraft}
                    onChange={(event) => {
                      const next = event.target.value.replace(/[^\d]/g, '');
                      setPatientLinkExpiryHoursDraft(next);
                      trackPatientLinkFieldEntry('expiration_hours', next, 'brochure');
                    }}
                    className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                  />
                </div>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  onClick={() => {
                    if (patientLinkEditing) {
                      void handleActivateModifiedPatientLink();
                      return;
                    }
                    void handleCreateBrochureLink();
                  }}
                  disabled={!showPatientLinksTab || patientLinksCreating}
                  className="header-home-button squircle-sm bg-white text-slate-900"
                >
                  {patientLinksCreating
                    ? patientLinkEditing ? 'Activating…' : 'Creating…'
                    : patientLinkEditing ? 'Activate link' : 'Create brochure link'}
                </Button>
              </div>
            </div>
          ) : !delegateOptInEnabled ? (
            delegateOptInStep
          ) : (
      <div key="create-link-delegate" className="create-link-dialog-panel">
        <div className={createLinkDialogIntroClassName}>
          <div className="create-link-dialog-title-copy">
            <h3 className="text-lg font-semibold leading-tight text-slate-900">
              {patientLinkEditing ? 'Modify proposal link' : 'Create a proposal link'}
            </h3>
            <p className="mt-1 mb-0 text-sm leading-relaxed text-slate-700">
              {patientLinkEditing
                ? 'This link is revoked while you modify it. Activate it when the updated proposal session is ready.'
                : 'This tool is intended to support physician-directed research material proposal workflows. You can preview links before sharing them with an authorized delegate.'}
            </p>
          </div>
          {createLinkDialogActionControls}
        </div>
	        <div className="delegate-link-create-form mt-5 patient-link-form patient-link-form--generate patient-link-form--grouped">
            <div className="patient-link-group rounded-xl bg-white/55 px-0 py-4 sm:px-5">
            <div className="pt-1">
              <p className="text-base font-semibold uppercase tracking-[0.08em] text-[rgb(11,6,121)]">
                Subject & Access
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Define research metadata for this proposal session.
              </p>
            </div>
	          <Label
	            htmlFor="patient-link-subject-label"
	            className="patient-link-form__label patient-link-form__label--patient-id patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
		            Link name <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Input
	            id="patient-link-subject-label"
	            value={patientLinkSubjectLabelDraft}
	            onChange={(event) => {
                setPatientLinkSubjectLabelDraft(event.target.value);
                trackPatientLinkFieldEntry('link_name', event.target.value);
              }}
            className="patient-link-form__patient-id-input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-study-label"
	            className="patient-link-form__label patient-link-form__label--link patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Study label <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Input
	            id="patient-link-study-label"
	            value={patientLinkStudyLabelDraft}
	            onChange={(event) => {
                setPatientLinkStudyLabelDraft(event.target.value);
                trackPatientLinkFieldEntry('study_label', event.target.value);
              }}
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-reference"
	            className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Internal reference <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Input
	            id="patient-link-reference"
	            value={patientLinkReferenceDraft}
	            onChange={(event) => {
                setPatientLinkReferenceDraft(event.target.value);
                trackPatientLinkFieldEntry('internal_reference', event.target.value);
              }}
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-delegate-name"
	            className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Delegate name or alias <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Input
	            id="patient-link-delegate-name"
	            value={patientLinkDelegateNameDraft}
	            onChange={(event) => {
                setPatientLinkDelegateNameDraft(event.target.value);
                trackPatientLinkFieldEntry('delegate_name', event.target.value);
              }}
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-delegate-contact"
	            className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Delegate email or phone <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Input
	            id="patient-link-delegate-contact"
	            value={patientLinkDelegateContactDraft}
	            onChange={(event) => {
                setPatientLinkDelegateContactDraft(event.target.value);
                trackPatientLinkFieldEntry('delegate_contact', event.target.value);
              }}
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-delegate-role"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Delegate role
	          </Label>
	          <select
	            id="patient-link-delegate-role"
	            value={patientLinkDelegateRoleDraft}
	            onChange={(event) => setPatientLinkDelegateRoleDraft(event.target.value as DelegateRole)}
	            className="patient-link-form__select h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          >
	            {delegateRoleOptions.map((opt) => (
	              <option key={opt.value} value={opt.value}>
	                {opt.label}
	              </option>
	            ))}
	          </select>
	          <Label
	            htmlFor="patient-link-product-scope"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Authorized product scope
	          </Label>
	          <select
	            id="patient-link-product-scope"
	            value={patientLinkProductScopeDraft}
	            onChange={(event) => {
                const nextScope = event.target.value as DelegateProductScope;
                setPatientLinkProductScopeDraft(nextScope);
                trackPatientLinkFieldEntry('product_scope', event.target.value);
              }}
	            className="patient-link-form__select h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          >
	            {delegateProductScopeOptions.map((opt) => (
	              <option key={opt.value} value={opt.value}>
	                {opt.label}
	              </option>
	            ))}
	          </select>
	          {(patientLinkProductScopeDraft === 'all_physician_approved' || patientLinkProductScopeDraft === 'specific_products' || patientLinkProductScopeDraft === 'specific_cart_only') && (
	            <Button
	              type="button"
	              variant="ghost"
	              onClick={() => {
	                if (patientLinkProductScopeDraft === 'specific_cart_only') {
	                  return;
	                }
	                captureCreateLinkDialogScrollPosition();
	                setPatientLinkProductPickerOpen(true);
	              }}
	              className="delegate-product-picker-trigger h-10 w-full justify-between squircle-sm border-0 !border-0 bg-transparent text-slate-900 shadow-none focus-visible:!border-transparent focus-visible:!ring-0"
	            >
	              <span className="inline-flex min-w-0 items-center gap-2">
	                <Package className="h-4 w-4 shrink-0" aria-hidden="true" />
	                <span className="truncate">
	                  {patientLinkProductScopeDraft === 'specific_cart_only'
	                    ? `${patientLinkCartProductCount} cart product${patientLinkCartProductCount === 1 ? '' : 's'} selected`
	                    : patientLinkProductScopeDraft === 'specific_products' && patientLinkApprovedProductIds.length === 0
	                    ? 'Choose selected products'
	                    : patientLinkApprovedProductIds.length > 0
	                    ? `${patientLinkApprovedProductIds.length} approved product${patientLinkApprovedProductIds.length === 1 ? '' : 's'} selected`
	                    : 'Choose approved products'}
	                </span>
	              </span>
	              <span className="text-xs font-semibold text-slate-500">
	                {patientLinkProductScopeDraft === 'specific_cart_only'
	                  ? `${patientLinkCartProductCount}`
	                  : catalogLoading ? 'Loading' : `${delegateProductPickerItems.length}`}
	              </span>
	            </Button>
	          )}
	          <Label
	            htmlFor="patient-link-delegate-permission"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Delegate permissions
	          </Label>
	          <select
	            id="patient-link-delegate-permission"
	            value={patientLinkDelegatePermissionDraft}
	            onChange={(event) => {
                setPatientLinkDelegatePermissionDraft(event.target.value as DelegatePermission);
                trackPatientLinkFieldEntry('delegate_permission', event.target.value);
              }}
	            className="patient-link-form__select h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          >
	            {delegatePermissionOptions.map((opt) => (
	              <option key={opt.value} value={opt.value}>
	                {opt.label}
	              </option>
	            ))}
	          </select>
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
            className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
            </div>
            <div className="patient-link-group rounded-xl bg-white/55 px-0 py-4 sm:px-5">
            <div className="pt-2">
              <p className="text-base font-semibold uppercase tracking-[0.08em] text-[rgb(11,6,121)]">
                Pricing & Limits
              </p>
            </div>
	          <Label
	            htmlFor="patient-link-markup"
	            className="patient-link-form__label patient-link-form__label--markup text-sm font-semibold text-slate-700"
	          >
	            Product markup %
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
	              className="!h-11 w-full text-left tabular-nums squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	              style={{ direction: 'ltr' }}
	            />
	          </div>
	          <Label
	            htmlFor="patient-link-pricing-disclosure"
	            className="patient-link-form__label text-sm font-semibold text-slate-700"
	          >
	            Delegate-facing pricing disclosure
	          </Label>
	          <Textarea
	            id="patient-link-pricing-disclosure"
	            value={patientLinkPricingDisclosureDraft}
	            onChange={(event) => {
                setPatientLinkPricingDisclosureDraft(event.target.value);
                trackPatientLinkFieldEntry('pricing_disclosure', event.target.value);
              }}
	            rows={2}
	            className="patient-link-form__instructions min-h-[56px] squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
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
	                || patientLinkInstructionsDraft.trim() === currentDefault.trim()
	                || isGeneratedPatientLinkDefaultInstructions(patientLinkInstructionsDraft, localUser?.name ?? user?.name ?? null);
	              setPatientLinkPaymentMethodDraft(next);
	              if (shouldReplace) {
	                setPatientLinkInstructionsDraft(
                    buildPatientLinkDefaultInstructions(next, zelleContactDraft.trim() || null, localUser?.name ?? user?.name ?? null),
                  );
	              }
	            }}
	            className="patient-link-form__select h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          >
	            {patientLinkPaymentMethodOptions.map((opt) => (
	              <option key={opt.value} value={opt.value}>
	                {opt.label}
	              </option>
	            ))}
	          </select>
	          {patientLinkPaymentMethodDraft === 'zelle' && (
	            <>
	              <Label
	                htmlFor="patient-link-zelle-recipient-name"
	                className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	              >
	                Zelle recipient name <span className="label-paren label-paren--right">(optional)</span>
	              </Label>
	              <Input
	                id="patient-link-zelle-recipient-name"
	                value={patientLinkZelleRecipientNameDraft}
	                onChange={(event) => {
                    setPatientLinkZelleRecipientNameDraft(event.target.value);
                    trackPatientLinkFieldEntry('zelle_recipient_name', event.target.value);
                  }}
	                className="patient-link-form__input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	              />
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
                    const nextContact = event.target.value;
                    const currentDefault = buildPatientLinkDefaultInstructions(
                      'zelle',
                      zelleContactDraft.trim() || null,
                      localUser?.name ?? user?.name ?? null,
                    );
                    const shouldReplace =
                      patientLinkPaymentMethodDraft === 'zelle'
                      && (
                        !patientLinkInstructionsDraft.trim()
                        || patientLinkInstructionsDraft.trim() === currentDefault.trim()
                        || isGeneratedPatientLinkDefaultInstructions(patientLinkInstructionsDraft, localUser?.name ?? user?.name ?? null)
                      );
                    setZelleContactDraft(nextContact);
                    if (shouldReplace) {
                      setPatientLinkInstructionsDraft(
                        buildPatientLinkDefaultInstructions('zelle', nextContact.trim() || null, localUser?.name ?? user?.name ?? null),
                      );
                    }
                    trackPatientLinkFieldEntry('zelle_contact', event.target.value);
                  }}
	                className="patient-link-form__zelle-contact-input h-11 w-full mb-0 squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	              />
	              <Label
	                htmlFor="patient-link-instructions"
	                className="patient-link-form__label patient-link-form__label--instructions text-sm font-semibold text-slate-700"
	              >
	                Payment instructions
	              </Label>
	              <Textarea
	                id="patient-link-instructions"
	                value={patientLinkInstructionsDraft}
	                onChange={(event) => {
                    setPatientLinkInstructionsDraft(event.target.value);
                    trackPatientLinkFieldEntry('payment_instructions', event.target.value);
                  }}
	                rows={2}
	                className="patient-link-form__instructions min-h-[56px] squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	              />
	              <label className="patient-link-form__checkbox-row flex items-center gap-3 text-sm font-semibold text-slate-700">
	                <input
	                  type="checkbox"
	                  className="brand-checkbox"
	                  checked={patientLinkPaymentConfirmationRequired}
	                  onChange={(event) => setPatientLinkPaymentConfirmationRequired(event.target.checked)}
	                />
	                Manual payment confirmation required
	              </label>
	            </>
	          )}
            </div>
            <div className="patient-link-group rounded-xl bg-white/55 px-0 py-4 sm:px-5">
            <div className="pt-2">
              <p className="text-base font-semibold uppercase tracking-[0.08em] text-[rgb(11,6,121)]">
                Notes & Instructions
              </p>
            </div>
	          <Label
	            htmlFor="patient-link-research-note"
	            className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Research note <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Textarea
	            id="patient-link-research-note"
	            value={patientLinkResearchNoteDraft}
	            onChange={(event) => {
                setPatientLinkResearchNoteDraft(event.target.value);
                trackPatientLinkFieldEntry('research_note', event.target.value);
              }}
	            rows={2}
	            className="min-h-[56px] squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-delegate-instructions"
	            className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Delegate-facing instructions <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Textarea
	            id="patient-link-delegate-instructions"
	            value={patientLinkDelegateInstructionsDraft}
	            onChange={(event) => {
                setPatientLinkDelegateInstructionsDraft(event.target.value);
                trackPatientLinkFieldEntry('delegate_instructions', event.target.value);
              }}
	            rows={2}
	            className="patient-link-form__instructions min-h-[56px] squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          <Label
	            htmlFor="patient-link-internal-note"
	            className="patient-link-form__label patient-link-form__label--optional-row text-sm font-semibold text-slate-700"
	          >
	            Internal physician-only note <span className="label-paren label-paren--right">(optional)</span>
	          </Label>
	          <Textarea
	            id="patient-link-internal-note"
	            value={patientLinkInternalPhysicianNoteDraft}
	            onChange={(event) => {
                setPatientLinkInternalPhysicianNoteDraft(event.target.value);
                trackPatientLinkFieldEntry('internal_physician_note', event.target.value);
              }}
	            rows={2}
	            className="patient-link-form__instructions !mb-0 min-h-[56px] squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
	          />
	          </div>
		          <div className="patient-link-submit-row delegate-link-submit-row mt-2 pt-3 pb-3">
		            <div className="delegate-link-certification-account rounded-lg border border-slate-200 bg-white/60 py-2 pl-0 pr-3 text-sm text-slate-700">
		              <span className="font-semibold text-slate-900">Physician/account holder:</span>{' '}
		              {localUser?.name || user?.name || localUser?.email || user?.email || 'Current account'}
		            </div>
		            <div className="patient-link-submit-copy delegate-link-certification-copy flex items-start gap-3 min-w-0">
	              <input
	                type="checkbox"
	                id="delegate-link-terms"
	                className="brand-checkbox"
	                checked={patientLinkTermsAccepted}
	                onChange={(event) => setPatientLinkTermsAccepted(event.target.checked)}
	              />
		              <label htmlFor="delegate-link-terms" className="text-sm text-slate-700 leading-snug flex-1 min-w-0">
		                I certify that I am the licensed physician or authorized clinic representative responsible for this link. I understand that TrufusionLabs does not provide medical advice, diagnosis, treatment, prescriptions, dosing guidance, patient instructions, or clinical decision support. I am solely responsible for any research protocol, delegate communication, consent, review, approval, purchase decision, and use of any information submitted through this link. I agree not to include PHI in non-identifying label fields and to comply with TrufusionLabs&apos;s{' '}
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
	                . Current versions: Terms {CURRENT_TERMS_VERSION}, Shipping {CURRENT_SHIPPING_POLICY_VERSION}, Privacy {CURRENT_PRIVACY_POLICY_VERSION}.
	              </label>
	            </div>
	            <div className="patient-link-submit-action delegate-link-submit-action flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
	              <Button
	                type="button"
	                onClick={() => {
                    if (patientLinkEditing) {
                      void handleActivateModifiedPatientLink();
                      return;
                    }
                    void handleCreatePatientLink();
                  }}
	                disabled={!showPatientLinksTab || patientLinksCreating}
	                className="header-home-button patient-link-form__button delegate-link-submit-button delegate-link-submit-button--primary !h-11 min-h-[44px] w-full mb-0 squircle-sm bg-white text-slate-900 px-7 sm:w-auto"
	              >
	                {patientLinksCreating
                    ? patientLinkEditing ? 'Activating…' : 'Creating…'
                    : patientLinkEditing ? 'Activate link' : 'Create proposal link'}
	              </Button>
	            </div>
	          </div>
	        </div>
	      </div>
          )}
        </DialogContent>
	      </Dialog>

	      {createLinkLegalDocument && typeof document !== 'undefined' && createPortal(
	        <div
	          className="delegate-product-picker-backdrop create-link-legal-backdrop"
	          role="presentation"
	          onMouseDown={(event) => {
	            if (event.target === event.currentTarget) {
	              closeCreateLinkLegalDocument(event);
	            }
	          }}
	        >
	          <ModalSquircle
	            className="create-link-legal-modal"
	            role="dialog"
	            aria-modal="true"
	            aria-labelledby="create-link-legal-title"
	            onMouseDown={(event) => event.stopPropagation()}
	          >
	            <div className="create-link-legal-header">
	              <h3 id="create-link-legal-title" className="create-link-legal-title">
	                {createLinkLegalDocument.title}
	              </h3>
	              <button
	                type="button"
	                className="create-link-legal-close dialog-close-btn"
	                onClick={closeCreateLinkLegalDocument}
	                aria-label="Close legal document"
	              >
	                <X className="h-5 w-5" aria-hidden="true" />
	              </button>
	            </div>
	            <div className="create-link-legal-body">
	              <div
	                className="legal-richtext text-sm leading-relaxed text-slate-700"
	                dangerouslySetInnerHTML={{ __html: createLinkLegalDocument.html }}
	              />
	            </div>
	          </ModalSquircle>
	        </div>,
	        document.body,
	      )}

	      {patientLinkProductPickerOpen && typeof document !== 'undefined' && createPortal(
	        <div
	          className="delegate-product-picker-backdrop"
	          role="presentation"
	          onMouseDown={(event) => {
	            if (event.target === event.currentTarget) {
	              closePatientLinkProductPicker(event);
	            }
	          }}
	        >
	          <ModalSquircle
	            className="delegate-product-picker-modal"
	            role="dialog"
	            aria-modal="true"
	            aria-labelledby="delegate-product-picker-title"
	            onMouseDown={(event) => event.stopPropagation()}
	          >
	            <div className="delegate-product-picker-header">
	              <div className="min-w-0">
	                <h3 id="delegate-product-picker-title" className="text-base font-semibold text-slate-900">
	                  Physician-approved products
	                </h3>
	                <p className="text-xs text-slate-500">
	                  {patientLinkApprovedProductIds.length} selected
	                </p>
	              </div>
	              <button
	                type="button"
	                className="delegate-product-picker-close dialog-close-btn"
	                onClick={closePatientLinkProductPicker}
	                aria-label="Close product picker"
	              >
	                <X className="h-5 w-5" aria-hidden="true" />
	              </button>
	            </div>
	            <div className="delegate-product-picker-tools">
	              <div className="delegate-product-picker-search">
	                <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
	                <input
	                  value={patientLinkProductPickerQuery}
	                  onChange={(event) => setPatientLinkProductPickerQuery(event.target.value)}
	                  placeholder="Search products"
	                  className="delegate-product-picker-search-input"
	                />
	              </div>
	              <label htmlFor="delegate-product-picker-domain" className="sr-only">
	                Research domain
	              </label>
	              <select
	                id="delegate-product-picker-domain"
	                value={patientLinkProductPickerDomain}
	                onChange={(event) => setPatientLinkProductPickerDomain(event.target.value)}
	                className="delegate-product-picker-domain-select patient-link-payment-method-select squircle-sm bg-white text-sm font-semibold"
	              >
	                <option value="all">All research domains</option>
	                {delegateProductPickerDomainOptions.map((domain) => (
	                  <option key={domain.key} value={domain.key}>
	                    {domain.label} ({domain.count})
	                  </option>
	                ))}
	              </select>
	              <div className="delegate-product-picker-tool-buttons">
	                <Button
	                  type="button"
	                  variant="outline"
	                  onClick={() => {
	                    const visibleKeys = filteredDelegateProductPickerItems.map((item) => item.key);
	                    setPatientLinkApprovedProductIds((prev) => Array.from(new Set([...prev, ...visibleKeys])));
	                  }}
	                  className="delegate-product-picker-tool-button header-home-button squircle-sm bg-white text-slate-900"
	                >
	                  Select visible
	                </Button>
	                <Button
	                  type="button"
	                  variant="outline"
	                  onClick={() => setPatientLinkApprovedProductIds([])}
	                  className="delegate-product-picker-tool-button header-home-button squircle-sm bg-white text-slate-900"
	                >
	                  Clear
	                </Button>
	              </div>
	            </div>
	            <div className="delegate-product-picker-list" role="list">
	              {catalogLoading && delegateProductPickerItems.length === 0 ? (
	                <div className="delegate-product-picker-empty">Loading products…</div>
	              ) : filteredDelegateProductPickerItems.length === 0 ? (
	                <div className="delegate-product-picker-empty">No products found.</div>
	              ) : (
	                filteredDelegateProductPickerItems.map((item) => {
	                  const checked = patientLinkApprovedProductIdSet.has(item.key);
	                  const imageSrc =
	                    item.image && !delegateProductPickerBrokenImages.has(item.image)
	                      ? item.image
	                      : null;
	                  return (
	                    <label
	                      key={item.key}
	                      className={clsx('delegate-product-picker-row', checked && 'delegate-product-picker-row--selected')}
	                    >
	                      <input
	                        type="checkbox"
	                        checked={checked}
	                        onChange={() => togglePatientLinkApprovedProduct(item.key)}
	                        className="brand-checkbox"
	                      />
	                      <span className="delegate-product-picker-image">
	                        {imageSrc ? (
	                          <img
	                            src={imageSrc}
	                            alt=""
	                            loading="eager"
	                            decoding="async"
	                            onError={() => {
	                              setDelegateProductPickerBrokenImages((prev) => {
	                                if (prev.has(imageSrc)) return prev;
	                                const next = new Set(prev);
	                                next.add(imageSrc);
	                                return next;
	                              });
	                            }}
	                          />
	                        ) : (
	                          <Package className="h-4 w-4" aria-hidden="true" />
	                        )}
	                      </span>
	                      <span className="delegate-product-picker-copy">
	                        <span className="delegate-product-picker-name">{item.name}</span>
	                        <span className="delegate-product-picker-meta">
	                          {[item.sku ? `SKU ${item.sku}` : null, item.researchDomains[0]?.name || null, item.inStock ? null : 'Out of stock']
	                            .filter(Boolean)
	                            .join(' · ')}
	                        </span>
	                      </span>
	                    </label>
	                  );
	                })
	              )}
	            </div>
	            <div className="delegate-product-picker-footer">
	              <Button
	                type="button"
	                variant="outline"
	                onClick={closePatientLinkProductPicker}
	                className="delegate-product-picker-done-button header-home-button squircle-sm bg-white text-slate-900"
	              >
	                Done
	              </Button>
	            </div>
	          </ModalSquircle>
	        </div>,
	        document.body,
	      )}

				      <details
	            className="delegate-white-label-details glass-card squircle-lg border border-[var(--brand-glass-border-1)] bg-white/80 p-6 sm:p-7"
	            style={{ order: 3 }}
	          >
		        <summary className="delegate-white-label-summary">
		          <span className="delegate-white-label-summary-copy">
		            <span className="flex items-center gap-2 text-lg font-semibold text-slate-900">
		              <SwatchIcon className="h-5 w-5" aria-hidden="true" />
		              <span>White label your sessions</span>
		            </span>
		            <span className="mb-1 block text-sm leading-relaxed text-slate-700">
		              Customize the logo, colors, and background authorized delegates see in proposal sessions.
		            </span>
		          </span>
		          <span className="delegate-white-label-summary-icon" aria-hidden="true" />
		        </summary>
		        <div className="delegate-white-label-content mt-4 space-y-2">
		          <div className="delegate-logo-summary-row rounded-xl px-4 py-4">
	            <div className="delegate-logo-summary-copy">
	              <p className="text-sm font-semibold text-slate-900 truncate">
	                {typeof localUser?.delegateLogoUrl === 'string' && localUser.delegateLogoUrl.trim().length > 0
	                  ? 'Custom logo set'
	                  : 'Using TrufusionLabs logo'}
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
	                className="header-home-button delegate-logo-summary-button delegate-logo-summary-button--upload h-11 squircle-sm gap-2 bg-white px-7 text-slate-900"
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
	                className="header-home-button patient-link-payment-toggle-button delegate-logo-summary-button delegate-logo-summary-button--remove h-11 squircle-sm bg-white text-slate-900"
	              >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
	              </Button>
	            </div>
	          </div>

	          <div className="delegate-logo-summary-row rounded-xl px-4 py-4">
	            <div className="delegate-logo-summary-copy">
	              <p className="text-sm font-semibold text-slate-900 truncate">
	                {delegatePreviewBackgroundImageUrl ? 'Custom background image set' : 'Using color background'}
	              </p>
	              <p className="text-xs text-slate-600">Images appear over the selected background color.</p>
	            </div>
	            <input
	              ref={delegateBackgroundImageInputRef}
	              type="file"
	              accept=".png,image/png,.jpg,.jpeg,image/jpeg,.webp,image/webp,image/*"
	              className="hidden"
	              onChange={(event) => void handleSelectDelegateBackgroundImage(event.target.files?.[0] ?? null)}
	            />
	            <div className="delegate-logo-summary-actions">
	              <Button
	                type="button"
	                variant="outline"
	                onClick={() => delegateBackgroundImageInputRef.current?.click()}
	                disabled={delegateBackgroundImageUploading}
	                className="header-home-button delegate-logo-summary-button delegate-logo-summary-button--upload h-11 squircle-sm gap-2 bg-white px-7 text-slate-900"
	              >
	                <Upload className="h-4 w-4" aria-hidden="true" />
		                {delegateBackgroundImageUploading ? 'Uploading…' : 'Upload background'}
	              </Button>
	              <Button
	                type="button"
	                variant="outline"
	                onClick={() => void handleRemoveDelegateBackgroundImage()}
	                disabled={delegateBackgroundImageUploading || !delegatePreviewBackgroundImageUrl}
	                aria-label="Remove background image"
	                className="header-home-button patient-link-payment-toggle-button delegate-logo-summary-button delegate-logo-summary-button--remove h-11 squircle-sm bg-white text-slate-900"
	              >
	                <Trash2 className="h-4 w-4" aria-hidden="true" />
	              </Button>
	            </div>
	          </div>

	          <div className="delegate-session-appearance rounded-xl px-4 py-4">
	            <div className="delegate-color-controls-grid">
	              <div className="delegate-color-control">
	                <Label htmlFor="delegate-background-color" className="delegate-color-control-label text-sm font-bold text-slate-700">
	                  Your background color
	                </Label>
	                <p className="mt-1 text-xs text-slate-500">Visible as a substitute or supplement to the background image.</p>
	                <div className="delegate-color-value-row">
	                  <input
	                    id="delegate-background-color"
	                    type="color"
	                    value={delegatePreviewBackgroundColorHex}
	                    disabled={delegateBackgroundColorSaving}
	                    onChange={(event) => void handleDelegateBackgroundColorChange(event.target.value)}
	                    className="delegate-color-input"
	                    style={{ border: 0 }}
	                  />
	                  <div className="min-w-0">
	                    <p className="text-sm font-semibold text-slate-900">{delegatePreviewBackgroundColorHex.toUpperCase()}</p>
	                    {delegateBackgroundColorSaving ? (
	                      <p className="text-xs text-slate-600">Saving color…</p>
	                    ) : null}
	                  </div>
	                </div>
	              </div>
	              <div className="delegate-color-control">
	                <Label htmlFor="delegate-secondary-color" className="delegate-color-control-label text-sm font-bold text-slate-700">
	                  Your primary color
	                </Label>
	                <p className="mt-1 text-xs text-slate-500">Used for header accents and session highlights.</p>
	                <div className="delegate-color-value-row">
	                  <input
	                    id="delegate-secondary-color"
	                    type="color"
	                    value={delegatePreviewSecondaryHex}
	                    disabled={delegateSecondaryColorSaving}
	                    onChange={(event) => void handleDelegateSecondaryColorChange(event.target.value)}
	                    className="delegate-color-input"
	                    style={{ border: 0 }}
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

			          <div className="delegate-white-label-preview-card glass-card squircle-lg p-3 !border-0">
			            <p className="delegate-preview-label text-xs font-semibold text-slate-700">Header preview</p>
			            <div className="delegate-header-preview-scroll w-full max-w-full overflow-x-auto overflow-y-hidden">
	              <div
	                className="delegate-header-preview-canvas app-header-blur shadow-sm rounded-xl px-4 sm:px-6 py-4"
	                style={{
	                  '--delegate-header-preview-primary-color': delegatePreviewSecondaryColor,
	                  '--header-search-border-color': delegatePreviewSecondaryColor,
	                } as CSSProperties}
	              >
	                <div className="flex flex-col gap-3 md:gap-4">
	                  <div className="flex w-full min-w-0 items-center gap-3 sm:gap-4 justify-between flex-nowrap">
	                    <div className="flex items-center gap-3 min-w-0">
	                      <div
	                        className="brand-logo relative flex items-center justify-start flex-shrink min-w-0"
	                        style={{ height: logoSizing.heightPx, maxWidth: logoSizing.maxWidth }}
	                      >
	                        <img
		                          src={
		                            typeof localUser?.delegateLogoUrl === 'string' && localUser.delegateLogoUrl.trim().length > 0
		                              ? localUser.delegateLogoUrl
		                              : withStaticAssetStamp('/TrufusionLabs_PhysiciansPortal.png')
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

	                    <div className="delegate-header-preview-search-field flex flex-1 justify-center min-w-0 pointer-events-none">
	                        <div className="w-full min-w-0 max-w-md">
	                          {renderSearchField('delegate-header-preview-search-input', {
	                            value: '',
	                            readOnly: true,
	                            showClearButton: false,
	                            borderColor: delegatePreviewSecondaryColor,
	                            textColor: HEADER_SEARCH_TEXT_GREY,
		                          })}
	                        </div>
	                      </div>

                    <div className="delegate-auth-controls delegate-auth-controls--preview ml-auto flex w-auto items-center justify-end gap-2 min-w-0 max-w-full">
                      <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-hidden="true"
                          tabIndex={-1}
                          className="delegate-header-preview-search-button glass squircle-sm pointer-events-none"
                          style={{
                            '--delegate-header-preview-primary-color': delegatePreviewSecondaryColor,
                            color: HEADER_SEARCH_TEXT_GREY,
                            borderColor: delegatePreviewSecondaryColor,
                          } as CSSProperties}
                        >
                          <Search className="h-4 w-4" style={{ color: HEADER_SEARCH_TEXT_GREY }} />
                        </Button>
                      <div
                        className="delegate-auth-label squircle-sm inline-flex items-center justify-end gap-2 select-none cursor-default min-w-0 max-w-[58vw] sm:max-w-[20rem] flex-shrink overflow-hidden px-4 py-2 sm:px-5 sm:py-2.5 text-sm sm:text-base border-0 !border-0 !bg-transparent"
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
				            </div>
			          </div>
			        </div>
			      </div>
		            </div>
		          </div>

			          <div className="delegate-white-label-preview-card glass-card squircle-lg p-3 !border-0">
			            <p className="delegate-preview-label text-xs font-semibold text-slate-700">Background preview</p>
		            <div
		              className="delegate-session-background-preview overflow-hidden rounded-xl shadow-sm"
		              aria-hidden="true"
		              style={{
		                '--delegate-preview-background-color': delegatePreviewBackgroundColorHex,
		                '--delegate-preview-background-image': delegatePreviewBackgroundImageCss,
		              } as CSSProperties}
			            />
			          </div>
		        </div>
	      </details>

		      <div className="space-y-3" style={{ order: 2 }}>
		        <div
            className="glass-card squircle-lg border border-[var(--brand-glass-border-1)] bg-white/70 p-6 sm:p-7 space-y-1"
          >
	        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		          <h3 className="shrink-0 whitespace-nowrap pr-3 text-lg font-semibold leading-tight text-slate-900">Manage your links</h3>
            <div className="patient-links-toolbar-controls flex w-full flex-col gap-2 sm:flex-1 sm:flex-row sm:items-center sm:justify-end">
	              {delegateLinkCreationEnabled && (
	                <>
	                  <label htmlFor="patient-links-type-filter" className="sr-only">
	                    Filter links by type
	                  </label>
	                  <select
	                    id="patient-links-type-filter"
	                    value={patientLinksTypeFilter}
	                    onChange={(event) => setPatientLinksTypeFilter(event.target.value as PatientLinkTypeFilter)}
	                    className="patient-links-toolbar-control patient-link-payment-method-select patient-links-type-filter-shadow h-9 min-w-[10.5rem] squircle-sm bg-white text-sm font-semibold"
	                  >
	                    <option value="all">All links ({patientLinksTypeCounts.all})</option>
	                    <option value="delegate">Proposal ({patientLinksTypeCounts.delegate})</option>
	                    <option value="brochure">Brochure ({patientLinksTypeCounts.brochure})</option>
	                  </select>
	                </>
	              )}
              <div className="patient-links-toolbar-button-row flex w-full flex-row items-center justify-between gap-2 sm:w-auto sm:justify-end">
		              {patientLinksLoading && (
		                <div
		                  className="patient-links-toolbar-control inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-500"
		                  aria-live="polite"
		                >
		                  <span>Auto-updating</span>
		                </div>
		              )}
		            <Button
		              type="button"
			              onClick={() => {
	                    setPatientLinkEditing(null);
			                setCreateLinkDialogMode(showCreateLinkTypeChooser ? 'select' : 'brochure');
	                    if (!showCreateLinkTypeChooser) {
	                      setPatientLinkBrochureNameDraft('');
	                      setPatientLinkProductScopeDraft('all_physician_approved');
	                    }
			                setCreateLinkDialogOpen(true);
			              }}
		              disabled={!hasCreateLinkTypeOptions}
		              className="patient-links-toolbar-control header-home-button inline-flex h-9 min-h-9 min-w-0 max-w-full flex-none items-center justify-center gap-2 whitespace-nowrap squircle-sm bg-white px-4 text-sm text-slate-900"
		            >
		              <Plus className="h-4 w-4" aria-hidden="true" />
		              Create a link
		            </Button>
            </div>
          </div>
	        </div>

        {patientLinksError && (
          <div className="glass-card squircle-md p-4 border border-red-200 bg-red-50/60">
            <p className="text-sm text-red-700 font-medium">{patientLinksError}</p>
          </div>
        )}

	        {patientLinksLoading && patientLinks.length === 0 ? (
	          <div className="glass-card squircle-lg p-6 border border-[var(--brand-glass-border-1)] bg-white/80">
	            <p className="text-sm text-slate-600">Loading links…</p>
	          </div>
	        ) : patientLinks.length === 0 ? (
	          <div className="glass-card squircle-lg p-6 border border-[var(--brand-glass-border-1)] bg-white/80">
	            <div className="flex items-center justify-between gap-3">
		              <p className="text-sm font-semibold text-slate-900">No links yet.</p>
		              <p className="text-sm text-slate-600">Create a link to get started.</p>
	            </div>
	          </div>
	        ) : filteredPatientLinks.length === 0 ? (
	          <div className="glass-card squircle-lg p-6 border border-[var(--brand-glass-border-1)] bg-white/80">
	            <div className="flex items-center justify-between gap-3">
			              <p className="text-sm font-semibold text-slate-900">
	                    {patientLinksTypeFilter === 'brochure'
	                      ? 'No brochure links.'
	                      : patientLinksTypeFilter === 'delegate'
	                        ? 'No proposal links.'
	                        : 'No links match this filter.'}
	                  </p>
		              <p className="text-sm text-slate-600">Change the filter to view other link types.</p>
	            </div>
	          </div>
	        ) : (
	          <div className="space-y-4 pt-1">
		            {filteredPatientLinks.map((link) => {
		              const token = typeof link?.token === 'string' ? link.token : '';
		              const subjectLabel =
		                (typeof (link as any)?.subjectLabel === 'string' && (link as any).subjectLabel.trim())
		                  ? (link as any).subjectLabel.trim()
		                  : (typeof link?.patientId === 'string' && link.patientId.trim())
		                    ? link.patientId.trim()
		                    : (typeof (link as any)?.patient_id === 'string' && (link as any).patient_id.trim())
		                      ? (link as any).patient_id.trim()
		                      : '';
                  const linkName =
                    (typeof (link as any)?.linkName === 'string' && (link as any).linkName.trim())
                      ? (link as any).linkName.trim()
                      : (typeof (link as any)?.link_name === 'string' && (link as any).link_name.trim())
                        ? (link as any).link_name.trim()
                        : subjectLabel
                          ? subjectLabel
                          : (typeof link?.referenceLabel === 'string' && link.referenceLabel.trim())
                            ? link.referenceLabel.trim()
                            : (typeof (link as any)?.reference_label === 'string' && (link as any).reference_label.trim())
                              ? (link as any).reference_label.trim()
                              : (typeof link?.label === 'string' && link.label.trim())
                                ? link.label.trim()
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
		                    : '';
                  const brochureName =
                    typeof (link as any)?.brochureName === 'string' && (link as any).brochureName.trim()
                      ? (link as any).brochureName.trim()
                      : typeof (link as any)?.brochure_name === 'string' && (link as any).brochure_name.trim()
                        ? (link as any).brochure_name.trim()
                        : '';
			              const linkType = normalizePatientLinkType(link);
			              const linkTypeLabel = getPatientLinkTypeLabel(linkType);
					              const LinkTypeIcon = linkType === 'brochure' ? BookOpenIcon : CursorArrowRippleIcon;
			              const isDelegateLinkType = linkType === 'delegate';
			              const label =
                      linkType === 'brochure'
                        ? (linkName || brochureName || studyLabel || `${linkTypeLabel} link`)
                        : (linkName || studyLabel || subjectLabel || patientReference || `${linkTypeLabel} link`);
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
                  const linkLifespanLabel =
                    createdAt || expiresAt
                      ? `${createdAt ? (formatLinkDateTime(createdAt) || createdAt) : 'Unknown'} - ${
                          expiresAt ? (formatLinkDateTime(expiresAt) || expiresAt) : 'No expiration'
                        }`
                      : '';
		              const lastUsedAt = typeof link?.lastUsedAt === 'string' && link.lastUsedAt.trim() ? link.lastUsedAt.trim() : '';
		              const statusRaw =
		                typeof (link as any)?.status === 'string' && (link as any).status.trim()
		                  ? (link as any).status.trim().toLowerCase()
		                  : '';
		              const allowedProducts = Array.isArray((link as any)?.allowedProducts)
		                ? (link as any).allowedProducts.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
		                : [];
		              const allowedProductsDisplay = formatAllowedProductsForDisplay(allowedProducts);
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
		              const openCountRaw =
		                typeof (link as any)?.openCount === 'number'
		                  ? (link as any).openCount
		                  : typeof (link as any)?.openCount === 'string'
		                    ? Number((link as any).openCount)
		                    : typeof (link as any)?.open_count === 'number'
		                      ? (link as any).open_count
		                    : typeof (link as any)?.open_count === 'string'
		                        ? Number((link as any).open_count)
		                        : 0;
		              const usageCountValue = Number.isFinite(usageCountRaw) ? Number(usageCountRaw) : 0;
		              const openCountValue = Number.isFinite(openCountRaw) ? Number(openCountRaw) : 0;
		              const viewCountRaw =
		                typeof (link as any)?.viewCount === 'number'
		                  ? (link as any).viewCount
		                  : typeof (link as any)?.viewCount === 'string'
		                    ? Number((link as any).viewCount)
		                    : typeof (link as any)?.view_count === 'number'
		                      ? (link as any).view_count
		                      : typeof (link as any)?.view_count === 'string'
		                        ? Number((link as any).view_count)
		                        : openCountValue;
		              const viewCountValue = Number.isFinite(viewCountRaw) ? Number(viewCountRaw) : openCountValue;
                  const lastViewedAt =
                    typeof (link as any)?.lastViewedAt === 'string' && (link as any).lastViewedAt.trim()
                      ? (link as any).lastViewedAt.trim()
                      : typeof (link as any)?.last_viewed_at === 'string' && (link as any).last_viewed_at.trim()
                        ? (link as any).last_viewed_at.trim()
                        : lastUsedAt;
                  const recipientName =
                    typeof (link as any)?.recipientName === 'string' && (link as any).recipientName.trim()
                      ? (link as any).recipientName.trim()
                      : typeof (link as any)?.recipient_name === 'string' && (link as any).recipient_name.trim()
                        ? (link as any).recipient_name.trim()
                        : '';
                  const recipientContact =
                    typeof (link as any)?.recipientContact === 'string' && (link as any).recipientContact.trim()
                      ? (link as any).recipientContact.trim()
                      : typeof (link as any)?.recipient_contact === 'string' && (link as any).recipient_contact.trim()
                        ? (link as any).recipient_contact.trim()
                        : '';
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
                  const proposalReviewOrderId =
                    typeof (link as any)?.delegateReviewOrderId === 'string' && (link as any).delegateReviewOrderId.trim()
                      ? (link as any).delegateReviewOrderId.trim()
                      : typeof (link as any)?.proposalReviewOrderId === 'string' && (link as any).proposalReviewOrderId.trim()
                        ? (link as any).proposalReviewOrderId.trim()
                        : typeof (link as any)?.delegate_review_order_id === 'string' && (link as any).delegate_review_order_id.trim()
                          ? (link as any).delegate_review_order_id.trim()
                          : typeof (link as any)?.proposal_review_order_id === 'string' && (link as any).proposal_review_order_id.trim()
                            ? (link as any).proposal_review_order_id.trim()
                            : '';
                  const delegateShipping =
                    (link as any)?.delegateShipping && typeof (link as any).delegateShipping === 'object'
                      ? (link as any).delegateShipping
                      : (link as any)?.delegate_shipping && typeof (link as any).delegate_shipping === 'object'
                        ? (link as any).delegate_shipping
                        : null;
                  const delegatePayment =
                    (link as any)?.delegatePayment && typeof (link as any).delegatePayment === 'object'
                      ? (link as any).delegatePayment
                      : (link as any)?.delegate_payment && typeof (link as any).delegate_payment === 'object'
                        ? (link as any).delegate_payment
                        : null;
                  const amountDueRaw =
                    delegatePayment?.amountDue
                    ?? delegatePayment?.amount_due
                    ?? delegatePayment?.paymentTrackerAmount
                    ?? delegateShipping?.grandTotal
                    ?? delegateShipping?.grand_total
                    ?? null;
                  const amountDueValue = Number(amountDueRaw);
                  const amountDue =
                    Number.isFinite(amountDueValue) && amountDueValue >= 0
                      ? amountDueValue
                      : null;
                  const amountDueCurrencyRaw =
                    typeof delegatePayment?.amountDueCurrency === 'string'
                      ? delegatePayment.amountDueCurrency
                      : typeof delegatePayment?.amount_due_currency === 'string'
                        ? delegatePayment.amount_due_currency
                        : 'USD';
                  const amountDueCurrency = amountDueCurrencyRaw.trim() || 'USD';
                  const paymentTrackerAmountLabel =
                    amountDue != null
                      ? formatCurrency(amountDue, amountDueCurrency)
                      : null;
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
	              const hasProposal = isDelegateLinkType && Boolean(reviewStatus || delegateSharedAt || delegateOrderId);
		              const isRevoked = isPatientLinkRevoked(link);
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
		                proposalStatus === 'approved' || proposalStatus === 'accepted' || proposalStatus === 'modified'
		                  ? 'Approved'
	                    : proposalStatus === 'rejected'
	                      ? 'Rejected'
	                      : proposalStatus === 'pending'
		                        ? 'Pending review'
		                        : '';
			              const proposalActionLabel =
			                proposalStatus === 'approved' || proposalStatus === 'accepted' || proposalStatus === 'modified' || proposalStatus === 'rejected'
			                  ? 'Proposal'
			                  : 'Review Proposal';
	                  const linkStatusLabel = isRevoked
	                    ? 'Revoked'
	                    : hasProposal
	                      ? (proposalLabel || 'Pending review')
	                      : statusRaw
	                        ? statusRaw.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
	                        : 'Active';
	                  const linkStatusClassName =
	                    isRevoked || proposalStatus === 'rejected'
	                      ? 'border-red-200 bg-red-50 text-red-700'
	                      : proposalStatus === 'approved' || proposalStatus === 'accepted' || proposalStatus === 'modified'
	                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
	                        : proposalStatus === 'pending'
	                          ? 'border-amber-200 bg-amber-50 text-amber-800'
	                          : 'border-slate-200 bg-white/80 text-slate-700';
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
				                  className="patient-link-item glass-liquid squircle-lg border border-[rgba(11,6,121,0.35)] transition-colors hover:border-[rgba(11,6,121,0.55)] p-4 sm:p-5 flex flex-col gap-3 sm:gap-4 sm:flex-row sm:items-start sm:justify-between"
				                >
			                  <div className="min-w-0 flex-1">
				                    <div className="flex items-center gap-2">
					                      <LinkTypeIcon className="h-5 w-5 text-[rgb(11,6,121)] shrink-0" aria-hidden="true" />
					                      <span className="font-semibold text-slate-900 truncate">{label}</span>
	                                  <Badge variant="outline" className="patient-link-type-badge border-[rgba(11,6,121,0.25)] bg-white/70 text-[rgb(11,6,121)]">
	                                    {linkTypeLabel}
	                                  </Badge>
	                                  <Badge
	                                    variant="outline"
	                                    className={clsx(
	                                      'border text-sm font-semibold leading-none sm:text-base',
	                                      linkStatusClassName,
	                                    )}
	                                  >
	                                    {linkStatusLabel}
	                                  </Badge>
				                    </div>
		                    <div className="mt-1 text-xs text-slate-600 space-y-0.5">
			                      {subjectLabel && <div>Subject: {subjectLabel}</div>}
			                      {linkType === 'brochure' && recipientName && <div>Recipient: {recipientName}</div>}
			                      {linkType === 'brochure' && recipientContact && <div>Recipient contact: {recipientContact}</div>}
			                      {studyLabel && <div>Study: {studyLabel}</div>}
			                      {patientReference && <div>Reference: {patientReference}</div>}
			                      {linkLifespanLabel && <div className="patient-link-lifespan">Link lifespan: {linkLifespanLabel}</div>}
			                      {linkType === 'brochure'
                              ? lastViewedAt && <div>Last viewed: {formatLinkDateTime(lastViewedAt) || lastViewedAt}</div>
                              : lastUsedAt && <div>Last used: {formatLinkDateTime(lastUsedAt) || lastUsedAt}</div>}
			                      {linkType === 'brochure' ? <div>Viewed: {viewCountValue}</div> : <div>Open Count: {openCountValue}</div>}
			                      {isDelegateLinkType && <div>Uses: {usageCountValue}</div>}
			                      {allowedProductsDisplay.length > 0 && <div>Allowed SKUs: {allowedProductsDisplay.join(', ')}</div>}
			                      {linkType === 'brochure' && <div>View-only product information. No pricing, cart, or checkout.</div>}
			                      {isDelegateLinkType && <div>Payment: {paymentMethodLabel}</div>}
			                      {isDelegateLinkType && <div>Markup: {Math.round((markupPercentValue + Number.EPSILON) * 100) / 100}%</div>}
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
                                  linkType: 'delegate',
                                  tokenHint: token ? token.split('-', 1)[0].slice(0, 16) : undefined,
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
		                      onClick={() => {
                            if (isRevoked) {
                              void handleModifyPatientLink(token, false);
                              return;
                            }
                            handleRequestPatientLinkConfirmAction('modify', token, label, linkType);
                          }}
		                      disabled={!token || isUpdating || isDeleting || patientLinksCreating}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
	                    >
	                      {isUpdating ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        )}
	                      Modify
	                    </Button>
		                      <Button
		                        type="button"
		                      variant="outline"
		                      size="sm"
			                      onClick={() => handleViewPatientLink(token, linkType, label)}
		                      disabled={!token}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
	                    >
	                      <Eye className="h-4 w-4" aria-hidden="true" />
	                      {linkType === 'brochure' ? 'Preview brochure' : 'Preview session'}
	                    </Button>
		                      <Button
		                        type="button"
		                      variant="outline"
		                      size="sm"
			                      onClick={() => void handleCopyPatientLink(token, linkType, label)}
		                      disabled={!token}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
	                    >
	                      <Copy className="h-4 w-4" aria-hidden="true" />
	                      {linkType === 'brochure' ? 'Copy brochure link' : 'Copy proposal link'}
	                    </Button>
	                      <Button
	                        type="button"
		                      variant="outline"
		                      size="sm"
		                      onClick={() => {
                            if (isRevoked) {
                              handleRequestPatientLinkConfirmAction('delete', token, label, linkType);
                              return;
                            }
                            handleRequestPatientLinkConfirmAction('revoke', token, label, linkType);
                          }}
		                      disabled={!token || isUpdating || isDeleting}
		                      className="header-home-button patient-link-payment-toggle-button squircle-sm gap-2 bg-white text-slate-900"
                          aria-label={isRevoked ? 'Delete revoked link permanently' : 'Revoke link'}
                          title={isRevoked ? 'Delete permanently' : 'Revoke link'}
		                    >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : isRevoked ? (
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <>
                              <ArrowUturnLeftIcon className="h-4 w-4" aria-hidden="true" />
                              Revoke link
                            </>
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
                              {paymentTrackerAmountLabel && (
                                <span className="mt-1 text-xs font-semibold text-slate-900 whitespace-normal break-words">
                                  Amount due: {paymentTrackerAmountLabel}
                                </span>
                              )}
                              {!paymentTrackerAmountLabel && proposalReviewOrderId && (
                                <span className="mt-1 text-xs font-medium text-slate-500 whitespace-normal break-words">
                                  Final proposal amount will appear after this link refreshes.
                                </span>
                              )}
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
                                  className="min-h-[72px] resize-y squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
                                />
                                <div className="flex items-center mb-1 justify-between gap-2">
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
	                                        Revert
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
				                    {isDelegateLinkType && (
				                    <details className="patient-link-settings-details mt-0 w-full rounded-xl bg-white/70 px-3 py-2">
			                      <summary className="patient-link-settings-summary">
			                        Payment settings (proposal)
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
	                                  || existing.trim() === currentDefault.trim()
	                                  || isGeneratedPatientLinkDefaultInstructions(existing, localUser?.name ?? user?.name ?? null);
	                                if (!shouldReplace) return { ...prev, [token]: existing };
	                                return {
	                                  ...prev,
	                                  [token]: buildPatientLinkDefaultInstructions(next, localUser?.zelleContact ?? null, localUser?.name ?? user?.name ?? null),
	                                };
	                              });
	                            }}
		                            className="patient-link-payment-method-select h-10 w-full squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
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
	                            className="min-h-[56px] resize-y squircle-sm glass focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.25)]"
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
                            )}
		                  </div>
		                </div>
		              );
            })}
	          </div>
	        )}
	      </div>
	      </div>
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
    if (raw.toLowerCase() === 'doctor' || raw.toLowerCase() === 'physician') return 'Physician';
    return `Dr. ${raw}`;
  })();

		  const authControls = delegateMode ? (
		    <div className="delegate-auth-controls ml-auto flex items-center justify-end gap-2 min-w-0 max-w-full">
			      <div
			        className="delegate-auth-label squircle-sm inline-flex items-center justify-end gap-2 select-none cursor-default min-w-0 max-w-[58vw] sm:max-w-[20rem] flex-shrink overflow-hidden px-4 py-2 sm:px-5 sm:py-2.5 text-sm sm:text-base border-0 !border-0 !bg-transparent"
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
      {showInfoHeaderWelcome && (
        <div className="info-header-welcome">
          <p className="info-header-welcome__text">
            {infoHeaderWelcomeText}
          </p>
        </div>
      )}
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
	              onClick={() => {
                  if (delegateLinksGuideStep === 'account') {
                    onDelegateLinksGuideAccountClick?.();
                  }
                  setWelcomeOpen(true);
                }}
	              className={clsx(
                  "relative overflow-visible squircle-sm header-home-button transition-all duration-300 whitespace-nowrap pl-1 pr-0 header-account-button justify-start",
                  delegateLinksGuideStep === 'account' && "delegate-links-guide-highlight",
                )}
		              aria-haspopup="dialog"
		              aria-expanded={welcomeOpen}
                  style={{ borderColor: HEADER_BRAND_BLUE, color: HEADER_BRAND_BLUE }}
		            >
	              <span className="header-account-name text-current">
                  {headerDisplayName}
                </span>
	              <span className="header-account-avatar-shell">
	                {renderAvatar(isLargeScreen ? 48 : 53, 'header-account-avatar')}
                  {accountButtonIndicatorTotal > 0 && (
                    <span
                      className="header-action-count-badge header-account-count-badge account-indicator-badge header-count-indicator"
                      aria-label={`Notifications: ${accountButtonIndicatorTotal}`}
                      title={`Notifications: ${accountButtonIndicatorTotal}`}
                    >
                      {accountButtonIndicatorTotal > 9 ? '9+' : accountButtonIndicatorTotal}
                    </span>
                  )}
	              </span>
            </Button>
			          </DialogTrigger>
					        <DialogContent
                    hideCloseButton
					          className="checkout-modal account-modal glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
                    overlayClassName="bg-slate-950/40"
                    containerClassName="account-modal-layer fixed inset-0 z-[13000] flex items-start justify-center px-3 py-6 sm:px-4 sm:py-8"
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
	                "account-modal-header sticky top-0 z-10 border-b border-[var(--brand-glass-border-1)] bg-transparent px-6 py-4 flex items-start justify-between gap-4 transition-opacity duration-300 ease-in-out",
	                isResearchFullscreen && "opacity-0 invisible pointer-events-none select-none",
	              )}
            >
            <div className="flex-1 min-w-0 max-w-full space-y-3 account-header-content">
	            <div className="flex items-center gap-3 flex-wrap min-w-0">
	              <DialogTitle className="text-xl font-semibold header-user-name min-w-0 truncate">
	                  {accountModalRoleLabel ? `${accountModalDisplayName} | ${accountModalRoleLabel}` : accountModalDisplayName}
	                </DialogTitle>
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
	                            isActive && 'text-slate-900',
                              delegateLinksGuideStep === 'delegate_tab' && tab.id === 'patient_links' && 'delegate-links-guide-highlight'
	                          )}
                          data-tab={tab.id}
                          aria-pressed={isActive}
	                          onClick={() => {
                              if (tab.id === 'patient_links' && delegateLinksGuideStep === 'delegate_tab') {
                                onDelegateLinksGuideTabClick?.();
                              }
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
				                            <tab.Icon className="account-tab-icon" aria-hidden="true" />
			                          </span>
                          <span className="inline-flex items-center">
                            {tab.label}
                            {tab.id === 'patient_links' && showPatientLinksBetaLabel && (
                              <span
                                className="delegate-links-beta-chip"
                                aria-label="Beta"
                              >
                                beta
                              </span>
                            )}
                            {showIndicator && (
                              <span
                                className={clsx(
                                  "patient-links-tab-count ml-2 inline-flex shrink-0 items-center justify-center !p-0 text-sm !text-[rgb(11,6,121)] font-semibold leading-none pointer-events-none transition-opacity duration-150",
                                  showIndicator ? "opacity-100" : "opacity-0",
                                )}
                                title={`${tab.label} notifications`}
                                aria-label={showIndicator ? `${tab.label} notifications: ${indicatorCount}` : undefined}
                                aria-hidden={showIndicator ? undefined : true}
                                style={{ color: 'rgb(11,6,121)' }}
                              >
                                {showIndicator ? (indicatorCount > 9 ? '9+' : indicatorCount) : ''}
                              </span>
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
            <DialogClose
              className="dialog-close-btn inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full p-0 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              style={{
                backgroundColor: 'rgb(11, 6, 121)',
                borderRadius: '50%',
              }}
              aria-label="Close account modal"
            >
              <X className="h-4 w-4 text-white" />
            </DialogClose>
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
      <Dialog open={Boolean(patientLinkConfirmAction)} onOpenChange={handlePatientLinkConfirmOpenChange}>
        <DialogContent
          className="glass-card squircle-lg w-full !max-w-[min(448px,calc(100vw-3rem))] sm:!max-w-[min(448px,calc(100vw-3rem))] lg:!max-w-[min(448px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 overflow-hidden"
          overlayClassName="bg-slate-950/40"
          containerClassName="account-modal-layer fixed inset-0 z-[14000] flex items-center justify-center p-4 sm:p-6"
          style={{
            backdropFilter: "blur(32px) saturate(1.45)",
            backgroundColor: "rgba(245, 251, 255, 0.98)",
            width: "min(448px, calc(100vw - 3rem))",
            maxWidth: "min(448px, calc(100vw - 3rem))",
          }}
        >
          <DialogHeader className="border-b border-[var(--brand-glass-border-1)] px-6 py-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-lg font-semibold text-slate-900">
                  {patientLinkConfirmAction?.action === 'delete'
                    ? 'Delete this link?'
                    : patientLinkConfirmAction?.action === 'modify'
                      ? 'Modify this link?'
                      : 'Revoke this link?'}
                </DialogTitle>
                <DialogDescription className="mt-1 text-sm leading-6 text-slate-600">
                  {patientLinkConfirmAction?.action === 'delete'
                    ? 'This permanently removes the revoked link from your dashboard. This cannot be undone.'
                    : patientLinkConfirmAction?.action === 'modify'
                      ? 'Are you sure? Modifying this link will temporarily revoke it.'
                      : 'This immediately disables the public URL. Anyone with the link will no longer be able to open it.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-xl border border-slate-200 bg-white/75 px-4 py-3">
              <p className="text-sm font-semibold text-slate-900">
                {patientLinkConfirmAction?.label || 'Link'}
              </p>
              <p className="mt-1 text-xs font-medium uppercase tracking-[0.08em] text-slate-500">
                {patientLinkConfirmAction
                  ? `${getPatientLinkTypeLabel(patientLinkConfirmAction.linkType)} Link`
                  : 'Link'}
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="header-home-button squircle-sm bg-white text-slate-900"
                disabled={patientLinkConfirmBusy}
                onClick={() => {
                  if (!patientLinkConfirmBusy) {
                    setPatientLinkConfirmAction(null);
                  }
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle-sm border-red-200 bg-red-50 text-red-700 hover:bg-red-600 hover:text-white"
                disabled={!patientLinkConfirmAction || patientLinkConfirmBusy}
                onClick={() => void handleConfirmPatientLinkAction()}
              >
                {patientLinkConfirmBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {patientLinkConfirmBusy
                  ? patientLinkConfirmAction?.action === 'delete'
                    ? 'Deleting...'
                    : patientLinkConfirmAction?.action === 'modify'
                      ? 'Revoking...'
                    : 'Revoking...'
                  : patientLinkConfirmAction?.action === 'delete'
                    ? 'Delete link'
                    : patientLinkConfirmAction?.action === 'modify'
                      ? 'Okay'
                      : 'Revoke link'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
	      <Dialog open={deleteAccountModalOpen} onOpenChange={handleDeleteAccountModalOpenChange}>
	        <DialogContent
	          className="glass-card squircle-lg w-full !max-w-[min(468px,calc(100vw-3rem))] sm:!max-w-[min(468px,calc(100vw-3rem))] lg:!max-w-[min(468px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 overflow-hidden"
	          overlayClassName="bg-slate-950/40"
	          containerClassName="account-modal-layer fixed inset-0 z-[13000] flex items-center justify-center p-4 sm:p-6"
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
	              By deleting your account, you understand that all of your data stored within TrufusionLabs databases will be lost except anything publically available to the network on TrufusionLabs&apos;s research services or otherwise. For those publications, it is your responsibility to fascilitate closure, and if you need further assistance after account suspension contact support@trufusionlabs.com.
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
	                className="squircle-sm border-[rgba(11,6,121,0.35)] text-[rgb(11,6,121)] hover:bg-[rgb(11,6,121)] hover:text-white"
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
          className="logout-thanks-modal relative duration-[250ms] data-[state=closed]:duration-[250ms] !max-w-[min(28rem,calc(100vw-2rem))]"
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
	          containerClassName="logout-thanks-layer fixed inset-0 z-[12000] flex items-center justify-center px-6 py-6 md:px-10 md:py-10"
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
              Thank you for being a partner of ours and a joy to those around you. We at TrufusionLabs wish you a great rest
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
	              <DialogTitle className="text-xl font-semibold text-[rgb(11,6,121)]">
	                {authMode === 'login'
                    ? 'Welcome back'
                    : authMode === 'verify'
                      ? 'Verify your email'
                      : 'Create Account'}
	              </DialogTitle>
	              <DialogDescription>
	                {authMode === 'login'
	                  ? 'Login to enter your TrufusionLabs account.'
                    : authMode === 'verify'
                      ? 'Complete email verification before signing in.'
	                  : 'Create your TrufusionLabs physician account to access TrufusionLabs.'}
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
                backgroundColor: 'rgb(11, 6, 121)',
                borderRadius: '50%',
              }}
              aria-label="Close account modal"
            >
              <X className="h-4 w-4 text-white" />
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
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
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
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.12)] btn-hover-lighter"
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
                {loginError && unverifiedLoginEmail && (
                  <div className="text-sm text-gray-600">
                    <button
                      type="button"
                      disabled={verificationResendPending || !onResendVerificationEmail}
                      onClick={async () => {
                        if (!onResendVerificationEmail) return;
                        setVerificationResendPending(true);
                        setVerificationResendSent(false);
                        try {
	                          await onResendVerificationEmail(unverifiedLoginEmail);
	                          setVerificationResendSent(true);
                            setSignupVerificationEmail(unverifiedLoginEmail);
                            setSignupVerificationEmailSent(true);
                            setSignupVerificationResendSent(true);
                            setSignupVerificationResendError('');
                            setSignupVerificationStartedAt(Date.now());
                            setSignupVerificationCode('');
                            setSignupVerificationPending(false);
                            setSignupVerificationError('');
                            setSignupVerificationSuccess(false);
                            setAuthMode('verify');
	                        } catch (error) {
	                          console.warn('[Auth] Verification resend failed', error);
	                          setLoginError('Unable to send a new verification code. Please try again.');
                        } finally {
                          setVerificationResendPending(false);
                        }
                      }}
                      className="font-semibold btn-hover-lighter disabled:opacity-60"
                      style={{ color: secondaryColor }}
                    >
	                      {verificationResendPending ? 'Sending verification code...' : 'Send verification code'}
                    </button>
                    {verificationResendSent && (
	                      <p className="mt-1 text-emerald-600">Verification code sent. Check your inbox and spam folder.</p>
                    )}
                  </div>
                )}
                {loginNotice && (
                  <p className="text-sm text-emerald-600">{loginNotice}</p>
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
                New to TrufusionLabs?{' '}
                <button
                  type="button"
                  onClick={() => {
                    clearSignupVerificationState();
                    setAuthMode('signup');
                  }}
                  className="font-semibold btn-hover-lighter"
                  style={{ color: secondaryColor }}
                >
                  Create an account
                </button>
              </p>
            </div>
	          ) : authMode === 'verify' ? (
	            <div className="space-y-5">
	              <div className="space-y-4 text-center">
		                <div
		                  className={clsx(
		                    'mx-auto flex items-center justify-center',
		                    signupVerificationSuccess
		                      ? 'verification-success-badge'
		                      : signupVerificationEmailSent
		                        ? null
		                        : 'h-14 w-14 rounded-full border',
		                  )}
		                  style={{
		                    color: signupVerificationSuccess ? '#059669' : signupVerificationEmailSent ? secondaryColor : '#b45309',
		                    borderColor: signupVerificationSuccess || signupVerificationEmailSent ? 'transparent' : 'rgba(180,83,9,0.24)',
		                    backgroundColor: signupVerificationSuccess || signupVerificationEmailSent ? 'transparent' : 'rgba(251,191,36,0.14)',
		                  }}
		                  aria-hidden="true"
		                >
	                  {signupVerificationSuccess ? (
	                    <Check className="verification-success-check h-7 w-7" />
	                  ) : signupVerificationEmailSent ? (
	                    <Mail className="h-7 w-7" />
	                  ) : (
	                    <AlertTriangle className="h-7 w-7" />
                  )}
                </div>
	                <div className="space-y-2">
	                  <h3 className="text-lg font-semibold text-slate-900">
	                    {signupVerificationSuccess
	                      ? 'Email verified'
	                      : signupVerificationEmailSent
	                        ? 'Enter verification code'
	                        : 'Verification email was not sent'}
	                  </h3>
	                  <p className="text-sm leading-relaxed text-slate-600">
	                    {signupVerificationSuccess ? (
	                      'Signing you in now.'
	                    ) : (
	                      <>
	                        {signupVerificationEmailSent
	                          ? 'A 6-digit code was sent to'
	                          : 'Your account was created, but the email provider did not confirm delivery to'}{' '}
	                        <span className="font-semibold text-slate-900">
	                          {signupVerificationEmail || 'your email address'}
	                        </span>
	                        .
	                      </>
	                    )}
	                  </p>
	                  {!signupVerificationSuccess && (
	                    <p className="text-xs leading-relaxed text-slate-500">
	                      Check spam or junk folders. The code expires in 10 minutes.
	                    </p>
	                  )}
	                </div>
	              </div>
	              {signupVerificationEmailSent && (
	                <form
	                  className="space-y-3"
	                  onSubmit={async (event) => {
	                    event.preventDefault();
	                    if (
	                      signupVerificationPending ||
	                      signupVerificationSuccess ||
	                      !signupVerificationEmail
	                    ) {
	                      return;
	                    }
	                    if (!onVerifyEmailCode) {
	                      setSignupVerificationError('Email verification is unavailable right now. Please try again.');
	                      return;
	                    }
	                    setSignupVerificationPending(true);
	                    setSignupVerificationError('');
	                    const result = await onVerifyEmailCode(
	                      signupVerificationEmail,
	                      signupVerificationCode,
	                    );
	                    if (result.status === 'success') {
	                      setSignupVerificationSuccess(true);
	                    } else {
	                      setSignupVerificationError(
	                        (result as any).message ||
	                          'That code is incorrect or expired. Request a new code and try again.',
	                      );
	                    }
	                    setSignupVerificationPending(false);
	                  }}
	                >
	                  <Label htmlFor="signup-verification-code">Verification code</Label>
	                  <Input
	                    id="signup-verification-code"
	                    type="text"
	                    inputMode="numeric"
	                    autoComplete="one-time-code"
	                    pattern="[0-9]{6}"
	                    maxLength={6}
	                    value={signupVerificationCode}
	                    disabled={signupVerificationPending || signupVerificationSuccess}
	                    onChange={(event) => {
	                      setSignupVerificationCode(
	                        event.currentTarget.value.replace(/\D/g, '').slice(0, 6),
	                      );
	                      setSignupVerificationError('');
	                    }}
	                    className="glass squircle-sm text-center text-xl font-semibold tracking-[0.38em] focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)] disabled:opacity-70"
	                    style={{ borderColor: translucentSecondary }}
	                  />
	                  {signupVerificationError && (
	                    <p className="text-sm text-red-600 text-center" role="alert">
	                      {signupVerificationError}
	                    </p>
	                  )}
	                  <Button
	                    type="submit"
	                    className="w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
	                    disabled={
	                      signupVerificationPending ||
	                      signupVerificationSuccess ||
	                      signupVerificationCode.length !== 6
	                    }
	                  >
	                    {signupVerificationPending && (
	                      <Loader2 className="h-4 w-4 animate-spin-slow" aria-hidden="true" />
	                    )}
	                    {signupVerificationSuccess
	                      ? 'Verified'
	                      : signupVerificationPending
	                        ? 'Verifying...'
	                        : 'Verify code'}
	                  </Button>
	                </form>
	              )}
	              {signupVerificationResendError && (
	                <p className="text-sm text-red-600 text-center" role="alert">
	                  {signupVerificationResendError}
                </p>
              )}
	              {signupVerificationResendSent && (
	                <p className="text-sm text-emerald-600 text-center" role="status">
	                  Verification code sent. Check your inbox and spam folder.
	                </p>
	              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  className="squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                  disabled={signupVerificationResendPending || !signupVerificationEmail || !onResendVerificationEmail}
                  onClick={async () => {
                    if (!onResendVerificationEmail || !signupVerificationEmail) return;
	                    setSignupVerificationResendPending(true);
	                    setSignupVerificationResendSent(false);
	                    setSignupVerificationResendError('');
	                    setSignupVerificationError('');
	                    setSignupVerificationSuccess(false);
	                    try {
	                      await onResendVerificationEmail(signupVerificationEmail);
	                      setSignupVerificationEmailSent(true);
	                      setSignupVerificationResendSent(true);
	                      setSignupVerificationCode('');
	                    } catch (error) {
	                      console.warn('[Auth] Verification resend failed', error);
	                      setSignupVerificationResendError('Unable to send a verification code right now. Please try again.');
                    } finally {
                      setSignupVerificationResendPending(false);
                    }
                  }}
                >
                  {signupVerificationResendPending && (
                    <Loader2 className="h-4 w-4 animate-spin-slow" aria-hidden="true" />
                  )}
	                  {signupVerificationResendPending
	                    ? 'Sending...'
	                    : signupVerificationEmailSent
	                      ? 'Resend code'
	                      : 'Send verification code'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="squircle-sm bg-white text-slate-900"
                  onClick={() => {
                    if (signupVerificationEmail) {
                      queueLoginPrefill({ email: signupVerificationEmail, password: '' });
                    }
                    setAuthMode('login');
                  }}
                >
                  Return to sign in
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <form onSubmit={handleSignup} autoComplete="on" className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                  <div className="space-y-2 sm:w-36 sm:pb-0">
                    <Label htmlFor="suffix">
                      <span>Preffix</span>
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        Optional
                      </span>
                    </Label>
                    <select
                      id="suffix"
                      value={signupSuffix}
                      onChange={(e) => setSignupSuffix(e.target.value)}
                      className="auth-prefix-select glass squircle-sm mt-1 flex h-10 w-full min-w-0 border border-input bg-input-background px-3 py-1 text-sm transition-[color,box-shadow] outline-none focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[3px] focus-visible:ring-[rgba(11,6,121,0.3)]"
                      style={{ borderColor: translucentSecondary }}
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
                    className="glass squircle-sm mt-1 h-10 focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
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
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
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
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.12)] btn-hover-lighter"
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
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupConfirmPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(11,6,121,0.12)] btn-hover-lighter"
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
                    className="glass squircle-sm focus-visible:border-[rgb(11,6,121)] focus-visible:ring-[rgba(11,6,121,0.3)]"
                    style={{ borderColor: translucentSecondary, textTransform: 'uppercase' }}
                    required
                  />
                  <p className="text-xs text-slate-500">Codes are 5 characters and issued by your sales representative.</p>
                </div>
                {signupError && (
                  <p className="text-sm text-red-600">{signupError}</p>
                )}
                {signupNotice && (
                  <p className="text-sm text-emerald-600">{signupNotice}</p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                  disabled={signupSubmitting}
                >
                  {signupSubmitting && (
                    <Loader2 className="h-4 w-4 animate-spin-slow" aria-hidden="true" />
                  )}
                  {signupSubmitting ? 'Submitting...' : 'Submit'}
                </Button>
              </form>
              <p className="text-center text-sm text-gray-600">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => {
                    clearSignupVerificationState();
                    setAuthMode('login');
                  }}
                  className="font-semibold btn-hover-lighter"
                  style={{ color: secondaryColor }}
                >
                  Sign in
                </button>
              </p>
            </div>
          )}
          {authMode !== 'verify' && (
          <div className="mt-6 glass squircle-lg p-4 sm:p-5 space-y-4 border border-[var(--brand-glass-border-1)]">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-slate-800">Track an order</h3>
              <p className="text-sm text-slate-600">
                Enter your TrufusionLabs order ID and email. We&apos;ll email you the latest fulfillment update.
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
          )}
        </DialogContent>
      </Dialog>
      {renderCartButton()}
    </>
	  );

  const physicianDashboardTabs: Array<{
    id: PhysicianDashboardTabId;
    label: string;
    Icon: ElementType;
    count?: number;
  }> = [
    { id: 'links', label: 'Delegate Links', Icon: Link2, count: outstandingPatientProposalCount },
    { id: 'orders', label: 'Your Orders', Icon: Package },
    ...(canSeePhysicianThreePlTab
      ? [{ id: '3pl' as const, label: '3PL', Icon: Truck }]
      : []),
    { id: 'refer', label: 'Refer a Colleague', Icon: Users },
    { id: 'settings', label: 'Settings', Icon: AdjustmentsHorizontalIcon },
  ];

  useEffect(() => {
    if (physicianDashboardTab === '3pl' && !canSeePhysicianThreePlTab) {
      setPhysicianDashboardTab('links');
    }
  }, [canSeePhysicianThreePlTab, physicianDashboardTab]);

  const physicianDashboardActivePanel =
    physicianDashboardTab === 'links'
      ? patientLinksPanel
      : physicianDashboardTab === 'orders'
        ? accountOrdersPanel
        : physicianDashboardTab === '3pl' && canSeePhysicianThreePlTab
          ? physicianThreePlPanel
        : physicianDashboardTab === 'refer'
          ? physicianReferralDashboardPanel
          : physicianDashboardSettingsPanel;

  const physicianDashboardPortal =
    accountIsDoctor && physicianDashboardPortalTarget
      ? createPortal(
          <section
            className="glass-card squircle-xl p-4 sm:p-6 shadow-[0_30px_80px_-55px_rgba(11,6,121,0.6)] w-full sales-rep-dashboard physician-dashboard-container"
            aria-label="Physician dashboard"
          >
            <div className="mb-0 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">
                  Physician Dashboard
                </h2>
                <p className="text-sm text-slate-600">
                  {canSeePhysicianThreePlTab
                    ? 'Manage your delegate links, orders, 3PL, colleague referrals, and settings'
                    : 'Manage your delegate links, orders, colleague referrals, and account tools.'}
                </p>
              </div>
            </div>
            <div className="relative mb-3 w-full account-tab-shell physician-dashboard-tabs">
              <div
                className="w-full account-tab-scroll-container"
                ref={physicianDashboardTabsContainerRef}
                onScroll={updatePhysicianDashboardTabIndicator}
              >
                <div className="flex items-center gap-4 pb-0 account-tab-row">
                  {physicianDashboardTabs.map((tab) => {
                    const isActive = physicianDashboardTab === tab.id;
                    const showCount = Number(tab.count || 0) > 0;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        className={clsx(
                          "relative inline-flex min-h-[2.5rem] items-center gap-2 px-3 pb-1 pt-2 text-sm font-semibold whitespace-nowrap transition-colors text-black hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black/30 flex-shrink-0 physician-dashboard-tab",
                          isActive && "text-black",
                        )}
                        data-physician-dashboard-tab={tab.id}
                        aria-pressed={isActive}
                        onClick={() => {
                          setPhysicianDashboardTab(tab.id);
                          if (tab.id === 'links') {
                            trackUsageEvent('delegate_link_tab_clicked', {
                              tab: 'delegate_links',
                              tabLabel: tab.label,
                              source: 'physician_dashboard',
                            });
                          }
                        }}
                      >
                        <span
                          className="inline-flex items-center gap-2"
                          data-physician-dashboard-tab-content
                        >
                          <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-visible">
                            <tab.Icon
                              className="account-tab-icon physician-dashboard-tab-icon"
                              aria-hidden="true"
                            />
                          </span>
                          <span className="inline-flex items-center">
                            {tab.label}
                            {showCount && (
                              <span
                                className="patient-links-tab-count ml-1 inline-flex shrink-0 items-center justify-center !p-0 text-sm !text-[rgb(11,6,121)] font-semibold leading-none pointer-events-none"
                                aria-label={`${tab.label} notifications: ${tab.count}`}
                                style={{ color: 'rgb(11,6,121)' }}
                              >
                                {Number(tab.count) > 9 ? '9+' : tab.count}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <span
                aria-hidden="true"
                className="account-tab-underline-indicator"
                style={{
                  left: physicianDashboardTabIndicator.left,
                  width: physicianDashboardTabIndicator.width,
                  opacity: physicianDashboardTabIndicator.opacity,
                }}
              />
            </div>
            <div className="physician-dashboard-panel" data-dashboard-squircle="off">
              {physicianDashboardActivePanel}
            </div>
          </section>,
          physicianDashboardPortalTarget,
        )
      : null;

				  return (
            <>
              {physicianDashboardPortal}
				    <header
				      ref={headerRef}
				      data-app-header
			      className={clsx(
			        "w-full app-header-blur glass-liquid border-b border-slate-200 shadow-sm",
			      )}
			      style={{
			        position: 'fixed',
			        top: 0,
			        left: 0,
			        right: 0,
			        zIndex: 9500,
			        opacity: 1,
			        pointerEvents: 'auto',
			      }}
			    >
      <div className="app-header-frame w-full px-4 sm:px-6 py-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div
            className={clsx(
              "flex w-full items-center gap-3 sm:gap-4 justify-between",
              showInfoHeaderWelcome ? "flex-wrap md:flex-nowrap" : "flex-nowrap",
            )}
          >
	            {/* Logo (same header layout for doctor + delegate) */}
	            <div className="flex items-center gap-3 min-w-0 flex-shrink-0 self-center">
	              <div className="flex items-center gap-3">
		                <div
		                  className="brand-logo relative flex items-center justify-center flex-shrink-0"
		                  style={{ height: logoSizing.heightPx }}
		                >
                  {delegateMode && typeof delegateLogoUrl === 'string' && delegateLogoUrl.trim().length > 0 ? (
                    <img
                      src={delegateLogoUrl}
                      alt="Physician logo"
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
                  ) : (
                    <BrandLogoImage
                      alt={delegateMode ? 'Physician logo' : 'TrufusionLabs logo'}
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
                  )}
	                </div>
	              </div>
                {!suppressHomeButton && !delegateMode && user && onShowInfo && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onShowInfo}
	                    className="shop-home-button squircle-sm"
                      style={{ borderColor: HEADER_BRAND_BLUE, color: HEADER_BRAND_BLUE }}
	                    aria-label="Home"
                    title="Home"
                  >
                    <Home className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
	            </div>

            {/* Search Bar - Desktop (centered) */}
            {!suppressSearch && isLargeScreen && (
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
		              {(displayedNetworkQuality === 'offline' || displayedNetworkQuality === 'poor') && (
		                <div
		                  className={clsx(
                        "flex items-center justify-center squircle-sm border px-2 py-1",
                        displayedNetworkQuality === 'offline'
                          ? "border-rose-200 bg-rose-50 text-rose-700"
                          : networkIndicatorUsesApiHealth
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : "border-slate-200 bg-white/70 text-slate-800",
                      )}
			                  title={
			                    displayedNetworkQuality === 'offline'
	                          ? networkIndicatorUsesApiHealth && apiHealthNetworkReason
                              ? `API unreachable: ${apiHealthNetworkReason}`
                              : 'Offline'
                          : (() => {
                              if (networkIndicatorUsesApiHealth && apiHealthNetworkReason) {
                                return `API degraded: ${apiHealthNetworkReason}`;
                              }
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
		                    displayedNetworkQuality === 'offline'
                          ? networkIndicatorUsesApiHealth
                            ? 'API unreachable'
                            : 'Offline'
                          : networkIndicatorUsesApiHealth
                            ? 'API degraded'
                            : 'Poor internet connection'
		                  }
		                >
		                  {displayedNetworkQuality === 'offline' ? (
                        <WifiOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <NetworkBarsIcon activeBars={1} />
                      )}
		                </div>
		              )}
	              {authControls}
	              {!suppressSearch && !isLargeScreen && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={toggleMobileSearch}
                  aria-expanded={mobileSearchOpen}
                  disabled={Boolean(catalogLoading)}
                  aria-disabled={Boolean(catalogLoading)}
	                  className={clsx(
                      "header-cart-button mobile-search-toggle-button squircle-sm transition-all duration-300",
                      delegateMode && "delegate-mobile-search-toggle",
                    )}
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

          {!suppressSearch && mobileSearchOpen && !isLargeScreen && (
            <div className="px-1 pb-2">
              <form onSubmit={handleSearch}>{renderSearchField()}</form>
            </div>
          )}
        </div>
      </div>
    </header>
            </>
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
              className="header-home-button squircle-sm bg-white text-slate-900"
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
