import { useState, useEffect, useRef, useLayoutEffect, useCallback, FormEvent, MouseEvent, WheelEvent, TouchEvent } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart, LogOut, Home, Copy, X, Eye, EyeOff, Pencil, Loader2, Info, Package, Users, RefreshCw } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { AuthActionResult } from '../types/auth';
import clsx from 'clsx';
import { requestStoredPasswordCredential } from '../lib/passwordCredential';
import { proxifyWooMediaUrl } from '../lib/mediaProxy';

const normalizeRole = (role?: string | null) => (role || '').toLowerCase();
const isAdmin = (role?: string | null) => normalizeRole(role) === 'admin';
const isRep = (role?: string | null) => normalizeRole(role) === 'sales_rep';

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
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
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
}

interface HeaderProps {
  user: HeaderUser | null;
  onLogin: (email: string, password: string) => Promise<AuthActionResult> | AuthActionResult;
  onLogout: () => void;
  cartItems: number;
  onSearch: (query: string) => void;
  onCreateAccount?: (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    code: string;
  }) => Promise<AuthActionResult> | AuthActionResult;
  onCartClick?: () => void;
  loginPromptToken?: number;
  loginContext?: 'checkout' | null;
  showCartIconFallback?: boolean;
  onShowInfo?: () => void;
  onUserUpdated?: (user: HeaderUser) => void;
  accountOrders?: AccountOrderSummary[];
  accountOrdersLoading?: boolean;
  accountOrdersError?: string | null;
  ordersLastSyncedAt?: string | null;
  onRefreshOrders?: () => void;
  accountModalRequest?: { tab: 'details' | 'orders'; open?: boolean; token: number } | null;
  showCanceledOrders?: boolean;
  onToggleShowCanceled?: () => void;
  onBuyOrderAgain?: (order: AccountOrderSummary) => void;
  onCancelOrder?: (orderId: string) => Promise<unknown>;
  referralCodes?: string[] | null;
  catalogLoading?: boolean;
}

const formatOrderDate = (value?: string | null) => {
  if (!value) return 'Pending';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
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
    const baseDate = order.createdAt ? new Date(order.createdAt) : new Date();
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

const CANCELLABLE_ORDER_STATUSES = new Set(['pending', 'on-hold', 'failed', 'payment_failed', 'processing']);

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
  const lines = [
    address.name,
    address.company,
    [address.addressLine1, address.addressLine2].filter(Boolean).join(' ').trim() || null,
    [address.city, address.state, address.postalCode].filter(Boolean).join(', ').replace(/, ,/g, ', ').replace(/^,/, '').trim() || null,
    address.country,
    address.phone ? `Phone: ${address.phone}` : null,
    address.email ? `Email: ${address.email}` : null,
  ].filter((line) => typeof line === 'string' && line.trim().length > 0);

  if (!lines.length) {
    return <p className="text-sm text-slate-500">No address available.</p>;
  }

  return (
    <div className="text-sm text-slate-700 space-y-1 text-left">
      {lines.map((line, index) => (
        <p key={`${line}-${index}`}>{line}</p>
      ))}
    </div>
  );
};

const normalizeImageSource = (value: any): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return proxifyWooMediaUrl(value.trim());
  }
  if (value && typeof value === 'object') {
    const source = value.src || value.url || value.href || value.source;
    if (typeof source === 'string' && source.trim().length > 0) {
      return proxifyWooMediaUrl(source.trim());
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

const formatRelativeMinutes = (value?: string | null) => {
  if (!value) return 'Updated a few moments ago';
  const date = new Date(value);
  const now = Date.now();
  const target = date.getTime();
  if (Number.isNaN(target)) return `Updated ${value}`;
  const diffMs = Math.max(0, now - target);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes <= 1) return 'Updated a few moments ago';
  return `Updated ${minutes} min ago`;
};

export function Header({
  user,
  onLogin,
  onLogout,
  cartItems,
  onSearch,
  onCreateAccount,
  onCartClick,
  loginPromptToken,
  loginContext = null,
  showCartIconFallback = false,
  onShowInfo,
  onUserUpdated,
  accountOrders = [],
  accountOrdersLoading = false,
  accountOrdersError = null,
  ordersLastSyncedAt,
  onRefreshOrders,
  accountModalRequest = null,
  showCanceledOrders = false,
  onToggleShowCanceled,
  onBuyOrderAgain,
  onCancelOrder,
  referralCodes = [],
  catalogLoading = false,
}: HeaderProps) {
  const secondaryColor = 'rgb(95, 179, 249)';
  const translucentSecondary = 'rgba(95, 179, 249, 0.18)';
  const elevatedShadow = '0 32px 60px -28px rgba(95, 179, 249, 0.55)';
  const logoHaloBackground = 'rgba(95, 179, 249, 0.08)';
  const [loginOpen, setLoginOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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
  const [accountTab, setAccountTab] = useState<'details' | 'orders' | 'research'>('details');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const referralCopyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLargeScreen, setIsLargeScreen] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirmPassword, setShowSignupConfirmPassword] = useState(false);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [trackingForm, setTrackingForm] = useState({ orderId: '', email: '' });
  const [trackingPending, setTrackingPending] = useState(false);
  const [trackingMessage, setTrackingMessage] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [localUser, setLocalUser] = useState<HeaderUser | null>(user);
  const loginFormRef = useRef<HTMLFormElement | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<AccountOrderSummary | null>(null);
  const [cachedAccountOrders, setCachedAccountOrders] = useState<AccountOrderSummary[]>(Array.isArray(accountOrders) ? accountOrders : []);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const loginEmailRef = useRef<HTMLInputElement | null>(null);
  const loginPasswordRef = useRef<HTMLInputElement | null>(null);
  const pendingLoginPrefill = useRef<{ email?: string; password?: string }>({});
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUploadPercent, setAvatarUploadPercent] = useState(0);
  const [showAvatarControls, setShowAvatarControls] = useState(false);
  const credentialAutofillRequestInFlight = useRef(false);
  const accountModalRequestTokenRef = useRef<number | null>(null);
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
  const triggerCredentialAutofill = useCallback(async () => {
    if (credentialAutofillRequestInFlight.current) {
      return;
    }
    credentialAutofillRequestInFlight.current = true;
    try {
      const credential = await requestStoredPasswordCredential();
      if (credential) {
        queueLoginPrefill({
          email: credential.id,
          password: credential.password,
        });
      }
    } finally {
      credentialAutofillRequestInFlight.current = false;
    }
  }, [queueLoginPrefill]);
  const handleLoginCredentialFocus = useCallback(() => {
    if (!loginOpen || authMode !== 'login') {
      return;
    }
    void triggerCredentialAutofill();
  }, [triggerCredentialAutofill, loginOpen, authMode]);

  useEffect(() => {
    if (!accountModalRequest) {
      return;
    }
    if (accountModalRequest.token && accountModalRequest.token === accountModalRequestTokenRef.current) {
      return;
    }
    accountModalRequestTokenRef.current = accountModalRequest.token ?? Date.now();
    console.debug('[Header] Processing account modal request', accountModalRequest);
    if (accountModalRequest.tab) {
      setAccountTab(accountModalRequest.tab);
    }
    if (accountModalRequest.open) {
      setWelcomeOpen(true);
    }
  }, [accountModalRequest]);
  useEffect(() => { setLocalUser(user); }, [user]);
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
  const accountRole = localUser?.role ?? user.role;
  const accountIsAdmin = isAdmin(accountRole);
  const accountIsSalesRep = isRep(accountRole);
  const headerDisplayName = localUser
    ? accountIsAdmin
      ? `Admin: ${localUser.name}`
      : accountIsSalesRep
        ? `Rep: ${localUser.name}`
        : localUser.name
    : '';
  const profileImageUrl = localUser?.profileImageUrl || user.profileImageUrl || null;
  const userInitials = getInitials(localUser?.name || user.name || headerDisplayName);
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
  const directReferralCode = (() => {
    const raw = localUser?.referralCode ?? user.referralCode ?? null;
    if (raw === null || raw === undefined) {
      return '';
    }
    return String(raw).trim().toUpperCase();
  })();
  const primaryReferralCode = directReferralCode || normalizedReferralCodes[0] || null;
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
          alt={`${headerDisplayName || localUser?.name || user.name} avatar`}
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

    const result = await onLogin(emailValue, passwordValue);

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
      setLoginError('Unable to log in. Please try again.');
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
    queueLoginPrefill({ email: '', password: '' });
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

  // Auto-refresh orders when the orders tab is open
  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'orders' || !onRefreshOrders || !user) {
      return undefined;
    }
    onRefreshOrders();
    const intervalId = window.setInterval(() => {
      onRefreshOrders();
    }, 10000);
    return () => window.clearInterval(intervalId);
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

  const handleSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSearch(searchQuery);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileSearchOpen(false);
    }
  };


  const handleSearchChange = (value: string) => {
    console.debug('[Header] Search change', { value });
    setSearchQuery(value);
    onSearch(value);
  };

  const toggleMobileSearch = () => {
    setMobileSearchOpen((prev) => !prev);
  };

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
      : await onLogin(signupEmail, signupPassword);

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
      setSignupError('We couldn\'t locate that onboarding code. Please confirm it with your sales representative.');
      return;
    }

    if (result.status === 'sales_rep_email_mismatch') {
      setSignupError('Please use the email address associated with your sales representative profile.');
      return;
    }

    if (result.status === 'referral_code_unavailable') {
      setSignupError('This onboarding code has already been used. Please request a new code from your sales representative.');
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
      onCartClick();
    }
  };

  const handleCancelOrderClick = useCallback(async (orderId: string) => {
    if (!onCancelOrder) {
      return;
    }
    setCancellingOrderId(orderId);
    try {
      await onCancelOrder(orderId);
      const selectedCancellationId = selectedOrder
        ? selectedOrder.cancellationId || selectedOrder.wooOrderId || selectedOrder.id
        : null;
      if (selectedCancellationId && selectedCancellationId === orderId) {
        setSelectedOrder(null);
      }
    } catch (error: any) {
      const message = typeof error?.message === 'string' && error.message.trim().length > 0
        ? error.message
        : 'Unable to cancel this order right now.';
      toast.error(message);
    } finally {
      setCancellingOrderId((current) => (current === orderId ? null : current));
    }
  }, [onCancelOrder, selectedOrder]);

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

  const renderCartButton = () => (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCartClick}
      className={clsx(
        'relative hidden md:inline-flex glass squircle-sm transition-all duration-300 flex-shrink-0',
        showCartIconFallback && 'inline-flex'
      )}
      style={{
        color: secondaryColor,
        borderColor: translucentSecondary,
      }}
    >
      <ShoppingCart className="h-4 w-4" style={{ color: secondaryColor }} />
      {cartItems > 0 && (
        <Badge
          variant="outline"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center p-0 glass-strong squircle-sm border border-[var(--brand-glass-border-2)] text-[rgb(95,179,249)]"
        >
          {cartItems}
        </Badge>
      )}
    </Button>
  );

  const renderSearchField = (inputClassName = '') => (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-slate-600"
      />
      <Input
        type="text"
        placeholder="Search peptides..."
        value={searchQuery}
        onChange={(e) => handleSearchChange(e.target.value)}
        className={`glass squircle-sm pl-10 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[rgba(255,255,255,0.3)] ${inputClassName}`.trim()}
        style={{ borderColor: translucentSecondary, minWidth: '100%' }}
      />
    </div>
  );

  const accountHeaderTabs = [
    { id: 'details', label: 'Details', Icon: Info },
    { id: 'orders', label: 'Orders', Icon: Package },
    { id: 'research', label: 'Research', Icon: Users },
  ] as const;

  const saveProfileField = useCallback(
    async (label: string, payload: Record<string, string | null>) => {
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
        toast.success(`${label} updated`);
      } catch (error: any) {
        if (error?.status === 413) {
          toast.error('Upload too large. Please choose a smaller image.');
        } else if (error?.message === 'EMAIL_EXISTS') {
          toast.error('That email is already in use.');
        } else {
          toast.error('Update failed');
        }
        throw error;
      }
    },
    [setLocalUser, onUserUpdated, localUser],
  );

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
                    className="squircle-sm"
                    disabled={avatarUploading}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {avatarUploading ? `Uploading… ${avatarUploadPercent}%` : 'Upload photo'}
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
                  toast.success('Profile photo updated');
                } catch (error: any) {
                  const message = typeof error?.message === 'string' ? error.message : 'Upload failed';
                  toast.error(message);
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
                Share this code with doctors to link them to your account. Editing is disabled for security.
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
    </div>
  ) : null;

  const researchPanel = (
    <div className="glass-card squircle-md p-6 border border-[var(--brand-glass-border-2)] text-center space-y-3">
      <h3 className="text-base font-semibold text-slate-800">Research</h3>
      <p className="text-sm text-slate-600">
        This section is currently in development. Soon you&apos;ll be able to access research tools and resources here to share your findings securely and anonymously with the PepPro network of physicians.
      </p>
    </div>
  );

  const renderOrdersList = () => {
    const visibleOrders = cachedAccountOrders
      .filter((order) => {
        const source = (order.source || '').toLowerCase();
        const hasWooIntegration = Boolean(
          (order.integrationDetails as any)?.wooCommerce ||
          (order.integrationDetails as any)?.woocommerce,
        );
        return source === 'woocommerce' || hasWooIntegration;
      })
      .filter((order) => {
        if (showCanceledOrders) {
          return true;
        }
        const status = order.status ? String(order.status).trim().toLowerCase() : '';
        return status !== 'canceled' && status !== 'trash';
      });

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
        const status = humanizeOrderStatus(order.status);
            const statusNormalized = (order.status || '').toLowerCase();
            const isCanceled = statusNormalized.includes('cancel') || statusNormalized === 'trash';
            const isProcessing = statusNormalized.includes('processing');
            const canCancel = Boolean(onCancelOrder) && CANCELLABLE_ORDER_STATUSES.has(statusNormalized) && !isCanceled;
            const cancellationKey =
              order.cancellationId ||
              order.wooOrderId ||
              (order.id ? String(order.id) : null);
            const isCanceling = Boolean(
              cancellationKey && cancellingOrderId === cancellationKey
            );
            const wooOrderNumber =
              (order.integrationDetails as any)?.wooCommerce?.wooOrderNumber ||
              (order.integrationDetails as any)?.wooCommerce?.pepproOrderId ||
              null;
            const orderNumberValue = wooOrderNumber || order.number || order.id || 'Order';
            const orderNumberLabel = `Order #${orderNumberValue}`;
            const itemCount = order.lineItems?.length ?? 0;
            const showItemCount = itemCount > 0 && (isProcessing || !isCanceled);
            const integrationDetails = parseMaybeJson((order as any).integrationDetails);
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
            const subtotalValue = parseWooMoney(
              (order as any).itemsSubtotal ?? (order as any).itemsTotal,
              summedLineItems > 0
                ? summedLineItems
                : parseWooMoney(wooResponse?.subtotal ?? wooPayload?.subtotal, 0),
            );
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
            const discountValue = Math.abs(
              parseWooMoney(
                (order as any).appliedReferralCredit,
                parseWooMoney(
                  wooResponse?.discount_total ??
                    wooPayload?.discount_total ??
                    (wooPayload?.discount_lines?.[0]?.total ?? 0),
                  0,
                ),
              ),
            );
            const storedGrandTotal = parseWooMoney(
              (order as any).grandTotal,
              parseWooMoney(order.total, 0),
            );
            const computedGrandTotal = subtotalValue + shippingValue + taxValue - discountValue;
            const displayTotal = storedGrandTotal > 0 ? storedGrandTotal : computedGrandTotal;
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
                      <p className="text-sm font-semibold text-slate-900">{formatOrderDate(order.createdAt)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Total</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {formatCurrency(displayTotal, order.currency || 'USD')}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Status</p>
                      <p className="text-sm font-semibold text-slate-900">{status}</p>
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
                      <button
                        type="button"
                        className="text-[rgb(26,85,173)] font-semibold hover:underline"
                        onClick={() => {
                          const integrations = order.integrations || integrationDetails;
                          const wooIntegration = (integrations as any)?.wooCommerce;
                          if (wooIntegration?.invoiceUrl) window.open(wooIntegration.invoiceUrl, '_blank', 'noopener,noreferrer');
                        }}
                      >
                        View invoice
                      </button>
                      |
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
              <div className="px-6 pt-5 pb-5">
                <div className="order-card-body flex flex-col gap-4 pt-4 md:flex-row md:items-start md:gap-6">
                  <div className="space-y-4 flex-1 min-w-0">
                    <div className="order-number-row flex flex-wrap items-start justify-between gap-3">
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-base font-bold text-slate-900 break-words">
                          <span className="mr-2">{orderNumberLabel}</span>
                          {showItemCount && (
                            <span className="text-slate-700 font-semibold hidden sm:inline">
                              {itemLabel}
                            </span>
                          )}
                        </p>
                        {showItemCount && (
                          <p className="text-sm text-slate-600 sm:hidden">{itemLabel}</p>
                        )}
                      </div>
                    </div>

                    {order.lineItems && order.lineItems.length > 0 && (
                      <div className="space-y-3">
                        {order.lineItems.map((line, idx) => {
                          const lineImage = resolveOrderLineImage(line, wooLineItems);
                          return (
                            <div
                              key={line.id || `${line.sku}-${idx}`}
                              className="order-line-item flex items-center gap-4 mb-4 min-h-[60px]"
                              style={{ maxHeight: '120px' }}
                            >
                              <div className="h-full min-h-[60px] w-20 rounded-xl border border-[#d5d9d9] bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0"
                                   style={{ maxHeight: '120px' }}>
                                {lineImage ? (
                                  <img
                                    src={lineImage}
                                    alt={line.name || 'Item thumbnail'}
                                    className="object-contain"
                                    style={{ width: '100%', height: '100%', maxHeight: '120px' }}
                                  />
                                ) : (
                                  <Package className="h-6 w-6" />
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
                  <div className="order-card-actions flex flex-col gap-2 items-stretch text-center justify-start w-full md:items-end md:gap-6 md:w-auto md:min-w-[12rem] md:text-right md:self-stretch md:ml-auto">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="header-home-button squircle-sm bg-white text-slate-900 px-6 justify-center font-semibold gap-2 w-full lg:w-full"
                      onClick={() => {
                        if (onBuyOrderAgain) {
                          onBuyOrderAgain(order);
                        } else {
                          setSelectedOrder(order);
                        }
                      }}
                    >
                      <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                      Buy it again
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
                        className="order-cancel-button squircle-sm px-6 py-1 font-semibold w-full lg:w-full text-center disabled:opacity-60 disabled:cursor-not-allowed"
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
      </div>
    );
  };

  const renderOrderDetails = () => {
    if (!selectedOrder) return null;
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
      expectedDelivery && isShipmentInTransit(selectedOrder.status),
    );
    const shippingMethod =
      formatShippingMethod(selectedOrder.shippingEstimate) ||
      titleCase(wooShippingLine?.method_title || wooShippingLine?.method_id);
    const shippingCarrier =
      titleCase(selectedOrder.shippingEstimate?.carrierId) ||
      titleCase(wooShippingLine?.method_title || wooShippingLine?.method_id);
    const shippingRate =
      selectedOrder.shippingEstimate?.rate ??
      (wooShippingLine && typeof wooShippingLine.total === 'string' ? Number(wooShippingLine.total) : undefined);

    const wooShippingAddress = convertWooAddress(wooResponse?.shipping || wooPayload?.shipping);
    const wooBillingAddress = convertWooAddress(wooResponse?.billing || wooPayload?.billing);

    const shippingAddress =
      parseAddress(selectedOrder.shippingAddress) ||
      parseAddress((selectedOrder as any).shipping) ||
      wooShippingAddress ||
      parseAddress(selectedOrder.billingAddress);
    const billingAddress =
      parseAddress(selectedOrder.billingAddress) ||
      wooBillingAddress ||
      parseAddress(selectedOrder.shippingAddress);
    const lineItems = selectedOrder.lineItems || [];
    const summedLineItems = lineItems.reduce((sum, line) => {
      const lineTotal = parseWooMoney(line.total, parseWooMoney(line.subtotal, 0));
      return sum + lineTotal;
    }, 0);
    const stripeMeta = parseMaybeJson(integrationDetails?.stripe || (integrationDetails as any)?.Stripe) || {};
    const subtotal = parseWooMoney(
      (selectedOrder as any).itemsSubtotal ?? (selectedOrder as any).itemsTotal,
      summedLineItems > 0
        ? summedLineItems
        : parseWooMoney(
            wooResponse.total ?? wooPayload.total ?? wooResponse.subtotal ?? wooPayload.subtotal,
            0,
          ),
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
    const discountTotalRaw = parseWooMoney(
      (selectedOrder as any).appliedReferralCredit,
      parseWooMoney(
        wooResponse.discount_total ?? wooPayload.discount_total ?? (wooPayload.discount_lines?.[0]?.total ?? 0),
        0,
      ),
    );
    const discountTotal = Math.abs(discountTotalRaw);
    const storedGrandTotal = parseWooMoney(
      (selectedOrder as any).grandTotal,
      parseWooMoney(selectedOrder.total, 0),
    );
    const computedGrandTotal = subtotal + shippingTotal + taxTotal - discountTotal;
    const grandTotal = storedGrandTotal > 0 ? storedGrandTotal : computedGrandTotal;
    const detailTotal = Math.max(grandTotal, 0);
    const fallbackPayment =
      selectedOrder.paymentDetails ||
      selectedOrder.paymentMethod ||
      null;
    const paymentDisplay = (() => {
      if (stripeMeta?.cardLast4) {
        return `${stripeMeta?.cardBrand || 'Card'} •••• ${stripeMeta.cardLast4}`;
      }
      if (
        typeof fallbackPayment === 'string'
        && fallbackPayment.trim().length > 0
        && !/stripe onsite/i.test(fallbackPayment)
      ) {
        return fallbackPayment;
      }
      return fallbackPayment;
    })();

    return (
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            className="squircle-sm glass btn-hover-lighter"
            onClick={() => setSelectedOrder(null)}
          >
            ← Back to orders
          </Button>
        </div>
        <div className="account-order-card squircle-lg bg-white border border-[#d5d9d9] overflow-hidden">
          <div className="px-6 py-4 bg-[#f5f6f6] border-b border-[#d5d9d9] flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 text-left">
              <p className="text-xs uppercase tracking-[0.08em] text-slate-500">Order</p>
              <p className="text-lg font-semibold text-slate-900">
                {selectedOrder.number ? `Order #${selectedOrder.number}` : selectedOrder.id}
              </p>
            </div>
            <div className="space-y-1 text-right">
              <p className="text-xs uppercase tracking-[0.08em] text-slate-500">Status</p>
              <p className="text-base font-semibold text-slate-900">{humanizeOrderStatus(selectedOrder.status)}</p>
            </div>
          </div>
          <div className="px-6 py-5 grid gap-4 md:grid-cols-3 text-sm text-slate-700">
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Placed</p>
              <p className="text-sm font-semibold text-slate-900">{formatOrderDate(selectedOrder.createdAt)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Total</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(detailTotal, selectedOrder.currency || 'USD')}
              </p>
            </div>
            {showExpectedDeliveryDetails && (
              <div>
                <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Expected delivery</p>
                <p className="text-sm font-semibold text-slate-900">{expectedDelivery}</p>
              </div>
            )}
          </div>
        </div>

        <div className="account-order-card squircle-lg bg-white border border-[#d5d9d9] p-6 space-y-6 text-left">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <h4 className="text-base font-semibold text-slate-900">Shipping Information</h4>
              {renderAddressLines(shippingAddress)}
              <div className="text-sm text-slate-700 space-y-1">
                {shippingMethod && (
                  <p>
                    <span className="font-semibold">Service:</span> {shippingMethod}
                  </p>
                )}
                {shippingCarrier && (
                  <p>
                    <span className="font-semibold">Carrier:</span> {shippingCarrier}
                  </p>
                )}
                {Number.isFinite(shippingTotal) && (
                  <p>
                    <span className="font-semibold">Shipping:</span>{' '}
                    {formatCurrency(shippingTotal, selectedOrder.currency || 'USD')}
                  </p>
                )}
                {expectedDelivery && (
                  <p>
                    <span className="font-semibold">Expected:</span> {expectedDelivery}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-base font-semibold text-slate-900">Billing Information</h4>
              {renderAddressLines(billingAddress)}
              <div className="text-sm text-slate-700 space-y-1">
                <p>
                  <span className="font-semibold">Payment:</span>{' '}
                  {paymentDisplay ? `${paymentDisplay}` : '—'}
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
                  const lineImage = resolveOrderLineImage(line, wooLineItems);
                  return (
                    <div
                      key={line.id || `${line.sku}-${idx}`}
                      className="flex items-start gap-4 border-b border-slate-100 pb-3 last:border-b-0 last:pb-0"
                    >
                      <div className="w-20 h-20 max-h-[120px] rounded-xl border border-[#d5d9d9] bg-white overflow-hidden flex items-center justify-center text-slate-500 flex-shrink-0">
                        {lineImage ? (
                          <img
                            src={lineImage}
                            alt={line.name || 'Item thumbnail'}
                            className="h-full w-full object-contain"
                            style={{ maxHeight: '120px' }}
                          />
                        ) : (
                          <Package className="h-6 w-6" />
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
                <span>{formatCurrency(subtotal, selectedOrder.currency || 'USD')}</span>
              </div>
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
              {discountTotal > 0 && (
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
        </div>
      </div>
    );
  };

  const accountOrdersPanel = localUser ? (
    !isRep(localUser.role) ? (
      <div className="space-y-4">
        {/* Header Section */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex-1 min-w-[1px]" />
            <div className="flex items-center gap-2">
              {ordersLastSyncedAt && (
                <span className="text-xs text-slate-500 px-3 py-1.5 glass-card squircle-sm border border-[var(--brand-glass-border-1)]">
                  {formatRelativeMinutes(ordersLastSyncedAt)}
                </span>
              )}
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
    ) : (
      <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] text-center">
        <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
        <p className="text-sm font-medium text-slate-700 mb-1">Sales Rep View</p>
        <p className="text-sm text-slate-600">
          Order history and tracking details for your sales rep profile will appear here soon.
        </p>
      </div>
    )
  ) : null;

  const activeAccountPanel =
    accountTab === 'details'
      ? accountInfoPanel
      : accountTab === 'orders'
        ? accountOrdersPanel
        : researchPanel;

  const authControls = user ? (
    <>
      <Dialog open={welcomeOpen} onOpenChange={(open) => {
        console.debug('[Header] Welcome dialog open change', { open });
        setWelcomeOpen(open);
      }}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setWelcomeOpen(true)}
            className="squircle-sm glass-brand btn-hover-lighter transition-all duration-300 whitespace-nowrap pl-1 pr-0 header-account-button"
            aria-haspopup="dialog"
            aria-expanded={welcomeOpen}
          >
            <span className="hidden sm:inline text-white">{headerDisplayName}</span>
            <span className="header-account-avatar-shell">
              {renderAvatar(48, 'header-account-avatar')}
            </span>
          </Button>
        </DialogTrigger>
        <DialogContent
          className="glass-card squircle-xl w-full max-w-[min(960px,calc(100vw-2rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
          style={{ backdropFilter: 'blur(38px) saturate(1.6)', boxShadow: '0 30px 90px -40px rgba(15,23,42,0.45), 0 20px 60px -50px rgba(95,179,249,0.35)' }}
        >
          <DialogHeader
            className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg flex items-start justify-between gap-4"
            style={{ boxShadow: '0 18px 28px -20px rgba(7,18,36,0.3)' }}
          >
            <div className="flex-1 min-w-0 max-w-full space-y-3 account-header-content">
              <div className="flex items-center gap-3 flex-wrap min-w-0">
                <DialogTitle className="text-xl font-semibold header-user-name min-w-0 truncate">
                  {user.name}
                </DialogTitle>
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
                  <Home className="h-5 w-5 text-[rgb(95,179,249)]" aria-hidden="true" />
                  Home
                </Button>
              </div>
              <DialogDescription className="account-header-description">
                {(user.visits ?? 1) > 1
                  ? `We appreciate you joining us on the path to making healthcare simpler and more transparent! We are excited to have you! You can manage your account details and orders below.`
                  : `We are thrilled to have you with us—let's make healthcare simpler together!`}
              </DialogDescription>
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
                  <div className="flex items-center gap-4 pb-4 account-tab-row">
                    {accountHeaderTabs.map((tab) => {
                      const isActive = accountTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          className={clsx(
                            'relative inline-flex items-center gap-2 px-3 pb-4 pt-1 text-sm font-semibold whitespace-nowrap transition-colors text-slate-600 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black/30 flex-shrink-0',
                            isActive && 'text-slate-900'
                          )}
                          data-tab={tab.id}
                          aria-pressed={isActive}
                          onClick={() => setAccountTab(tab.id)}
                        >
                          <tab.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                          {tab.label}
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
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="space-y-6 pt-4">
              {activeAccountPanel ?? (
                <div className="text-sm text-slate-600">
                  Loading account details...
                </div>
              )}
            </div>
          </div>
          <div className="border-t border-[var(--brand-glass-border-1)] px-6 py-4 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="btn-no-hover header-logout-button squircle-sm glass text-slate-900 border-0"
              onClick={onLogout}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
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
          className="glass-card squircle-xl w-auto border border-[var(--brand-glass-border-2)] shadow-2xl"
          style={{
            backdropFilter: 'blur(38px) saturate(1.6)',
            width: 'min(640px, calc(100vw - 3rem))',
            maxWidth: 'min(640px, calc(100vw - 3rem))',
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
            </div>
            <DialogClose
              className="dialog-close-btn inline-flex h-9 w-9 items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              aria-label="Close account modal"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </DialogHeader>
          {authMode === 'login' ? (
            <div className="space-y-5">
              <form ref={loginFormRef} autoComplete="on" onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-3">
                  <Label htmlFor="login-username">Email</Label>
                  <Input
                    ref={loginEmailRef}
                    id="login-username"
                    name="username"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onFocus={handleLoginCredentialFocus}
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
                      onFocus={handleLoginCredentialFocus}
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
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                  <div className="space-y-2 sm:w-36 sm:pb-0">
                    <Label htmlFor="suffix">Suffix</Label>
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
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleTrackOrder}>
              <div>
                <Label htmlFor="account-track-id">Order ID</Label>
                <Input
                  id="account-track-id"
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
                  type="email"
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

  const logoSizing = isLargeScreen
    ? { maxWidth: '160px', maxHeight: '160px' }
    : { maxWidth: 'min(150px, 42vw)', maxHeight: '64px' };

  return (
    <header
      ref={headerRef}
      data-app-header
      className="w-full glass-strong border-b border-white/20 bg-white/70 supports-[backdrop-filter]:bg-white/40 backdrop-blur shadow-sm"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9500 }}
    >
      <div className="w-full px-6 sm:px-6 py-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div className="flex w-full flex-wrap items-center gap-3 sm:gap-4 justify-between">
            {/* Logo */}
            <div className="flex items-center gap-3 min-w-0 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="brand-logo relative flex items-center justify-center flex-shrink-0">
                  <img
                    src="/Peppro_fulllogo.png"
                    alt="PepPro logo"
                    className="relative z-[1] flex-shrink-0"
                    style={{
                      display: 'block',
                      width: 'auto',
                      height: 'auto',
                      maxWidth: logoSizing.maxWidth,
                      maxHeight: logoSizing.maxHeight,
                      objectFit: 'contain'
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Search Bar - Desktop (centered) */}
            {isLargeScreen && (
              <form
                onSubmit={handleSearch}
                className="flex flex-1 justify-center"
              >
                <div className="w-full max-w-md">
                  {renderSearchField()}
                </div>
              </form>
            )}

            {/* User Actions */}
            <div className="ml-auto flex items-center gap-2 md:gap-4 flex-wrap sm:flex-nowrap justify-end">
              {authControls}
              {!isLargeScreen && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={toggleMobileSearch}
                  aria-expanded={mobileSearchOpen}
                  className="glass squircle-sm transition-all duration-300"
                  style={{
                    color: secondaryColor,
                    borderColor: translucentSecondary,
                  }}
                >
                  {mobileSearchOpen ? (
                    <X className="h-4 w-4" style={{ color: secondaryColor }} />
                  ) : (
                    <Search className="h-4 w-4" style={{ color: secondaryColor }} />
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
    <div className="editable-row group flex items-start gap-3 sm:items-center">
      <div className="min-w-[7rem] text-sm font-medium text-slate-700">{label}</div>
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
