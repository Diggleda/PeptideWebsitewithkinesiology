import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogClose } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Textarea } from './ui/textarea';
import { Card, CardContent } from './ui/card';
import { Minus, Plus, Trash2, X, Landmark, ArrowLeftRight, ShoppingCart } from 'lucide-react';
import type { Product, ProductVariant } from '../types/product';
import { toast } from '../lib/toast';
import { discountCodesAPI, ordersAPI, shippingAPI } from '../services/api';
import { ProductImageCarousel } from './ProductImageCarousel';
import type { CSSProperties } from 'react';
import { sanitizeServiceNames } from '../lib/publicText';
import { computeUnitPrice, type PricingMode } from '../lib/pricing';

type CheckoutPaymentMethod = 'zelle' | 'bank_transfer' | 'none';

const normalizeCheckoutPaymentMethod = (value: unknown): CheckoutPaymentMethod | null => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  if (raw === 'zelle') return 'zelle';
  if (raw === 'bank_transfer' || raw === 'banktransfer' || raw === 'bank transfer') return 'bank_transfer';
  if (raw === 'zelle_ach' || raw === 'zelle/ach' || raw === 'zelle-ach' || raw === 'zelleach') return 'zelle';
  if (raw === 'insurance') return 'none';
  return null;
};

const getCheckoutErrorMessage = (error: any) => {
  const code =
    typeof error?.code === 'string' && error.code.trim().length > 0
      ? error.code.trim()
      : typeof error?.details?.code === 'string' && error.details.code.trim().length > 0
        ? error.details.code.trim()
        : null;

  if (code === 'WOO_ORDER_CREATE_FAILED') {
    return "We couldn't place your order right now. Please try again.";
  }

  if (typeof error?.message === 'string' && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Unable to complete purchase. Please try again.';
};

interface CheckoutResult {
  success?: boolean;
  message?: string | null;
  order?: {
    id?: string | null;
    wooOrderNumber?: string | null;
    wooOrderId?: string | null;
    number?: string | number | null;
  } | null;
  integrations?: {
    wooCommerce?: {
      response?: {
        payment_url?: string | null;
        paymentUrl?: string | null;
        payForOrderUrl?: string | null;
        number?: string | number | null;
        id?: string | number | null;
      } | null;
    } | null;
    stripe?: {
      clientSecret?: string | null;
      paymentIntentId?: string | null;
      status?: string | null;
      reason?: string | null;
    } | null;
  } | null;
}

interface CartItem {
  id: string;
  product: Product;
  quantity: number;
  note?: string;
  variant?: ProductVariant | null;
}

type CheckoutPayloadItem = {
  cartItemId: string;
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  price: number;
  quantity: number;
  note: string | null;
  position: number;
  weightOz: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
};

type ShippingAddress = {
  name?: string | null;
  fullName?: string | null;
  recipientName?: string | null;
  recipient_name?: string | null;
  orderRecipientName?: string | null;
  order_recipient_name?: string | null;
  pickupRecipientName?: string | null;
  pickup_recipient_name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

const FACILITY_PICKUP_SERVICE_CODE = 'facility_pickup';
const FACILITY_PICKUP_ADDRESS: ShippingAddress = {
  name: 'PepPro Facility Pickup',
  addressLine1: '640 S Grand Ave',
  addressLine2: 'Unit #107',
  city: 'Santa Ana',
  state: 'CA',
  postalCode: '92705',
  country: 'US',
};

type ShippingRate = {
  carrierId: string | null;
  serviceCode: string | null;
  serviceType: string | null;
  estimatedDeliveryDays: number | null;
  deliveryDateGuaranteed: string | null;
  rate: number | null;
  currency: string | null;
  addressFingerprint?: string | null;
};

const normalizeShippingRate = (value: any): ShippingRate | null => {
  if (!value || typeof value !== 'object') return null;
  const normalizeText = (input: unknown) =>
    typeof input === 'string' ? input.trim() : input == null ? '' : String(input).trim();
  const toNumberOrNull = (input: unknown) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const toIntOrNull = (input: unknown) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  };

  const carrierId = normalizeText(value.carrierId ?? value.carrier_id) || null;
  const serviceCode = normalizeText(value.serviceCode ?? value.service_code) || null;
  const serviceType = normalizeText(value.serviceType ?? value.service_type) || null;
  const rate = toNumberOrNull(value.rate);
  if (!carrierId && !serviceCode && !serviceType && rate == null) return null;

  return {
    carrierId,
    serviceCode,
    serviceType,
    estimatedDeliveryDays: toIntOrNull(value.estimatedDeliveryDays ?? value.estimated_delivery_days),
    deliveryDateGuaranteed:
      normalizeText(value.deliveryDateGuaranteed ?? value.delivery_date_guaranteed) || null,
    rate,
    currency: normalizeText(value.currency) || null,
    addressFingerprint: normalizeText(value.addressFingerprint ?? value.address_fingerprint) || null,
  };
};

const normalizeAddressField = (value?: string | null) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const isFacilityPickupRecipientPlaceholder = (value?: string | null) =>
  normalizeAddressField(value).toLowerCase() === FACILITY_PICKUP_ADDRESS.name.toLowerCase();

const normalizeFacilityPickupRecipientName = (value?: string | null) => {
  const normalized = normalizeAddressField(value);
  return normalized && !isFacilityPickupRecipientPlaceholder(normalized) ? normalized : '';
};

const buildAddressSignature = (address: ShippingAddress) =>
  [
    address.addressLine1,
    address.addressLine2,
    address.city,
    address.state,
    address.postalCode,
    address.country,
  ]
    .map((value) => normalizeAddressField(value).toUpperCase())
    .join('|');

const isAddressComplete = (address: ShippingAddress) =>
  Boolean(
    normalizeAddressField(address.addressLine1)
    && normalizeAddressField(address.city)
    && normalizeAddressField(address.state)
    && normalizeAddressField(address.postalCode)
    && normalizeAddressField(address.country)
  );

const isTaxAddressReady = (address: ShippingAddress) => {
  const country = normalizeAddressField(address.country).toUpperCase();
  if (!country) {
    return false;
  }
  if (country !== 'US') {
    return true;
  }
  return Boolean(
    normalizeAddressField(address.state)
    && normalizeAddressField(address.postalCode)
  );
};

const toTitleCase = (value: string) => value.replace(/\b\w/g, (char) => char.toUpperCase());

const formatShippingServiceLabel = (rate: ShippingRate) => {
  const rawLabel = rate.serviceType || rate.serviceCode || 'Service';
  const cleaned = rawLabel.replace(/[_-]+/g, ' ').trim();
  const titled = cleaned ? toTitleCase(cleaned) : 'Service';
  if (rate.carrierId) {
    const carrier = toTitleCase(rate.carrierId.replace(/[_-]+/g, ' ').trim());
    return `${carrier} — ${titled}`;
  }
  return titled;
};

const fallbackServiceTransitDays: Array<{ pattern: RegExp; days: number }> = [
  { pattern: /(next|1st|first)[_-]?(day|air)|overnight/i, days: 1 },
  { pattern: /(2nd|second)[_-]?day/i, days: 2 },
  { pattern: /(3rd|third|3)[_-]?day/i, days: 3 },
  { pattern: /3\s*day\s*select/i, days: 3 },
];

const inferTransitDaysFromService = (rate?: ShippingRate | null) => {
  const candidate = String(
    rate?.serviceCode || rate?.serviceType || rate?.carrierId || '',
  ).toLowerCase();
  if (!candidate) {
    return null;
  }
  for (const entry of fallbackServiceTransitDays) {
    if (entry.pattern.test(candidate)) {
      return entry.days;
    }
  }
  return null;
};

const addBusinessDays = (start: Date, days: number) => {
  const next = new Date(start);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    next.setDate(next.getDate() + 1);
    const day = next.getDay(); // 0 Sun, 6 Sat
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }
  return next;
};

const getHourInTimeZone = (value: Date, timeZone: string) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false,
    }).formatToParts(value);
    const hourPart = parts.find((part) => part.type === 'hour')?.value;
    const parsed = hourPart ? Number.parseInt(hourPart, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  availableAddOnProducts?: Product[];
  forceProposalMode?: boolean;
  onAddAddOn?: (productId: string, variantId?: string | null) => void;
  onCheckout: (payload: {
    shippingAddress: ShippingAddress | null;
    shippingRate: ShippingRate | null;
    shippingTotal: number;
    delegateAmountDue?: number | null;
    delegateAmountDueCurrency?: string | null;
    handDelivery?: boolean;
    facilityPickup?: boolean;
    facilityPickupRecipientName?: string | null;
    expectedShipmentWindow?: string | null;
    physicianCertificationAccepted: boolean;
    taxTotal?: number | null;
    paymentMethod?: 'bacs' | string | null;
    discountCode?: string | null;
    discountCodeAmount?: number | null;
    items?: CheckoutPayloadItem[];
  }) => Promise<CheckoutResult | void> | CheckoutResult | void;
  onClearCart?: () => void;
  onPaymentSuccess?: () => void;
  onUpdateItemQuantity: (cartItemId: string, quantity: number) => void;
  onRemoveItem: (cartItemId: string) => void;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
  physicianName?: string | null;
  agreementTextPrefix?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  salesRepName?: string | null;
  handDelivered?: boolean;
  allowManualHandDelivery?: boolean;
  allowFacilityPickup?: boolean;
  defaultShippingAddress?: ShippingAddress | null;
  defaultShippingRate?: ShippingRate | null;
  availableCredits?: number;
  pricingMode?: PricingMode;
  onPricingModeChange?: (mode: PricingMode) => void;
  showRetailPricingToggle?: boolean;
  estimateTotals?: (
    payload: {
      items: any[];
      shippingAddress: any;
      shippingEstimate: any;
      shippingTotal: number;
      paymentMethod?: string | null;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<any>;
  allowUnauthenticatedCheckout?: boolean;
  delegateDoctorName?: string | null;
  delegatePaymentMethod?: string | null;
  delegatePaymentInstructions?: string | null;
  pricingMarkupPercent?: number | null;
  proposalMarkupPercent?: number | null;
  onRejectProposal?: ((notes?: string | null) => Promise<void> | void) | null;
}

const formatCardNumber = (value: string) =>
  value
    .replace(/\D/g, '')
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, '$1 ')
    .trim();

const isValidCardNumber = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 13 && digits.length <= 19;
};

const isValidExpiry = (value: string) => {
  const normalized = value.replace(/\s+/g, '');
  if (!/^(\d{2})\/(\d{2})$/.test(normalized)) {
    return false;
  }
  const [monthStr, yearStr] = normalized.split('/');
  const month = Number(monthStr);
  const year = Number(yearStr);
  if (month < 1 || month > 12) {
    return false;
  }
  const now = new Date();
  const currentYear = now.getFullYear() % 100;
  const currentMonth = now.getMonth() + 1;
  return year > currentYear || (year === currentYear && month >= currentMonth);
};

const isValidCvv = (value: string) => /^\d{3,4}$/.test(value);

export function CheckoutModal({
  isOpen,
  onClose,
  cartItems,
  availableAddOnProducts = [],
  forceProposalMode,
  onAddAddOn,
  onCheckout,
  onUpdateItemQuantity,
  onRemoveItem,
  isAuthenticated,
  onRequireLogin,
  physicianName,
  agreementTextPrefix,
  customerEmail,
  customerName,
  salesRepName,
  handDelivered = false,
  allowManualHandDelivery = false,
  allowFacilityPickup = false,
  onClearCart,
  onPaymentSuccess,
  defaultShippingAddress,
  defaultShippingRate,
  availableCredits = 0,
  pricingMode,
  onPricingModeChange,
  showRetailPricingToggle = false,
  estimateTotals,
  allowUnauthenticatedCheckout = false,
  delegateDoctorName,
  delegatePaymentMethod,
  delegatePaymentInstructions,
  pricingMarkupPercent,
  proposalMarkupPercent,
  onRejectProposal,
}: CheckoutModalProps) {
  // Referral codes are no longer collected at checkout.
  const [discountCodeDraft, setDiscountCodeDraft] = useState('');
  const [discountCodeApplied, setDiscountCodeApplied] = useState<{
    code: string;
    discountValue: number;
    discountAmount: number;
    pricingOverride?: {
      mode: 'force_tier_band';
      minQuantity: number;
      maxQuantity: number;
    } | null;
  } | null>(null);
  const [discountCodeMessage, setDiscountCodeMessage] = useState<string | null>(null);
  const [discountCodeBusy, setDiscountCodeBusy] = useState(false);
  const [quantityInputs, setQuantityInputs] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [bulkOpenMap, setBulkOpenMap] = useState<Record<string, boolean>>({});
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<CheckoutPaymentMethod>('zelle');
  const [manualHandDelivery, setManualHandDelivery] = useState(false);
  const [facilityPickup, setFacilityPickup] = useState(false);
  const defaultFacilityPickupRecipientName =
    normalizeAddressField(customerName) || normalizeAddressField(physicianName) || '';
  const [facilityPickupRecipientNameDraft, setFacilityPickupRecipientNameDraft] = useState(
    defaultFacilityPickupRecipientName,
  );
  const [facilityPickupRecipientNameSaved, setFacilityPickupRecipientNameSaved] = useState(
    defaultFacilityPickupRecipientName,
  );
  const facilityPickupRecipientNameDraftRef = useRef(facilityPickupRecipientNameDraft);
  const facilityPickupRecipientNameSavedRef = useRef(facilityPickupRecipientNameSaved);
  const setFacilityPickupRecipientNameValue = useCallback((value: string | ((prev: string) => string)) => {
    const current = facilityPickupRecipientNameDraftRef.current;
    const next = typeof value === 'function' ? value(current) : value;
    facilityPickupRecipientNameDraftRef.current = next;
    setFacilityPickupRecipientNameDraft(next);
  }, []);
  const saveFacilityPickupRecipientName = useCallback((silent = false) => {
    const next =
      normalizeFacilityPickupRecipientName(facilityPickupRecipientNameDraftRef.current)
      || defaultFacilityPickupRecipientName;
    facilityPickupRecipientNameDraftRef.current = next;
    facilityPickupRecipientNameSavedRef.current = next;
    setFacilityPickupRecipientNameDraft(next);
    setFacilityPickupRecipientNameSaved(next);
    if (!silent) {
      toast.success('Recipient name saved');
    }
    return next;
  }, [defaultFacilityPickupRecipientName]);
  const [placedOrderNumber, setPlacedOrderNumber] = useState<string | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [checkoutStatusMessage, setCheckoutStatusMessage] = useState<string | null>(null);
  const checkoutStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQuotedAddressRef = useRef<string | null>(null);
  const lastQuotedCartRef = useRef<string | null>(null);
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>({
    name: defaultShippingAddress?.name || physicianName || customerName || '',
    addressLine1: defaultShippingAddress?.addressLine1 || '',
    addressLine2: defaultShippingAddress?.addressLine2 || '',
    city: defaultShippingAddress?.city || '',
    state: defaultShippingAddress?.state || '',
    postalCode: defaultShippingAddress?.postalCode || '',
    country: defaultShippingAddress?.country || 'US',
  });
  const [shippingRates, setShippingRates] = useState<ShippingRate[] | null>(null);
  const [shippingRateError, setShippingRateError] = useState<string | null>(null);
  const [selectedRateIndex, setSelectedRateIndex] = useState<number | null>(null);
  const [isFetchingRates, setIsFetchingRates] = useState(false);
  const checkoutScrollRef = useRef<HTMLDivElement | null>(null);
  const checkoutScrollPositionRef = useRef(0);
  const [legalModalOpen, setLegalModalOpen] = useState(false);
  const [taxEstimate, setTaxEstimate] = useState<{
    amount: number;
    currency: string;
    grandTotal: number;
    source?: string | null;
    testPaymentOverrideApplied?: boolean;
    originalGrandTotal?: number | null;
    shippingTiming?: {
      averageBusinessDays?: number | null;
      roundedBusinessDays?: number | null;
      sampleSize?: number | null;
      usedHistoricalAverage?: boolean;
    } | null;
  } | null>(null);
  const [taxEstimateError, setTaxEstimateError] = useState<string | null>(null);
  const [taxEstimatePending, setTaxEstimatePending] = useState(false);
  const [isRejectingProposal, setIsRejectingProposal] = useState(false);
  const [rejectNotesOpen, setRejectNotesOpen] = useState(false);
  const [rejectNotesDraft, setRejectNotesDraft] = useState('');
  const lastTaxQuoteRef = useRef<{ key: string; ts: number } | null>(null);
  const activeTaxRequestRef = useRef<AbortController | null>(null);
  const initialDefaultRateAppliedRef = useRef(false);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ open?: boolean }>;
      setLegalModalOpen(Boolean(custom.detail?.open));
    };
    window.addEventListener('peppro:legal-state', handler);
    return () => window.removeEventListener('peppro:legal-state', handler);
  }, []);
  const storeScrollPosition = useCallback(() => {
    if (checkoutScrollRef.current) {
      checkoutScrollPositionRef.current = checkoutScrollRef.current.scrollTop;
    }
  }, []);

  const restoreScrollPosition = useCallback(() => {
    if (checkoutScrollRef.current) {
      checkoutScrollRef.current.scrollTop = checkoutScrollPositionRef.current;
    }
  }, []);

  useLayoutEffect(() => {
    if (!legalModalOpen) {
      restoreScrollPosition();
    }
  }, [legalModalOpen, restoreScrollPosition]);

  const openLegalDocument = useCallback((key: 'terms' | 'shipping' | 'privacy') => {
    storeScrollPosition();
    setLegalModalOpen(true);
    window.dispatchEvent(new CustomEvent('peppro:open-legal', { detail: { key, preserveDialogs: true } }));
  }, [storeScrollPosition]);

  const resolvedPricingMode: PricingMode = pricingMode ?? 'wholesale';
  const retailPricingEnabled = resolvedPricingMode === 'retail';

  const proposalMarkupPercentValue = useMemo(() => {
    const raw = Number(proposalMarkupPercent ?? NaN);
    if (!Number.isFinite(raw)) return null;
    return Math.max(0, Math.min(500, raw));
  }, [proposalMarkupPercent]);

  const getVisibleBulkTiers = (
    product: Product,
    quantity: number,
    variant?: ProductVariant | null,
  ) => {
    const tiers = variant?.bulkPricingTiers ?? product.bulkPricingTiers ?? [];
    if (!tiers.length) {
      return [];
    }
    const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
    const currentIndex = sorted.findIndex((tier) => quantity < tier.minQuantity);
    let start = currentIndex === -1 ? Math.max(0, sorted.length - 5) : Math.max(0, currentIndex - 2);
    let visible = sorted.slice(start, start + 5);
    if (visible.length < 5 && start > 0) {
      start = Math.max(0, start - (5 - visible.length));
      visible = sorted.slice(start, start + 5);
    }
    return visible;
  };

  const discountPricingOverride = useMemo(() => {
    const raw = discountCodeApplied?.pricingOverride;
    if (!raw || raw.mode !== 'force_tier_band') {
      return null;
    }
    const min = Number(raw.minQuantity);
    const max = Number(raw.maxQuantity);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }
    const normalizedMin = Math.max(1, Math.floor(min));
    const normalizedMax = Math.max(normalizedMin, Math.floor(max));
    return {
      mode: 'force_tier_band' as const,
      minQuantity: normalizedMin,
      maxQuantity: normalizedMax,
    };
  }, [discountCodeApplied?.pricingOverride]);

  const checkoutLineItems = useMemo(
    () =>
      cartItems.map(({ id, product, quantity, note, variant }, index) => {
        const unitPrice = computeUnitPrice(product, variant, quantity, {
          pricingMode: resolvedPricingMode,
          markupPercent: pricingMarkupPercent,
          forcedTierRange:
            discountPricingOverride?.mode === 'force_tier_band'
              ? {
                  minQuantity: discountPricingOverride.minQuantity,
                  maxQuantity: discountPricingOverride.maxQuantity,
                }
              : null,
        });
        return {
          cartItemId: id,
          productId: product.id,
          variantId: variant?.id ?? null,
          name: variant ? `${product.name} — ${variant.label}` : product.name,
          price: unitPrice,
          quantity,
          note: note ?? null,
          position: index + 1,
          sku: variant?.sku || product.sku || null,
          image: variant?.image || product.image || null,
        };
      }),
    [cartItems, discountPricingOverride, pricingMarkupPercent, resolvedPricingMode],
  );
  const cartLineItemSignature = useMemo(
    () =>
      checkoutLineItems
        .map((item) => `${item.productId}:${item.variantId || 'base'}:${item.quantity}:${item.price}`)
        .join('|'),
    [checkoutLineItems],
  );
  const checkoutLineItemsByCartItemId = useMemo(
    () => new Map(checkoutLineItems.map((item) => [item.cartItemId, item])),
    [checkoutLineItems],
  );
  const cartCompositionSignature = useMemo(
    () =>
      cartItems
        .map((item) => `${item.id}:${Number(item.quantity) || 0}`)
        .join('|'),
    [cartItems],
  );
  const subtotal = useMemo(
    () => checkoutLineItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [checkoutLineItems],
  );
  const discountCodeAmount = Math.max(0, Number(discountCodeApplied?.discountAmount || 0));
  const selectedShippingRate = selectedRateIndex != null && shippingRates
    ? shippingRates[selectedRateIndex]
    : null;
  const isDelegateCheckoutFlow = Boolean(allowUnauthenticatedCheckout && delegateDoctorName);
  const shippingCost = selectedShippingRate?.rate
    ? Number(selectedShippingRate.rate) || 0
    : 0;
  const isFacilityPickupEnabled =
    !isDelegateCheckoutFlow && allowFacilityPickup && facilityPickup === true;
  const isDoctorHandDeliveryEnabled = !isDelegateCheckoutFlow && handDelivered === true;
  const isManualHandDeliveryEnabled =
    !isDelegateCheckoutFlow && allowManualHandDelivery && manualHandDelivery === true;
  const isHandDeliveryEnabled = isDoctorHandDeliveryEnabled || isManualHandDeliveryEnabled;
  const bypassShippingRateSelection = isHandDeliveryEnabled || isFacilityPickupEnabled;
  const facilityPickupRecipientName =
    normalizeFacilityPickupRecipientName(facilityPickupRecipientNameDraft)
    || defaultFacilityPickupRecipientName
    || normalizeAddressField(FACILITY_PICKUP_ADDRESS.name);
  const resolveSubmittedFacilityPickupRecipientName = useCallback(
    () => (
      normalizeFacilityPickupRecipientName(facilityPickupRecipientNameDraftRef.current)
      || normalizeFacilityPickupRecipientName(facilityPickupRecipientNameSavedRef.current)
      || defaultFacilityPickupRecipientName
    ),
    [defaultFacilityPickupRecipientName],
  );
  const effectiveCheckoutAddress = isFacilityPickupEnabled
    ? {
        ...FACILITY_PICKUP_ADDRESS,
        name: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        fullName: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        recipientName: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        recipient_name: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        orderRecipientName: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        order_recipient_name: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        pickupRecipientName: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
        pickup_recipient_name: facilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
      }
    : shippingAddress;
  const effectiveShippingCost = bypassShippingRateSelection ? 0 : shippingCost;
  const localSalesRepDisplayName = String(salesRepName || '').trim() || 'Your sales rep';
  const taxAmount = Math.max(0, typeof taxEstimate?.amount === 'number' ? taxEstimate.amount : 0);
  const normalizedCredits = Math.max(0, Number(availableCredits || 0));
  const discountedSubtotal = Math.max(0, subtotal - discountCodeAmount);
  const appliedCredits = Math.min(discountedSubtotal, normalizedCredits);
  const total = Math.max(0, discountedSubtotal - appliedCredits + effectiveShippingCost + taxAmount);
  const testOverrideApplied = taxEstimate?.testPaymentOverrideApplied === true;
  const originalGrandTotal = typeof taxEstimate?.originalGrandTotal === 'number' && Number.isFinite(taxEstimate.originalGrandTotal)
    ? Math.max(0, taxEstimate.originalGrandTotal)
    : null;
  const displayAppliedCredits = testOverrideApplied ? 0 : appliedCredits;
  const displayShippingCost = testOverrideApplied ? 0 : effectiveShippingCost;
  const displayTaxAmount = testOverrideApplied ? 0 : taxAmount;
  const displayTotal = testOverrideApplied ? 0.01 : total;
  const isDelegateFlow = isDelegateCheckoutFlow;
  const shippingAddressSignature = buildAddressSignature(effectiveCheckoutAddress);
  const delegateShippingHandledByPhysician = isDelegateFlow;
  const shippingAddressComplete = delegateShippingHandledByPhysician ? true : isAddressComplete(effectiveCheckoutAddress);
  const taxAddressReady = delegateShippingHandledByPhysician ? false : isTaxAddressReady(effectiveCheckoutAddress);
  const isPaymentValid = true;
  const hasSelectedShippingRate = delegateShippingHandledByPhysician
    || bypassShippingRateSelection
    || Boolean(shippingRates && shippingRates.length > 0 && selectedRateIndex != null);
  const shouldFetchTax = Boolean(
    isOpen
    && (isAuthenticated || allowUnauthenticatedCheckout)
    && !delegateShippingHandledByPhysician
    && taxAddressReady
    && checkoutLineItems.length > 0
    && hasSelectedShippingRate,
  );
  const taxReady = !shouldFetchTax || (!!taxEstimate && !taxEstimatePending);
  const meetsCheckoutRequirements = termsAccepted
    && isPaymentValid
    && shippingAddressComplete
    && hasSelectedShippingRate
    && taxReady;
  const showCheckoutOptionsCard = showRetailPricingToggle || allowFacilityPickup;
  const taxQuoteKey = useMemo(() => {
    if (!shouldFetchTax) {
      return null;
    }
    const rateFingerprint = isFacilityPickupEnabled
      ? FACILITY_PICKUP_SERVICE_CODE
      : isHandDeliveryEnabled
        ? 'hand_delivery'
        : selectedShippingRate?.addressFingerprint
          || `${selectedShippingRate?.carrierId || 'carrier'}:${selectedShippingRate?.serviceCode || selectedShippingRate?.serviceType || 'service'}`;
    return [
      cartLineItemSignature || 'items',
      shippingAddressSignature || 'address',
      rateFingerprint,
      effectiveShippingCost.toFixed(2),
      paymentMethod || 'payment',
      discountCodeApplied?.code || 'no-discount',
      discountCodeAmount.toFixed(2),
    ].join('|');
  }, [
    shouldFetchTax,
    cartLineItemSignature,
    shippingAddressSignature,
    isFacilityPickupEnabled,
    isHandDeliveryEnabled,
    selectedShippingRate,
    effectiveShippingCost,
    paymentMethod,
    discountCodeApplied?.code,
    discountCodeAmount,
  ]);
  const canCheckout = meetsCheckoutRequirements && (isAuthenticated || allowUnauthenticatedCheckout);
  const proposalMode = isDelegateFlow || Boolean(forceProposalMode);
  const showDualPricing = proposalMode && !isDelegateFlow && proposalMarkupPercentValue != null;
  const delegateComparisonPricingMode: PricingMode = 'wholesale';
  const delegateDoctorDisplayName = isDelegateFlow
    ? (['doctor', 'physician'].includes(String(delegateDoctorName || '').trim().toLowerCase())
      ? 'Physician'
      : `Dr. ${delegateDoctorName}`)
    : null;

  useEffect(() => {
    if (!isOpen) return;
    setFacilityPickupRecipientNameValue((prev) =>
      normalizeFacilityPickupRecipientName(prev) || defaultFacilityPickupRecipientName,
    );
    if (!normalizeFacilityPickupRecipientName(facilityPickupRecipientNameSavedRef.current)) {
      facilityPickupRecipientNameSavedRef.current = defaultFacilityPickupRecipientName;
      setFacilityPickupRecipientNameSaved(defaultFacilityPickupRecipientName);
    }
    if (isDelegateFlow) {
      const normalized = normalizeCheckoutPaymentMethod(delegatePaymentMethod) ?? 'none';
      setPaymentMethod(normalized);
      return;
    }
    if (paymentMethod === 'none') {
      setPaymentMethod('zelle');
    }
  }, [
    defaultFacilityPickupRecipientName,
    delegatePaymentMethod,
    isDelegateFlow,
    isOpen,
    paymentMethod,
    setFacilityPickupRecipientNameValue,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (isDelegateFlow || !isAuthenticated || allowUnauthenticatedCheckout) {
      setDiscountCodeDraft('');
      setDiscountCodeApplied(null);
      setDiscountCodeMessage(null);
    }
  }, [allowUnauthenticatedCheckout, isAuthenticated, isDelegateFlow, isOpen]);

  useEffect(() => {
    setDiscountCodeApplied(null);
    setDiscountCodeMessage(null);
  }, [cartCompositionSignature]);

  const handleApplyDiscountCode = useCallback(async () => {
    const code = discountCodeDraft.trim().toUpperCase();
    if (!code) {
      setDiscountCodeApplied(null);
      setDiscountCodeMessage(null);
      return;
    }
    if (!isAuthenticated || allowUnauthenticatedCheckout) {
      setDiscountCodeApplied(null);
      setDiscountCodeMessage('Sign in to apply discount codes.');
      return;
    }
    setDiscountCodeBusy(true);
    try {
      const cartQuantity = cartItems.reduce((sum, item) => {
        const qty = Number(item.quantity || 0);
        return sum + (Number.isFinite(qty) ? Math.max(0, qty) : 0);
      }, 0);
      const resp = await discountCodesAPI.preview(
        code,
        subtotal,
        cartQuantity,
        cartItems.map((item) => ({ quantity: item.quantity })),
      );
      if (resp?.valid) {
        const amount = Math.max(0, Number(resp.discountAmount || 0));
        const value = Math.max(0, Number(resp.discountValue || 0));
        const pricingOverrideRaw = resp?.pricingOverride;
        const pricingOverride =
          pricingOverrideRaw &&
          String(pricingOverrideRaw.mode || '').toLowerCase() === 'force_tier_band'
            ? {
                mode: 'force_tier_band' as const,
                minQuantity: Math.max(1, Number(pricingOverrideRaw.minQuantity) || 11),
                maxQuantity: Math.max(
                  Math.max(1, Number(pricingOverrideRaw.minQuantity) || 11),
                  Number(pricingOverrideRaw.maxQuantity) || 26,
                ),
              }
            : null;
        setDiscountCodeApplied({
          code: String(resp.code || code),
          discountValue: value,
          discountAmount: amount,
          pricingOverride,
        });
        setDiscountCodeMessage(null);
      } else {
        setDiscountCodeApplied(null);
        setDiscountCodeMessage(String(resp?.message || 'Invalid discount code'));
      }
    } catch (error: any) {
      setDiscountCodeApplied(null);
      setDiscountCodeMessage((error?.message || 'Failed to apply discount code').toString());
    } finally {
      setDiscountCodeBusy(false);
    }
  }, [allowUnauthenticatedCheckout, cartItems, discountCodeDraft, isAuthenticated, subtotal]);

  const delegatePaymentInstructionsText = useMemo(() => {
    if (!isDelegateFlow) return null;
    const raw = typeof delegatePaymentInstructions === 'string' ? delegatePaymentInstructions.trim() : '';
    return raw ? raw : null;
  }, [delegatePaymentInstructions, isDelegateFlow]);

  const paymentMethodTitle = useMemo(() => {
    if (paymentMethod === 'zelle') return 'Zelle';
    if (paymentMethod === 'bank_transfer') return 'Direct Bank Transfer';
    return '-';
  }, [paymentMethod]);

  let checkoutButtonLabel = isDelegateFlow
    ? `Share with ${delegateDoctorDisplayName}`
    : `Place Order (${displayTotal.toFixed(2)})`;
  if (checkoutStatus === 'success' && checkoutStatusMessage) {
    checkoutButtonLabel = checkoutStatusMessage;
  } else if (checkoutStatus === 'error' && checkoutStatusMessage) {
    checkoutButtonLabel = checkoutStatusMessage;
  } else if (taxEstimatePending && shouldFetchTax) {
    checkoutButtonLabel = 'Calculating taxes…';
  } else if (isProcessing) {
    checkoutButtonLabel = 'Processing order...';
  }

  const canRejectProposalInCheckout =
    Boolean(!isDelegateFlow && proposalMode && typeof onRejectProposal === 'function');

  const handleRejectProposalFromCheckout = useCallback(async () => {
    if (!canRejectProposalInCheckout || !onRejectProposal || isRejectingProposal) return;
    if (!rejectNotesOpen) {
      setRejectNotesOpen(true);
      return;
    }
    setIsRejectingProposal(true);
    try {
      await Promise.resolve(onRejectProposal(rejectNotesDraft.trim() || null));
      setRejectNotesDraft('');
      setRejectNotesOpen(false);
    } catch (error: any) {
      toast.error(
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unable to reject proposal right now.',
      );
    } finally {
      setIsRejectingProposal(false);
    }
  }, [canRejectProposalInCheckout, isRejectingProposal, onRejectProposal, rejectNotesDraft, rejectNotesOpen]);

  useEffect(() => {
    if (!isOpen || !canRejectProposalInCheckout) {
      setRejectNotesOpen(false);
      setRejectNotesDraft('');
    }
  }, [canRejectProposalInCheckout, isOpen]);

  // No-op referral handling removed

  const requiresBackorder = useMemo(() => {
    type Aggregate = { requested: number; inStock: boolean; stockQuantity: number | null };
    const aggregates = new Map<string, Aggregate>();

    for (const item of cartItems) {
      const product = item.product;
      const variant = item.variant ?? null;
      const key =
        typeof variant?.wooId === 'number'
          ? `variant:${variant.wooId}`
          : typeof product.wooId === 'number'
            ? `product:${product.wooId}`
            : `product:${product.id}`;
      const existing = aggregates.get(key) ?? {
        requested: 0,
        inStock: true,
        stockQuantity: null,
      };
      existing.requested += Math.max(0, Number(item.quantity) || 0);
      const lineInStock = variant ? variant.inStock : product.inStock;
      existing.inStock = existing.inStock && lineInStock !== false;
      const qtyCandidate = variant?.stockQuantity ?? product.stockQuantity ?? null;
      if (typeof qtyCandidate === 'number' && Number.isFinite(qtyCandidate) && qtyCandidate >= 0) {
        existing.stockQuantity =
          existing.stockQuantity == null ? Math.floor(qtyCandidate) : Math.min(existing.stockQuantity, Math.floor(qtyCandidate));
      }
      aggregates.set(key, existing);
    }

    for (const entry of aggregates.values()) {
      if (!entry.inStock) return true;
      if (entry.stockQuantity != null && entry.requested > entry.stockQuantity) return true;
    }
    return false;
  }, [cartItems]);

  const deliveryEstimate = useMemo(() => {
    if (!selectedShippingRate) return null;

    const now = new Date();
    const cutoffHourLocal = 13;
    const pacificHour = getHourInTimeZone(now, 'America/Los_Angeles');
    const isAfterCutoff = (pacificHour ?? now.getHours()) >= cutoffHourLocal;

    const backorderDays = 0;
    const historicalAverageDaysRaw = Number(taxEstimate?.shippingTiming?.averageBusinessDays);
    const historicalRoundedDaysRaw = Number(taxEstimate?.shippingTiming?.roundedBusinessDays);
    const baselineProcessingDays = Number.isFinite(historicalRoundedDaysRaw) && historicalRoundedDaysRaw > 0
      ? Math.max(1, Math.round(historicalRoundedDaysRaw))
      : 1;
    const processingMinDays = baselineProcessingDays + (isAfterCutoff ? 1 : 0);
    const processingMaxDays = processingMinDays + 1;
    const shipMinDays = backorderDays + processingMinDays;
    const shipMaxDays = backorderDays + processingMaxDays;
    const transitDaysRaw = Number(selectedShippingRate.estimatedDeliveryDays);
    const transitDays = Number.isFinite(transitDaysRaw) && transitDaysRaw > 0
      ? Math.round(transitDaysRaw)
      : (inferTransitDaysFromService(selectedShippingRate) ?? 0);

    const shipMinDate = addBusinessDays(now, shipMinDays);
    const shipMaxDate = addBusinessDays(now, shipMaxDays);
    const deliveryMinDate = addBusinessDays(shipMinDate, transitDays);
    const deliveryMaxDate = addBusinessDays(shipMaxDate, transitDays);

    const deliveryWindowLabel =
      deliveryMinDate.toDateString() === deliveryMaxDate.toDateString()
        ? deliveryMinDate.toLocaleDateString()
        : `${deliveryMinDate.toLocaleDateString()}–${deliveryMaxDate.toLocaleDateString()}`;

    const mathText = transitDays > 0
      ? `${processingMinDays}–${processingMaxDays} business day processing + ${transitDays} business day transit`
      : `${processingMinDays}–${processingMaxDays} business day processing`;
    const disclaimer =
      Number.isFinite(historicalAverageDaysRaw) && historicalAverageDaysRaw > 0
        ? `Baseline avg ${historicalAverageDaysRaw.toFixed(1)} business days, and to ensure our product is kept temperature controlled we ship only M-Th to avoid weekend warehouses.`
        : 'To ensure our product is kept temperature controlled we ship only M-Th to avoid weekend warehouses.';
    return {
      deliveryWindowLabel,
      mathText,
      disclaimer,
    };
  }, [requiresBackorder, selectedShippingRate, taxEstimate?.shippingTiming]);

  const delegateSubtotal = useMemo(() => {
    if (!showDualPricing || proposalMarkupPercentValue == null) return null;
    return cartItems.reduce((sum, item) => {
      const delegateUnitPrice = computeUnitPrice(item.product, item.variant ?? null, item.quantity, {
        pricingMode: delegateComparisonPricingMode,
        markupPercent: proposalMarkupPercentValue,
      });
      return sum + delegateUnitPrice * item.quantity;
    }, 0);
  }, [cartItems, delegateComparisonPricingMode, proposalMarkupPercentValue, showDualPricing]);

  const delegateTotal = useMemo(() => {
    if (delegateSubtotal == null) return null;
    return Math.max(0, delegateSubtotal + displayShippingCost + displayTaxAmount);
  }, [delegateSubtotal, displayShippingCost, displayTaxAmount]);

  const checkoutAddOnProducts = useMemo(
    () =>
      (availableAddOnProducts ?? []).filter(
        (product) => !cartItems.some((item) => item.product.id === product.id),
      ),
    [availableAddOnProducts, cartItems],
  );
  const showCheckoutAddOns = checkoutAddOnProducts.length > 0;

  const resolveAddOnVariant = useCallback((product: Product) => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    if (variants.length === 0) {
      return null;
    }
    return (
      variants.find((variant) => variant.id === product.defaultVariantId)
      ?? variants.find((variant) => variant.inStock)
      ?? variants[0]
      ?? null
    );
  }, []);

  const handleGetRates = async () => {
    if (!shippingAddressComplete) {
      const message = 'Enter the full shipping address before requesting shipping rates.';
      setShippingRateError(message);
      toast.error(message);
      return;
    }
    setShippingRateError(null);
    setIsFetchingRates(true);
    try {
      const defaultWeightOz = 16;
      const payload = {
        shippingAddress,
        items: cartItems.map((item) => {
          const dimensions = item.variant?.dimensions || item.product.dimensions || {};
          const rawWeight = item.variant?.weightOz ?? item.product.weightOz ?? null;
          const unitWeight =
            typeof rawWeight === 'number' && Number.isFinite(rawWeight) && rawWeight > 0
              ? rawWeight
              : defaultWeightOz;
          return {
            name: item.product.name,
            quantity: item.quantity,
            weightOz: unitWeight,
            lengthIn: dimensions?.lengthIn ?? null,
            widthIn: dimensions?.widthIn ?? null,
            heightIn: dimensions?.heightIn ?? null,
          };
        }),
      };
      const response = await shippingAPI.getRates(payload);
      const rates = Array.isArray(response?.rates) ? response.rates : [];
      setShippingRates(rates);
      setSelectedRateIndex(rates.length > 0 ? 0 : null);
      lastQuotedAddressRef.current = rates.length > 0 ? shippingAddressSignature : null;
      lastQuotedCartRef.current = rates.length > 0 ? cartLineItemSignature : null;
      if (!rates.length) {
        setShippingRateError('No shipping rates available for this address.');
      }
    } catch (error: any) {
      const message = error?.message || 'Unable to fetch shipping rates. Please check the address.';
      setShippingRateError(message);
      toast.error(message);
    } finally {
      setIsFetchingRates(false);
    }
  };

  const handleCheckout = async () => {
    const priceByCartItemId = new Map(
      checkoutLineItems.map((item) => [item.cartItemId, item.price]),
    );
    const checkoutItems: CheckoutPayloadItem[] = cartItems.map(({ id, product, quantity, note, variant }, index) => {
      const resolvedProductId = String(product.wooId ?? product.id);
      const resolvedVariantId = variant ? String(variant.wooId ?? variant.id) : null;
      const resolvedSku = (variant?.sku || product.sku || '').trim() || null;
      const unitWeightOzRaw = variant?.weightOz ?? product.weightOz ?? null;
      const dimensions = variant?.dimensions || product.dimensions || null;
      const priceCandidate = priceByCartItemId.get(id);
      const unitPrice = Number.isFinite(priceCandidate as number)
        ? Number(priceCandidate)
        : computeUnitPrice(product, variant ?? null, quantity, {
            pricingMode: resolvedPricingMode,
            markupPercent: pricingMarkupPercent,
            forcedTierRange:
              discountPricingOverride?.mode === 'force_tier_band'
                ? {
                    minQuantity: discountPricingOverride.minQuantity,
                    maxQuantity: discountPricingOverride.maxQuantity,
                  }
                : null,
          });

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
        weightOz: typeof unitWeightOzRaw === 'number' && Number.isFinite(unitWeightOzRaw) ? unitWeightOzRaw : null,
        lengthIn:
          typeof dimensions?.lengthIn === 'number' && Number.isFinite(dimensions.lengthIn)
            ? dimensions.lengthIn
            : null,
        widthIn:
          typeof dimensions?.widthIn === 'number' && Number.isFinite(dimensions.widthIn)
            ? dimensions.widthIn
            : null,
        heightIn:
          typeof dimensions?.heightIn === 'number' && Number.isFinite(dimensions.heightIn)
            ? dimensions.heightIn
            : null,
      };
    });
    const delegateAmountDue =
      showDualPricing && delegateTotal != null
        ? Number(delegateTotal.toFixed(2))
        : null;
    console.debug('[CheckoutModal] Checkout start', {
      total,
      delegateAmountDue,
      items: checkoutItems.map((item) => ({
        cartItemId: item.cartItemId,
        productId: item.productId,
        variantId: item.variantId,
        qty: item.quantity,
        price: item.price,
      })),
    });
	    setIsProcessing(true);
    try {
      const noShippingRate: ShippingRate | null = bypassShippingRateSelection
        ? {
            carrierId: isFacilityPickupEnabled ? FACILITY_PICKUP_SERVICE_CODE : 'hand_delivery',
            serviceCode: isFacilityPickupEnabled ? FACILITY_PICKUP_SERVICE_CODE : 'hand_delivery',
            serviceType: isFacilityPickupEnabled ? 'Facility pickup' : 'Hand delivered',
            estimatedDeliveryDays: null,
            deliveryDateGuaranteed: null,
            rate: 0,
            currency: 'USD',
            addressFingerprint: shippingAddressSignature || null,
          }
        : null;
      const submittedFacilityPickupRecipientName = isFacilityPickupEnabled
        ? resolveSubmittedFacilityPickupRecipientName()
        : null;
      if (isFacilityPickupEnabled && !submittedFacilityPickupRecipientName) {
        const message = 'Enter the facility pickup recipient name before placing the order.';
        setCheckoutStatus('error');
        setCheckoutStatusMessage(message);
        toast.error(message);
        return;
      }
      if (isFacilityPickupEnabled && submittedFacilityPickupRecipientName) {
        facilityPickupRecipientNameSavedRef.current = submittedFacilityPickupRecipientName;
        setFacilityPickupRecipientNameSaved(submittedFacilityPickupRecipientName);
        setFacilityPickupRecipientNameValue(submittedFacilityPickupRecipientName);
      }
      const checkoutShippingAddress = delegateShippingHandledByPhysician
        ? null
        : isFacilityPickupEnabled
          ? {
              ...FACILITY_PICKUP_ADDRESS,
              name: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              fullName: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              recipientName: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              recipient_name: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              orderRecipientName: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              order_recipient_name: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              pickupRecipientName: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
              pickup_recipient_name: submittedFacilityPickupRecipientName || FACILITY_PICKUP_ADDRESS.name,
            }
          : effectiveCheckoutAddress;
      const checkoutShippingRate = delegateShippingHandledByPhysician
        ? null
        : bypassShippingRateSelection
          ? noShippingRate
          : selectedShippingRate;
      const checkoutShippingTotal = delegateShippingHandledByPhysician ? 0 : effectiveShippingCost;
      if (isFacilityPickupEnabled) {
        console.info('[CheckoutModal] Facility pickup recipient submit', {
          recipientName: submittedFacilityPickupRecipientName,
          shippingName: checkoutShippingAddress?.name ?? null,
          facilityPickup: true,
        });
      }
	      const result = await onCheckout({
	        shippingAddress: checkoutShippingAddress,
	        shippingRate: checkoutShippingRate,
	        shippingTotal: checkoutShippingTotal,
          delegateAmountDue,
          delegateAmountDueCurrency: delegateAmountDue != null ? 'USD' : null,
          handDelivery: isHandDeliveryEnabled,
          facilityPickup: isFacilityPickupEnabled,
          facilityPickupRecipientName: isFacilityPickupEnabled
            ? submittedFacilityPickupRecipientName
            : null,
	        expectedShipmentWindow: delegateShippingHandledByPhysician ? null : (deliveryEstimate?.deliveryWindowLabel ?? null),
	        physicianCertificationAccepted: termsAccepted,
	        taxTotal: taxAmount,
	        paymentMethod: paymentMethod === 'none' ? null : paymentMethod,
	        discountCode: discountCodeApplied?.code ?? null,
          discountCodeAmount: discountCodeAmount,
          items: checkoutItems,
	      });
	      if (isDelegateFlow) {
	        const candidateMessage =
	          result && typeof result === 'object' && 'message' in result && (result as any).message
	            ? String((result as any).message)
	            : null;
	        const successMessage = candidateMessage || `Shared with ${delegateDoctorDisplayName || 'Physician'}`;
	        setPlacedOrderNumber(null);
	        setCheckoutStatus('success');
	        setCheckoutStatusMessage(successMessage);
	        toast.success(successMessage);
	        console.debug('[CheckoutModal] Delegate share success');
	        if (onClearCart) {
	          onClearCart();
	        }
	        if (onPaymentSuccess) {
	          onPaymentSuccess();
	        }
	        if (checkoutStatusTimer.current) {
	          clearTimeout(checkoutStatusTimer.current);
	        }
	        checkoutStatusTimer.current = setTimeout(() => {
	          setCheckoutStatus('idle');
	          setCheckoutStatusMessage(null);
	          onClose();
	        }, 8000);
	        return;
	      }
	      const extractWooOrderNumber = (value: CheckoutResult | null | undefined): string | null => {
	        if (!value) return null;
	        const response = value.integrations?.wooCommerce?.response || null;
	        const paymentUrl =
	          response?.paymentUrl || response?.payForOrderUrl || response?.payment_url || null;
	        const parseFromPaymentUrl = () => {
	          if (!paymentUrl) return null;
	          const text = String(paymentUrl);
	          const match = text.match(/order-pay\/(\d+)/i);
	          return match && match[1] ? match[1] : null;
	        };

	        const candidates = [
	          response?.number,
	          value.order?.wooOrderNumber,
	          value.order?.number,
	          response?.id,
	          parseFromPaymentUrl(),
	          value.order?.wooOrderId,
	        ];

	        for (const candidate of candidates) {
	          if (candidate === null || candidate === undefined) continue;
	          const normalized = String(candidate).trim().replace(/^#/, '');
	          if (normalized) return normalized;
	        }
	        return null;
	      };

	      const normalizedOrderNumber = extractWooOrderNumber(result);
	      setPlacedOrderNumber(normalizedOrderNumber);
	      const isZelle = paymentMethod === 'zelle';
	      const isBankTransfer = paymentMethod === 'bank_transfer';
	      const isTransferMethod = isZelle || isBankTransfer;
	      const transferSuccessMessage = (() => {
	        if (isZelle) {
	          return normalizedOrderNumber
	            ? `We received your order! Please Zelle support@peppro.net with the memo 'Order #${normalizedOrderNumber}'. Instructions to follow in an email.`
	            : `We received your order! Please Zelle support@peppro.net. Instructions to follow in an email.`;
	        }
	        if (isBankTransfer) {
	          return 'We received your order! An email will follow with Direct Bank Trasnfer (ACH) instructions.';
	        }
	        return 'We received your order!';
	      })();
	      const defaultSuccessMessage = result && typeof result === 'object' && 'message' in result && result.message
	        ? String(result.message)
	        : 'We received your order!';
	      const successMessage = isTransferMethod
	        ? transferSuccessMessage
	        : defaultSuccessMessage;

	      setCheckoutStatus('success');
	      setCheckoutStatusMessage(normalizedOrderNumber ? `Order #${normalizedOrderNumber} placed` : successMessage);
	      const toastMessage = isTransferMethod
	        ? transferSuccessMessage
	        : (normalizedOrderNumber ? `Order #${normalizedOrderNumber} placed.` : successMessage);
	      toast.success(toastMessage);
      console.debug('[CheckoutModal] Checkout success');
      if (onClearCart) {
        onClearCart();
      }
      if (onPaymentSuccess) {
        onPaymentSuccess();
      }
      if (checkoutStatusTimer.current) {
        clearTimeout(checkoutStatusTimer.current);
      }
      checkoutStatusTimer.current = setTimeout(() => {
        setCheckoutStatus('idle');
        setCheckoutStatusMessage(null);
        onClose();
      }, 8000);
    } catch (error: any) {
      console.warn('[CheckoutModal] Checkout handler threw', error);
      const message = getCheckoutErrorMessage(error);
      setCheckoutStatus('error');
      setCheckoutStatusMessage(message);
      toast.error(message);
      throw error;
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePrimaryAction = async () => {
    if (!termsAccepted || !isPaymentValid) {
      toast.error('Accept the terms to continue.');
      return;
    }
    if (!delegateShippingHandledByPhysician && !shippingAddressComplete) {
      toast.error('Enter the full shipping address before placing your order.');
      return;
    }
    if (!delegateShippingHandledByPhysician && !hasSelectedShippingRate) {
      toast.error('Select a shipping option before completing your purchase.');
      return;
    }
    if (!delegateShippingHandledByPhysician && shouldFetchTax && (!taxEstimate || taxEstimatePending)) {
      toast.error('We are calculating taxes for this order. Please try again in a moment.');
      return;
    }
    if (!isAuthenticated && !allowUnauthenticatedCheckout) {
      onRequireLogin();
      return;
    }
    if (isProcessing) {
      console.debug('[CheckoutModal] Checkout ignored, already processing');
      return;
    }
    try {
      console.debug('[CheckoutModal] Checkout button confirmed');
      await handleCheckout();
    } catch {
      // Error message already shown in button state
    }
  };

  const handleIncreaseQuantity = (cartItemId: string, currentQuantity: number) => {
    const next = Math.min(999, currentQuantity + 1);
    setQuantityInputs((prev) => ({ ...prev, [cartItemId]: String(next) }));
    onUpdateItemQuantity(cartItemId, next);
    setBulkOpenMap((prev) => ({ ...prev, [cartItemId]: true }));
  };

  const handleDecreaseQuantity = (cartItemId: string, currentQuantity: number) => {
    const next = Math.max(1, currentQuantity - 1);
    setQuantityInputs((prev) => ({ ...prev, [cartItemId]: String(next) }));
    onUpdateItemQuantity(cartItemId, next);
    setBulkOpenMap((prev) => ({ ...prev, [cartItemId]: true }));
  };

  const handleQuantityInputChange = (cartItemId: string, value: string) => {
    const digits = value.replace(/[^0-9]/g, '');
    setQuantityInputs((prev) => ({ ...prev, [cartItemId]: digits }));
    if (digits) {
      const normalized = Math.max(1, Math.min(999, parseInt(digits, 10)));
      onUpdateItemQuantity(cartItemId, normalized);
      setBulkOpenMap((prev) => ({ ...prev, [cartItemId]: true }));
    }
  };

  const handleQuantityInputBlur = (cartItemId: string) => {
    if (!quantityInputs[cartItemId]) {
      setQuantityInputs((prev) => ({ ...prev, [cartItemId]: '1' }));
      onUpdateItemQuantity(cartItemId, 1);
    }
  };

  const handleRemoveItem = (cartItemId: string) => {
    console.debug('[CheckoutModal] Remove item request', { cartItemId });
    onRemoveItem(cartItemId);
    setQuantityInputs((prev) => {
      const { [cartItemId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      // referral fields removed
      setQuantityInputs({});
      setIsProcessing(false);
      setBulkOpenMap({});
      setTermsAccepted(false);
      setPaymentMethod('zelle');
      setManualHandDelivery(false);
      setFacilityPickup(false);
      setFacilityPickupRecipientNameValue(defaultFacilityPickupRecipientName);
      facilityPickupRecipientNameSavedRef.current = defaultFacilityPickupRecipientName;
      setFacilityPickupRecipientNameSaved(defaultFacilityPickupRecipientName);
      setPlacedOrderNumber(null);
      setCheckoutStatus('idle');
      setCheckoutStatusMessage(null);
      setShippingRates(null);
      setSelectedRateIndex(null);
      setShippingRateError(null);
      lastQuotedCartRef.current = null;
      setTaxEstimate(null);
      setTaxEstimateError(null);
      setTaxEstimatePending(false);
      lastTaxQuoteRef.current = null;
      initialDefaultRateAppliedRef.current = false;
      if (activeTaxRequestRef.current) {
        activeTaxRequestRef.current.abort();
        activeTaxRequestRef.current = null;
      }
      setShippingAddress({
        name: defaultShippingAddress?.name || physicianName || customerName || '',
        addressLine1: defaultShippingAddress?.addressLine1 || '',
        addressLine2: defaultShippingAddress?.addressLine2 || '',
        city: defaultShippingAddress?.city || '',
        state: defaultShippingAddress?.state || '',
        postalCode: defaultShippingAddress?.postalCode || '',
        country: defaultShippingAddress?.country || 'US',
      });
      if (checkoutStatusTimer.current) {
        clearTimeout(checkoutStatusTimer.current);
        checkoutStatusTimer.current = null;
      }
    }
  }, [
    defaultFacilityPickupRecipientName,
    defaultShippingAddress,
    customerName,
    isOpen,
    physicianName,
    setFacilityPickupRecipientNameValue,
  ]);

  useEffect(() => {
    if (!isOpen || initialDefaultRateAppliedRef.current) {
      return;
    }
    const normalizedRate = normalizeShippingRate(defaultShippingRate);
    if (!normalizedRate) {
      initialDefaultRateAppliedRef.current = true;
      return;
    }
    const hydratedRate: ShippingRate = {
      ...normalizedRate,
      // Treat preloaded proposal/default rates as quoted for the current address/cart
      // so they are not immediately invalidated by the "proposal updated" guard.
      addressFingerprint:
        normalizedRate.addressFingerprint || shippingAddressSignature || null,
    };
    setShippingRates([hydratedRate]);
    setSelectedRateIndex(0);
    setShippingRateError(null);
    lastQuotedAddressRef.current = shippingAddressSignature || null;
    lastQuotedCartRef.current = cartLineItemSignature || null;
    initialDefaultRateAppliedRef.current = true;
  }, [cartLineItemSignature, defaultShippingRate, isOpen, shippingAddressSignature]);

  useEffect(() => {
    setShippingAddress((prev) => ({
      ...prev,
      name: defaultShippingAddress?.name || physicianName || customerName || prev.name || '',
      addressLine1: defaultShippingAddress?.addressLine1 ?? prev.addressLine1 ?? '',
      addressLine2: defaultShippingAddress?.addressLine2 ?? prev.addressLine2 ?? '',
      city: defaultShippingAddress?.city ?? prev.city ?? '',
      state: defaultShippingAddress?.state ?? prev.state ?? '',
      postalCode: defaultShippingAddress?.postalCode ?? prev.postalCode ?? '',
      country: defaultShippingAddress?.country ?? prev.country ?? 'US',
    }));
  }, [defaultShippingAddress, physicianName, customerName]);

  useEffect(() => {
    if (cartItems.length === 0) {
      setQuantityInputs({});
      return;
    }

    const nextInputs: Record<string, string> = {};
    cartItems.forEach((item) => {
      nextInputs[item.id] = String(item.quantity);
    });
    setQuantityInputs(nextInputs);
    setBulkOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      cartItems.forEach((item) => {
        next[item.id] = prev[item.id] ?? false;
      });
      return next;
    });
  }, [cartItems]);

  useEffect(() => {
    if (!shippingRates || shippingRates.length === 0) {
      lastQuotedAddressRef.current = null;
      return;
    }
    if (lastQuotedAddressRef.current === shippingAddressSignature) {
      return;
    }
    lastQuotedAddressRef.current = null;
    setShippingRates(null);
    setSelectedRateIndex(null);
    setShippingRateError('Shipping address changed. Please fetch shipping rates again.');
  }, [shippingAddressSignature, shippingRates]);

  useEffect(() => {
    if (!shippingRates || shippingRates.length === 0) {
      lastQuotedCartRef.current = null;
      return;
    }
    if (lastQuotedCartRef.current === cartLineItemSignature) {
      return;
    }
    lastQuotedCartRef.current = null;
    setShippingRates(null);
    setSelectedRateIndex(null);
    setShippingRateError(
      proposalMode
        ? 'Proposal updated. Please fetch shipping rates again.'
        : 'Cart updated. Please fetch shipping rates again.',
    );
  }, [cartLineItemSignature, shippingRates]);

  const requestTaxEstimate = useCallback(async (options?: { force?: boolean }) => {
    if (!shouldFetchTax || !taxQuoteKey) {
      return;
    }
    if (!bypassShippingRateSelection && !selectedShippingRate) {
      return;
    }
    if (!options?.force && lastTaxQuoteRef.current?.key === taxQuoteKey) {
      return;
    }
    if (activeTaxRequestRef.current) {
      activeTaxRequestRef.current.abort();
    }
    const controller = new AbortController();
    activeTaxRequestRef.current = controller;
    if (lastTaxQuoteRef.current?.key !== taxQuoteKey) {
      setTaxEstimate(null);
    }
    setTaxEstimatePending(true);
    setTaxEstimateError(null);
    try {
      const estimate = estimateTotals ?? ordersAPI.estimateTotals;
      const noShippingRate: ShippingRate | null = bypassShippingRateSelection
        ? {
            carrierId: isFacilityPickupEnabled ? FACILITY_PICKUP_SERVICE_CODE : 'hand_delivery',
            serviceCode: isFacilityPickupEnabled ? FACILITY_PICKUP_SERVICE_CODE : 'hand_delivery',
            serviceType: isFacilityPickupEnabled ? 'Facility pickup' : 'Hand delivered',
            estimatedDeliveryDays: null,
            deliveryDateGuaranteed: null,
            rate: 0,
            currency: 'USD',
            addressFingerprint: shippingAddressSignature || null,
          }
        : null;
      const response = await estimate(
        {
          items: checkoutLineItems.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            price: item.price,
            quantity: item.quantity,
          })),
          shippingAddress: effectiveCheckoutAddress,
          shippingEstimate: bypassShippingRateSelection ? noShippingRate : selectedShippingRate,
          shippingTotal: effectiveShippingCost,
          handDelivery: isHandDeliveryEnabled,
          facilityPickup: isFacilityPickupEnabled,
          paymentMethod,
          discountCode: discountCodeApplied?.code ?? null,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      const totals = response?.totals || null;
      const amount = Math.max(0, Number(totals?.taxTotal) || 0);
      const grandTotalFromApi = Number(totals?.grandTotal);
      const fallbackGrandTotal = Math.max(0, discountedSubtotal - appliedCredits + effectiveShippingCost + amount);
      const testPaymentOverrideApplied = totals?.testPaymentOverrideApplied === true;
      const originalGrandTotalCandidate = Number(totals?.originalGrandTotal);
      setTaxEstimate({
        amount,
        currency: typeof totals?.currency === 'string' && totals.currency ? totals.currency : 'USD',
        grandTotal: Number.isFinite(grandTotalFromApi) ? Math.max(0, grandTotalFromApi) : fallbackGrandTotal,
        source: totals?.source || null,
        testPaymentOverrideApplied,
        originalGrandTotal: Number.isFinite(originalGrandTotalCandidate) ? Math.max(0, originalGrandTotalCandidate) : null,
        shippingTiming:
          response?.shippingTiming && typeof response.shippingTiming === 'object'
            ? {
                averageBusinessDays:
                  typeof response.shippingTiming.averageBusinessDays === 'number' &&
                  Number.isFinite(response.shippingTiming.averageBusinessDays)
                    ? response.shippingTiming.averageBusinessDays
                    : null,
                roundedBusinessDays:
                  typeof response.shippingTiming.roundedBusinessDays === 'number' &&
                  Number.isFinite(response.shippingTiming.roundedBusinessDays)
                    ? response.shippingTiming.roundedBusinessDays
                    : null,
                sampleSize:
                  typeof response.shippingTiming.sampleSize === 'number' &&
                  Number.isFinite(response.shippingTiming.sampleSize)
                    ? response.shippingTiming.sampleSize
                    : null,
                usedHistoricalAverage: response.shippingTiming.usedHistoricalAverage === true,
              }
            : null,
      });
      lastTaxQuoteRef.current = { key: taxQuoteKey, ts: Date.now() };
    } catch (error: any) {
      if (controller.signal.aborted) {
        return;
      }
      const message = typeof error?.message === 'string' && error.message.trim()
        ? sanitizeServiceNames(error.message)
        : 'Unable to calculate taxes right now. Please try again.';
      setTaxEstimateError(message);
      setTaxEstimate(null);
      lastTaxQuoteRef.current = null;
    } finally {
      if (activeTaxRequestRef.current === controller) {
        activeTaxRequestRef.current = null;
      }
      if (!controller.signal.aborted) {
        setTaxEstimatePending(false);
      }
    }
  }, [
    appliedCredits,
    checkoutLineItems,
    discountedSubtotal,
    estimateTotals,
    paymentMethod,
    selectedShippingRate,
    bypassShippingRateSelection,
    isFacilityPickupEnabled,
    isHandDeliveryEnabled,
    shippingAddressSignature,
    effectiveCheckoutAddress,
    effectiveShippingCost,
    shouldFetchTax,
    taxQuoteKey,
    discountCodeApplied?.code,
  ]);

  useEffect(() => {
    if (!shouldFetchTax || !taxQuoteKey) {
      if (activeTaxRequestRef.current) {
        activeTaxRequestRef.current.abort();
        activeTaxRequestRef.current = null;
      }
      setTaxEstimate(null);
      setTaxEstimateError(null);
      setTaxEstimatePending(false);
      lastTaxQuoteRef.current = null;
      return;
    }

    requestTaxEstimate().catch((error) => {
      console.warn('[CheckoutModal] Tax estimate failed', error);
    });

    return () => {
      if (activeTaxRequestRef.current) {
        activeTaxRequestRef.current.abort();
        activeTaxRequestRef.current = null;
      }
    };
  }, [requestTaxEstimate, shouldFetchTax, taxQuoteKey]);

  const handleRetryTaxEstimate = useCallback(() => {
    lastTaxQuoteRef.current = null;
    requestTaxEstimate({ force: true }).catch((error) => {
      console.warn('[CheckoutModal] Tax estimate retry failed', error);
    });
  }, [requestTaxEstimate]);

  const isCartEmpty = cartItems.length === 0;

  if (isCartEmpty) {
    return null;
  }

  // `--modal-header-offset` already includes a small extra gap (+0.5rem) to
  // avoid the header feeling cramped. For checkout, reduce that gap so the
  // modal sits closer to the header.
  const checkoutModalTopOffset = 'calc(var(--modal-header-offset, 6rem) + var(--safe-area-top, 0px) - 0.5rem)';

    return (
      <Dialog
        open={isOpen}
        modal={!legalModalOpen}
        onOpenChange={(open) => {
          console.debug('[CheckoutModal] Dialog open change', { open });
          if (!open) {
            if (legalModalOpen) {
            console.debug('[CheckoutModal] Close request blocked by legal modal');
            return;
          }
          onClose();
        }
      }}
    >
	        <DialogContent
	          hideCloseButton
	          className="checkout-modal glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
	          style={{
              backdropFilter: 'blur(38px) saturate(1.6)',
              // Match the reduced top offset so we don't keep "reserved" empty space
              // in the dialog sizing calculation.
              maxHeight:
                'calc(var(--viewport-height, 100dvh) - var(--modal-header-offset, 6rem) + 0.5rem - clamp(1.5rem, 6vh, 3rem))',
            }}
	          overlayClassName="bg-slate-950/40 z-[9000]"
            overlayStyle={{ top: checkoutModalTopOffset }}
	          containerStyle={
	            legalModalOpen
	              ? {
	                  pointerEvents: 'none',
	                  zIndex: 11000,
	                  top: checkoutModalTopOffset,
	                }
	              : {
	                  zIndex: 11000,
	                  top: checkoutModalTopOffset,
	                }
	          }
	          data-legal-overlay={legalModalOpen ? 'true' : 'false'}
          trapFocus={!legalModalOpen}
          disableOutsidePointerEvents={false}
        >
        <DialogHeader className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg">
          <div className="flex items-start justify-between gap-4">
	            <div className="flex-1 min-w-0">
	              <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
	                {proposalMode ? 'Proposal' : 'Checkout'}
	              </DialogTitle>
	              <DialogDescription>
	                {proposalMode
	                  ? (isDelegateFlow
	                    ? `Review your proposal and share it with ${delegateDoctorDisplayName || 'the physician'}.`
	                    : 'Review this proposal and place your order.')
	                  : 'Review and place your order.'}
	              </DialogDescription>
	            </div>
            <DialogClose
              className="dialog-close-btn inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full p-0 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              style={{
                backgroundColor: 'rgb(95, 179, 249)',
                borderRadius: '50%',
              }}
	              aria-label={proposalMode ? 'Close proposal' : 'Close checkout'}
	            >
              <X className="h-4 w-4 text-white" />
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3" ref={checkoutScrollRef}>
          <div className="space-y-6">
            <>
              {/* Cart Items */}
              <div className="space-y-4">
                <h3>Order Summary</h3>
                {showCheckoutOptionsCard && (
                  <div
                    className={`glass-card squircle-lg flex flex-wrap items-center justify-between gap-4 border px-6 py-4 transition-colors ${
                      retailPricingEnabled || isFacilityPickupEnabled
                        ? 'border-[rgba(34,197,94,0.38)] shadow-[0_20px_48px_-38px_rgba(34,197,94,0.35)]'
                        : 'border-[rgba(95,179,249,0.28)] shadow-[0_20px_48px_-40px_rgba(95,179,249,0.22)] hover:border-[rgba(95,179,249,0.42)]'
                    }`}
                  >
                    <div className="flex w-full flex-col gap-4">
                      {showRetailPricingToggle && (
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div className="flex items-center gap-4">
                            <input
                              id="retail-pricing-toggle"
                              type="checkbox"
                              className="brand-checkbox"
                              checked={retailPricingEnabled}
                              onChange={(event) => {
                                const next: PricingMode = event.target.checked ? 'retail' : 'wholesale';
                                onPricingModeChange?.(next);
                              }}
                            />
                            <div className="flex flex-col">
                              <label htmlFor="retail-pricing-toggle" className="text-base font-semibold text-slate-900">
                                Retail pricing
                              </label>
                              <span className="text-xs text-slate-600">For Sales Reps only</span>
                            </div>
                          </div>
                          {retailPricingEnabled && (
                            <span className="inline-flex items-center rounded-full border border-green-200/80 bg-green-50/70 px-3 py-1 text-xs font-semibold text-green-800">
                              Enabled
                            </span>
                          )}
                        </div>
                      )}
                      {allowFacilityPickup && !isDelegateFlow && (
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div className="flex items-center gap-4">
                            <input
                              id="facility-pickup-toggle"
                              type="checkbox"
                              className="brand-checkbox"
                              checked={isFacilityPickupEnabled}
                              onChange={(event) => {
                                const nextChecked = event.target.checked;
                                setFacilityPickup(nextChecked);
                                if (nextChecked) {
                                  setManualHandDelivery(false);
                                  setFacilityPickupRecipientNameValue((prev) =>
                                    normalizeFacilityPickupRecipientName(prev) || defaultFacilityPickupRecipientName,
                                  );
                                  facilityPickupRecipientNameSavedRef.current =
                                    normalizeFacilityPickupRecipientName(facilityPickupRecipientNameSavedRef.current)
                                    || defaultFacilityPickupRecipientName;
                                  setFacilityPickupRecipientNameSaved(facilityPickupRecipientNameSavedRef.current);
                                }
                              }}
                            />
                            <div className="flex flex-col">
                              <label htmlFor="facility-pickup-toggle" className="text-base font-semibold text-slate-900">
                                Facility Pickup
                              </label>
                              <span className="text-xs text-slate-600">
                                Use PepPro&apos;s facility address and skip shipping rates
                              </span>
                            </div>
                          </div>
                          {isFacilityPickupEnabled && (
                            <span className="inline-flex items-center rounded-full border border-green-200/80 bg-green-50/70 px-3 py-1 text-xs font-semibold text-green-800">
                              Enabled
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex w-full max-w-full flex-col gap-4 pb-2 lg:grid lg:grid-cols-2 auto-rows-fr">
                {cartItems.map((item, index) => {
                  const authoritativeLineItem = checkoutLineItemsByCartItemId.get(item.id) ?? null;
                  const shouldLockPhysicianCartPricing = !discountCodeApplied && authoritativeLineItem != null;
                  const baseImages = item.product.images.length > 0 ? item.product.images : [item.product.image];
                  const carouselImages = item.variant?.image
                    ? [item.variant.image, ...baseImages].filter((src, index, self) => src && self.indexOf(src) === index)
                    : baseImages;
	                  const computedDoctorUnitPrice = computeUnitPrice(item.product, item.variant, item.quantity, {
	                    pricingMode: resolvedPricingMode,
	                    markupPercent: 0,
	                  });
                    const doctorUnitPrice = shouldLockPhysicianCartPricing
                      ? authoritativeLineItem.price
                      : computedDoctorUnitPrice;
	                  const delegateUnitPrice =
	                    showDualPricing && proposalMarkupPercentValue != null
	                      ? computeUnitPrice(item.product, item.variant, item.quantity, {
	                          pricingMode: delegateComparisonPricingMode,
	                          markupPercent: proposalMarkupPercentValue,
	                        })
	                      : null;
	                  const computedUnitPrice = computeUnitPrice(item.product, item.variant, item.quantity, {
	                    pricingMode: resolvedPricingMode,
	                    markupPercent: pricingMarkupPercent,
	                  });
                    const unitPrice = shouldLockPhysicianCartPricing
                      ? authoritativeLineItem.price
                      : computedUnitPrice;
	                  const lineTotal = unitPrice * item.quantity;
	                  const delegateLineTotal = delegateUnitPrice != null ? delegateUnitPrice * item.quantity : null;
                  const activeBulkTiers = (
                    item.variant?.bulkPricingTiers ??
                    item.product.bulkPricingTiers ??
                    []
                  ).sort((a, b) => a.minQuantity - b.minQuantity);
                  const visibleTiers = getVisibleBulkTiers(item.product, item.quantity, item.variant);
                  const upcomingTier = activeBulkTiers.find((tier) => item.quantity < tier.minQuantity) || null;
                  const isBulkOpen = bulkOpenMap[item.id] ?? false;
                  return (
                    <Card
                      key={item.id}
                      className="glass squircle-sm h-full w-full"
                    >
                      <CardContent className="p-3 [&:last-child]:pb-3 relative">
                        <div className="checkout-item-scroll">
                          <div className="checkout-item-scroll-inner">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex items-start gap-4 min-w-0 flex-1">
                                <div className="checkout-item-image self-start">
                                  <ProductImageCarousel
                                    images={carouselImages}
                                    alt={item.product.name}
                                    className="flex h-full w-full items-center justify-center rounded-lg bg-white/80 p-2"
                                    imageClassName="h-full w-full object-contain"
                                    style={{ '--product-image-frame-padding': 'clamp(0.35rem, 0.75vw, 0.7rem)' } as CSSProperties}
                                    showDots={carouselImages.length > 1}
                                    showArrows={false}
                                  />
                                </div>
                                <div className="min-w-0">
                                  <h4 className="line-clamp-1">#{index + 1} — {item.product.name}</h4>
                                  <p className="text-sm text-gray-600">{item.product.dosage}</p>
                                  {item.variant && (
                                    <p className="text-xs text-gray-500">Variant: {item.variant.label}</p>
                                  )}
	                                  <div className="mt-2 mb-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
	                                    {showDualPricing && delegateUnitPrice != null ? (
	                                      <div className="flex flex-col leading-tight">
	                                        <span className={retailPricingEnabled ? 'text-green-700 font-bold tabular-nums' : 'text-green-600 font-bold tabular-nums'}>
	                                          <span className="text-[11px] font-semibold text-slate-500 mr-1">Physician:</span>
	                                          ${doctorUnitPrice.toFixed(2)}
	                                          {retailPricingEnabled ? (
	                                            <span className="ml-1 text-[11px] font-semibold text-green-700">(Retail)</span>
	                                          ) : null}
	                                        </span>
	                                        <span className="text-[rgb(95,179,249)] font-semibold tabular-nums text-[12px]">
	                                          <span className="text-[11px] font-semibold text-slate-500 mr-1">Delegate:</span>
	                                          ${delegateUnitPrice.toFixed(2)}
	                                        </span>
	                                      </div>
	                                    ) : (
	                                      <span className={retailPricingEnabled ? 'text-green-700 font-bold' : 'text-green-600 font-bold'}>
	                                        ${unitPrice.toFixed(2)}
	                                        {retailPricingEnabled ? (
	                                          <span className="ml-1 text-xs font-semibold text-green-700">(Retail)</span>
	                                        ) : null}
	                                      </span>
	                                    )}
	                                    <div className="flex items-center gap-2">
	                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="icon"
                                        onClick={() => handleDecreaseQuantity(item.id, item.quantity)}
                                        disabled={item.quantity <= 1}
                                        className="squircle-sm bg-slate-50 border-2"
                                      >
                                        <Minus className="h-4 w-4" />
                                      </Button>
                                      <Input
                                        value={quantityInputs[item.id] ?? String(item.quantity)}
                                        onChange={(event) => handleQuantityInputChange(item.id, event.target.value)}
                                        onBlur={() => handleQuantityInputBlur(item.id)}
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        className="w-16 text-center squircle-sm bg-slate-50 border-2"
                                      />
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="icon"
                                        onClick={() => handleIncreaseQuantity(item.id, item.quantity)}
                                        className="squircle-sm bg-slate-50 border-2"
                                      >
                                        <Plus className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  </div>
                                  {!retailPricingEnabled && visibleTiers.length > 0 && (
                                    <div className="mt-3 glass-card squircle-sm border border-[var(--brand-glass-border-2)] p-3 space-y-2">
                                      <button
                                        type="button"
                                        className="flex w-full items-center justify-between text-xs font-semibold text-slate-700"
                                        onClick={() =>
                                          setBulkOpenMap((prev) => ({ ...prev, [item.id]: !isBulkOpen }))
                                        }
                                      >
                                        <span className="tracking-wide uppercase text-[0.65rem]">Bulk Pricing</span>
                                        <span className="text-[rgb(95,179,249)] text-[0.65rem]">
                                          {isBulkOpen ? 'Hide' : 'Show'}
                                        </span>
                                      </button>
                                      {isBulkOpen && (
                                        <>
                                          <div className="space-y-1.5 pt-4">
                                            {visibleTiers.map((tier) => (
                                              <div
                                                key={`${tier.minQuantity}-${tier.discountPercentage}`}
                                                className="flex items-center justify-between rounded-md px-2 py-1 text-[0.8rem]"
                                              >
                                                <span
                                                  className={
                                                    item.quantity >= tier.minQuantity
                                                      ? 'text-green-600 font-semibold'
                                                      : 'text-slate-600'
                                                  }
                                                >
                                                  Buy {tier.minQuantity}+
                                                </span>
                                                <span
                                                  className={`tabular-nums ${
                                                    item.quantity >= tier.minQuantity
                                                      ? 'text-green-600 font-semibold'
                                                      : 'text-slate-600'
                                                  }`}
                                                >
                                                  Save {tier.discountPercentage}%
                                                </span>
                                              </div>
                                            ))}
                                          </div>
                                          {upcomingTier && (
                                            <p className="text-xs text-[rgb(95,179,249)] font-medium">
                                              Buy {upcomingTier.minQuantity - item.quantity} more to save {upcomingTier.discountPercentage}%
                                            </p>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  )}
                                  {item.note && (
                                    <p className="mt-2 text-xs text-gray-500">Notes: {item.note}</p>
                                  )}
                                </div>
                              </div>
	                              <div className="flex flex-col items-end gap-3 shrink-0 text-right">
	                                <div className="flex flex-col items-end leading-tight">
	                                  <p className={`${retailPricingEnabled ? 'text-green-700' : ''} font-bold tabular-nums tracking-tight`}>
	                                    ${lineTotal.toFixed(2)}
	                                  </p>
	                                  {showDualPricing && delegateLineTotal != null && (
	                                    <p className="text-[12px] font-semibold text-[rgb(95,179,249)] tabular-nums">
	                                      Delegate: ${delegateLineTotal.toFixed(2)}
	                                    </p>
	                                  )}
	                                </div>
	                                <Button
	                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleRemoveItem(item.id)}
                                  className="text-red-500 hover:text-red-600"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  <span className="sr-only">Remove item</span>
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                </div>
                {showCheckoutAddOns && (
                  <div className="space-y-4">
                    <h4>Available Add-ons</h4>
                    <div className="flex w-full max-w-full flex-col gap-4 pb-2 lg:grid lg:grid-cols-2 auto-rows-fr">
                      {checkoutAddOnProducts.map((product) => {
                        const preferredVariant = resolveAddOnVariant(product);
                        const showDosage =
                          typeof product.dosage === 'string' &&
                          product.dosage.trim().length > 0 &&
                          product.dosage.trim().toLowerCase() !== 'see details';
                        const baseImages = product.images.length > 0 ? product.images : [product.image];
                        const carouselImages = preferredVariant?.image
                          ? [preferredVariant.image, ...baseImages].filter(
                              (src, imageIndex, self) => src && self.indexOf(src) === imageIndex,
                            )
                          : baseImages;
                        const doctorUnitPrice = computeUnitPrice(product, preferredVariant, 1, {
                          pricingMode: resolvedPricingMode,
                          markupPercent: 0,
                        });
                        const delegateUnitPrice =
                          showDualPricing && proposalMarkupPercentValue != null
                            ? computeUnitPrice(product, preferredVariant, 1, {
                                pricingMode: delegateComparisonPricingMode,
                                markupPercent: proposalMarkupPercentValue,
                              })
                            : null;
                        const unitPrice = computeUnitPrice(product, preferredVariant, 1, {
                          pricingMode: resolvedPricingMode,
                          markupPercent: pricingMarkupPercent,
                        });

                        return (
                          <Card
                            key={product.id}
                            className="glass squircle-sm h-full w-full"
                          >
                            <CardContent className="p-3 [&:last-child]:pb-3 relative">
                              <div className="checkout-item-scroll">
                                <div className="checkout-item-scroll-inner">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-start gap-4 min-w-0 flex-1">
                                      <div className="checkout-item-image checkout-item-image--addon self-start">
                                        <ProductImageCarousel
                                          images={carouselImages}
                                          alt={product.name}
                                          className="flex h-full w-full items-center justify-center rounded-lg bg-white/80 p-2"
                                          imageClassName="h-full w-full object-contain"
                                          style={{ '--product-image-frame-padding': 'clamp(0.35rem, 0.75vw, 0.7rem)' } as CSSProperties}
                                          showDots={carouselImages.length > 1}
                                          showArrows={false}
                                        />
                                      </div>
                                      <div className="min-w-0">
                                        <h4 className="line-clamp-1">{product.name}</h4>
                                        {showDosage && (
                                          <p className="text-sm text-gray-600">{product.dosage}</p>
                                        )}
                                        {preferredVariant && (
                                          <p className="text-xs text-gray-500">Variant: {preferredVariant.label}</p>
                                        )}
                                        {product.manufacturer && (
                                          <p className="text-xs text-gray-500">{product.manufacturer}</p>
                                        )}
                                        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                                          {showDualPricing && delegateUnitPrice != null ? (
                                            <div className="flex flex-col leading-tight">
                                              <span className={retailPricingEnabled ? 'text-green-700 font-bold tabular-nums' : 'text-green-600 font-bold tabular-nums'}>
                                                <span className="text-[11px] font-semibold text-slate-500 mr-1">Physician:</span>
                                                ${doctorUnitPrice.toFixed(2)}
                                                {retailPricingEnabled ? (
                                                  <span className="ml-1 text-[11px] font-semibold text-green-700">(Retail)</span>
                                                ) : null}
                                              </span>
                                              <span className="text-[rgb(95,179,249)] font-semibold tabular-nums text-[12px]">
                                                <span className="text-[11px] font-semibold text-slate-500 mr-1">Delegate:</span>
                                                ${delegateUnitPrice.toFixed(2)}
                                              </span>
                                            </div>
                                          ) : (
                                            <span className={retailPricingEnabled ? 'text-green-700 font-bold' : 'text-green-600 font-bold'}>
                                              ${unitPrice.toFixed(2)}
                                              {retailPricingEnabled ? (
                                                <span className="ml-1 text-xs font-semibold text-green-700">(Retail)</span>
                                              ) : null}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-3 shrink-0 text-right">
                                      <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => onAddAddOn?.(product.id, preferredVariant?.id ?? null)}
                                        disabled={!onAddAddOn}
                                        className="header-home-button squircle-sm gap-2 bg-white text-slate-900"
                                      >
                                        <ShoppingCart className="mr-2 h-4 w-4" />
                                        Add to order
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Shipping */}
              <div className="space-y-4">
                <h3>{isFacilityPickupEnabled ? 'Pickup Location' : 'Shipping Address'}</h3>
                {allowManualHandDelivery && !isDelegateFlow && !isFacilityPickupEnabled && (
                  <div
                    className={`glass-card squircle-lg flex flex-wrap items-center justify-between gap-4 border px-6 py-4 transition-colors ${
                      manualHandDelivery
                        ? 'border-[rgba(34,197,94,0.38)] shadow-[0_20px_48px_-38px_rgba(34,197,94,0.35)]'
                        : 'border-[rgba(95,179,249,0.28)] shadow-[0_20px_48px_-40px_rgba(95,179,249,0.22)] hover:border-[rgba(95,179,249,0.42)]'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <input
                        id="manual-hand-delivery"
                        type="checkbox"
                        className="brand-checkbox"
                        checked={manualHandDelivery}
                        onChange={(event) => {
                          const nextChecked = event.target.checked;
                          setManualHandDelivery(nextChecked);
                          if (nextChecked) {
                            setFacilityPickup(false);
                          }
                        }}
                        disabled={isDoctorHandDeliveryEnabled}
                      />
                      <div className="flex flex-col">
                        <label htmlFor="manual-hand-delivery" className="text-base font-semibold text-slate-900">
                          Hand delivered
                        </label>
                        <span className="text-xs text-slate-600">Per-order local delivery override</span>
                      </div>
                    </div>
                    {manualHandDelivery && (
                      <span className="inline-flex items-center rounded-full border border-green-200/80 bg-green-50/70 px-3 py-1 text-xs font-semibold text-green-800">
                        Enabled
                      </span>
                    )}
                  </div>
                )}
                {isDoctorHandDeliveryEnabled && (
                  <div className="glass-card squircle-md border border-[rgba(95,179,249,0.45)] bg-gradient-to-r from-[rgba(95,179,249,0.16)] via-[rgba(95,179,249,0.10)] to-[rgba(255,255,255,0.75)] px-6 py-5 shadow-[0_14px_30px_-24px_rgba(95,179,249,0.9)]">
                    <p className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-[rgb(58,142,214)]">
                      <span>Local Hand Delivery</span>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="15"
                        height="15"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                        style={{ width: 18, height: 18, minWidth: 18, minHeight: 18, maxWidth: 18, maxHeight: 18, display: 'inline-block' }}
                        aria-hidden="true"
                      >
                        <path d="M6.63257 10.25C7.43892 10.25 8.16648 9.80416 8.6641 9.16967C9.43726 8.18384 10.4117 7.3634 11.5255 6.77021C12.2477 6.38563 12.8743 5.81428 13.1781 5.05464C13.3908 4.5231 13.5 3.95587 13.5 3.38338V2.75C13.5 2.33579 13.8358 2 14.25 2C15.4926 2 16.5 3.00736 16.5 4.25C16.5 5.40163 16.2404 6.49263 15.7766 7.46771C15.511 8.02604 15.8836 8.75 16.5019 8.75M16.5019 8.75H19.6277C20.6544 8.75 21.5733 9.44399 21.682 10.4649C21.7269 10.8871 21.75 11.3158 21.75 11.75C21.75 14.5976 20.7581 17.2136 19.101 19.2712C18.7134 19.7525 18.1142 20 17.4962 20H13.4802C12.9966 20 12.5161 19.922 12.0572 19.7691L8.94278 18.7309C8.48393 18.578 8.00342 18.5 7.51975 18.5H5.90421M16.5019 8.75H14.25M5.90421 18.5C5.98702 18.7046 6.07713 18.9054 6.17423 19.1022C6.37137 19.5017 6.0962 20 5.65067 20H4.74289C3.85418 20 3.02991 19.482 2.77056 18.632C2.43208 17.5226 2.25 16.3451 2.25 15.125C2.25 13.5725 2.54481 12.0889 3.08149 10.7271C3.38655 9.95303 4.16733 9.5 4.99936 9.5H6.05212C6.52404 9.5 6.7973 10.0559 6.5523 10.4593C5.72588 11.8198 5.25 13.4168 5.25 15.125C5.25 16.3185 5.48232 17.4578 5.90421 18.5Z" />
                      </svg>
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-800">
                      Your order will be delivered by {localSalesRepDisplayName}.
                      If unable to be delivered, we will ship your order to the address below (free of charge).
                    </p>
                  </div>
                )}
                {isFacilityPickupEnabled ? (
                  <div className="glass-card squircle-md border border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.08)] px-5 py-4">
                    <div className="space-y-4 rounded-xl bg-white/60 px-4 py-3">
                      <p className="text-sm font-semibold text-slate-900">Facility pickup selected.</p>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="facility-pickup-recipient-name">Recipient Name</Label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            id="facility-pickup-recipient-name"
                            placeholder="Full name"
                            value={facilityPickupRecipientNameDraft}
                            onChange={(e) => setFacilityPickupRecipientNameValue(e.target.value)}
                            onBlur={() =>
                              setFacilityPickupRecipientNameValue((prev) =>
                                normalizeFacilityPickupRecipientName(prev) || defaultFacilityPickupRecipientName,
                              )
                            }
                            className="squircle-sm bg-slate-50 border-2"
                          />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="header-home-button squircle-sm bg-white text-slate-900 shrink-0"
                              onClick={() => saveFacilityPickupRecipientName(false)}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      <div className="space-y-1 text-sm text-slate-800">
                      <p>640 S Grand Ave</p>
                      <p>Unit #107</p>
                      <p>Santa Ana, CA 92705</p>
                      </div>
                    </div>
                  </div>
                ) : isDelegateFlow ? (
                  <div className="glass-card squircle-md border border-[rgba(95,179,249,0.28)] bg-[rgba(95,179,249,0.08)] px-5 py-4">
                    <p className="text-sm font-semibold text-slate-900">Shipping is coordinated by your physician.</p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-700">
                      Additional shipping charges may be incurred if your physician has to ship to your address. Coordinate with your physician regarding shipping.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-name">Recipient Name</Label>
                        <Input
                          id="ship-name"
                          placeholder="Full name"
                          value={shippingAddress.name || ''}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, name: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-line1">Address Line 1</Label>
                        <Input
                          id="ship-line1"
                          placeholder="Street address"
                          value={shippingAddress.addressLine1 || ''}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, addressLine1: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-line2">Address Line 2</Label>
                        <Input
                          id="ship-line2"
                          placeholder="Apt, suite, etc. (optional)"
                          value={shippingAddress.addressLine2 || ''}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, addressLine2: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-city">City</Label>
                        <Input
                          id="ship-city"
                          placeholder="City"
                          value={shippingAddress.city || ''}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, city: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-state">State</Label>
                        <Input
                          id="ship-state"
                          placeholder="State"
                          value={shippingAddress.state || ''}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, state: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-postal">Postal Code</Label>
                        <Input
                          id="ship-postal"
                          placeholder="ZIP / Postal code"
                          value={shippingAddress.postalCode || ''}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, postalCode: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ship-country">Country</Label>
                        <Input
                          id="ship-country"
                          placeholder="Country"
                          value={shippingAddress.country || 'US'}
                          onChange={(e) => setShippingAddress((prev) => ({ ...prev, country: e.target.value }))}
                          className="squircle-sm bg-slate-50 border-2"
                        />
                      </div>
                    </div>
                    {!isHandDeliveryEnabled && (
                      <div className="flex items-center gap-3">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleGetRates}
                          disabled={isFetchingRates || cartItems.length === 0 || !shippingAddressComplete}
                          className={isDelegateFlow ? 'squircle-sm border-0 text-white' : 'squircle-sm'}
                          style={isDelegateFlow ? { backgroundColor: 'rgb(95, 179, 249)', borderColor: 'rgb(95, 179, 249)', color: '#ffffff', WebkitTextFillColor: '#ffffff' } : undefined}
                        >
                          {isFetchingRates ? 'Fetching rates...' : 'Get shipping rates'}
                        </Button>
                        {shippingRateError && <p className="text-sm text-red-600">{shippingRateError}</p>}
                      </div>
                    )}
                    {!isHandDeliveryEnabled && shippingRates && shippingRates.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-semibold text-slate-700">Select a service</h4>
                        <select
                          className="shipping-rate-select"
                          value={selectedRateIndex != null ? String(selectedRateIndex) : ''}
                          onChange={(event) => {
                            const idx = event.target.value ? Number(event.target.value) : null;
                            setSelectedRateIndex(idx);
                          }}
                        >
                          <option value="" disabled>
                            Choose a shipping option
                          </option>
                          {shippingRates.map((rate, index) => (
                            <option key={`${rate.serviceCode}-${index}`} value={index}>
                              {formatShippingServiceLabel(rate)} — ${Number(rate.rate || 0).toFixed(2)}
                            </option>
                          ))}
                        </select>
                        {selectedRateIndex != null && shippingRates[selectedRateIndex] && (
                          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                            {deliveryEstimate && (
                              <div className="space-y-1">
                                <p className="text-sm font-semibold text-slate-800">
                                  Estimated delivery window: {deliveryEstimate.deliveryWindowLabel}
                                </p>
                                <p className="text-xs text-slate-600">
                                  {deliveryEstimate.mathText}
                                </p>
                                {deliveryEstimate.disclaimer && (
                                  <p className="text-[11px] text-slate-500">
                                    {deliveryEstimate.disclaimer}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

	              {/* Payment Form */}
	              <div className="space-y-5">
	                <h3 className="mb-2">Payment Information</h3>
	                <div className="rounded-xl border border-slate-200 bg-white/70 px-3 py-4 mb-3 text-sm text-slate-700 leading-relaxed">
	                  <div className="flex items-center gap-2">
	                    {paymentMethod === "zelle" ? (
	                      <ArrowLeftRight
	                        size={20}
	                        className="text-slate-600 shrink-0 mb-1"
	                        aria-hidden="true"
	                      />
	                    ) : (
	                      <Landmark
	                        size={20}
	                        className="text-slate-600 shrink-0 mb-1"
	                        aria-hidden="true"
	                      />
	                    )}
	                    <p className="font-bold text-slate-800">
	                      {paymentMethodTitle}
	                    </p>
	                  </div>
	                  {isDelegateFlow ? (
	                    <>
	                      <p className="mt-2">
	                        Payment method is configured by {delegateDoctorDisplayName || 'the physician'} for this proposal.
	                      </p>
	                      <p className="mt-1">
	                        They apply a markup to the subtotal in the form of a service fee.
	                      </p>
	                      {delegatePaymentInstructionsText ? (
	                        <div className="mt-3 rounded-lg border border-slate-200 bg-white/70 px-3 py-2">
	                          <p className="text-xs font-semibold text-slate-700">Instructions</p>
	                          <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-700">
	                            {delegatePaymentInstructionsText}
	                          </p>
	                        </div>
	                      ) : null}
	                    </>
	                  ) : (
	                    <>
	                      {paymentMethod === 'zelle' ? (
	                        <p className="mt-2 text-[13px] text-slate-700">
	                          Send Zelle to <span className="font-mono">support@peppro.net</span> with memo:{' '}
	                          <span className="font-mono">({placedOrderNumber ? `Order #${placedOrderNumber}` : '#order number'})</span>. We will resend Zelle
	                          instructions to{' '}
	                          {typeof customerEmail === 'string' && customerEmail.trim().length > 0 ? (
	                            <>
	                              your <span>{customerEmail.trim()}</span> email
	                            </>
	                          ) : (
	                            'your email address'
	                          )}{' '}
	                          after you place your order.
	                        </p>
	                      ) : null}
	                      {paymentMethod !== 'zelle' ? (
	                        <p className="mt-2">
	                          After you place your order, we’ll email bank transfer instructions to <span>{customerEmail || 'your email address'}</span>.
	                        </p>
	                      ) : null}
	                      <p className="mt-2 text-[13px] text-slate-600">
	                        <span className="font-semibold">Important:</span>{' '}
	                        {paymentMethod === 'zelle'
	                          ? 'Ensure your bank supports Zelle and that your Zelle account is set up and ready.'
	                          : 'Include your order number in the payment memo/notes (we’ll show it here after you place the order).'}{' '}
                          Expect an email to arrive in your inbox within a minute. If you don’t see it, please check your spam/junk folder. If you still can’t find it, contact us at <span className="font-mono">support@peppro.net.</span>
                        </p>
	                    </>
	                  )}
	                </div>
	                {!isDelegateFlow && (
	                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
	                    <Button
	                      type="button"
	                      variant="secondary"
	                      onClick={() => setPaymentMethod('zelle')}
	                      aria-pressed={paymentMethod === 'zelle'}
	                      className={`squircle-sm checkout-payment-method-button justify-center gap-2 font-semibold ${
	                        paymentMethod === 'zelle'
	                          ? 'checkout-payment-method-button--active'
	                          : 'checkout-payment-method-button--inactive'
	                      }`}
	                    >
	                      Zelle
	                    </Button>
	                    <Button
	                      type="button"
	                      variant="secondary"
	                      onClick={() => setPaymentMethod('bank_transfer')}
	                      aria-pressed={paymentMethod === 'bank_transfer'}
	                      className={`squircle-sm checkout-payment-method-button justify-center gap-2 font-semibold ${
	                        paymentMethod === 'bank_transfer'
	                          ? 'checkout-payment-method-button--active'
	                          : 'checkout-payment-method-button--inactive'
	                      }`}
	                    >
	                      Direct Bank Transfer
	                    </Button>
	                  </div>
	                )}
	                {checkoutStatus === 'success' && placedOrderNumber && (
	                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
	                    <p className="font-semibold">Your order number: {placedOrderNumber}</p>
	                    <p className="mt-1">
	                      Use this as your payment memo/notes:{" "}
	                      <span className="font-mono">Order #{placedOrderNumber}</span>
	                    </p>
	                  </div>
	                )}
	              </div>

                {!isDelegateFlow && isAuthenticated && !allowUnauthenticatedCheckout && (
                  <div className="pt-1">
                    <div className="space-y-1">
                      <Label
                        htmlFor="checkout-discount-code"
                        className="text-xs font-semibold text-slate-700"
                      >
                        Discount code
                      </Label>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          id="checkout-discount-code"
                          value={discountCodeDraft}
                          onChange={(event) => setDiscountCodeDraft(event.target.value)}
                          placeholder="Enter code"
                          className="h-10 w-full sm:flex-1 squircle-sm glass focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.25)]"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleApplyDiscountCode}
                          disabled={discountCodeBusy}
                          className="header-home-button h-10 squircle-sm bg-white text-slate-900 gap-2"
                        >
                          {discountCodeBusy ? 'Applying…' : 'Apply'}
                        </Button>
                      </div>
                      {discountCodeMessage && (
                        <div className="text-xs text-red-600">{discountCodeMessage}</div>
                      )}
                      {discountCodeApplied && !discountCodeMessage && (
                        <div className="text-xs text-emerald-700">
                          {discountCodeApplied.pricingOverride?.mode === 'force_tier_band'
                            ? `Applied ${discountCodeApplied.code} (forcing ${discountCodeApplied.pricingOverride.minQuantity}-${discountCodeApplied.pricingOverride.maxQuantity} tier pricing)`
                            : `Applied ${discountCodeApplied.code} ($${discountCodeApplied.discountValue.toFixed(2)} off)`}
                        </div>
                      )}
                    </div>
                  </div>
                )}

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="physician-terms"
                  className="brand-checkbox"
                  checked={termsAccepted}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                />
	                <label htmlFor="physician-terms" className="text-sm text-slate-700 leading-snug flex-1">
	                  {isDelegateFlow ? (
	                    <>
	                      I understand I am compiling a proposal as a delegate of ({delegateDoctorDisplayName || 'Physician'}), and I agree to PepPro&apos;s{' '}
	                    </>
	                  ) : typeof agreementTextPrefix === 'string' && agreementTextPrefix.trim().length > 0 ? (
	                    <>
	                      {agreementTextPrefix.trim()}, and I agree to PepPro&apos;s{' '}
	                    </>
	                  ) : (
	                    <>
	                      I certify that I am {physicianName || 'the licensed physician for this account'}, and I agree to PepPro&apos;s{' '}
	                    </>
	                  )}
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

              {/* Order Total */}
	              <div className="space-y-2">
	                <Separator />
			                <div className="flex justify-between">
			                  <span>Subtotal:</span>
			                  <span className={retailPricingEnabled ? 'text-green-700 font-semibold tabular-nums' : 'tabular-nums'}>
	                        ${subtotal.toFixed(2)}
	                      </span>
			                </div>
			                {showDualPricing && delegateSubtotal != null && (
		                  <div className="flex justify-between text-sm text-slate-700">
		                    <span>Delegate subtotal:</span>
		                    <span className="tabular-nums text-[rgb(95,179,249)] font-semibold">
		                      ${delegateSubtotal.toFixed(2)}
		                    </span>
		                  </div>
		                )}
                    {!testOverrideApplied && discountCodeApplied && discountCodeAmount > 0 && (
                      <div className="flex justify-between text-sm font-semibold text-[rgb(95,179,249)]">
                        <span>Discount ({discountCodeApplied.code})</span>
                        <span>- ${discountCodeAmount.toFixed(2)}</span>
                      </div>
                    )}
                    {!testOverrideApplied &&
                      discountCodeApplied &&
                      discountCodeAmount <= 0 &&
                      discountCodeApplied.pricingOverride?.mode === 'force_tier_band' && (
                        <div className="flex justify-between text-sm font-semibold text-[rgb(95,179,249)]">
                          <span>Tier pricing ({discountCodeApplied.code})</span>
                          <span>
                            {discountCodeApplied.pricingOverride.minQuantity}-
                            {discountCodeApplied.pricingOverride.maxQuantity}
                          </span>
                        </div>
                      )}
	                {displayAppliedCredits > 0 && (
		                  <div className="flex justify-between text-sm font-semibold text-[rgb(95,179,249)]">
		                    <span>Referral Credit</span>
		                    <span>
		                      - ${displayAppliedCredits.toFixed(2)}
		                    </span>
	                  </div>
	                )}
	                <div className="flex justify-between text-sm text-slate-700">
	                  <span>Shipping:</span>
	                  <span>
                      {isDelegateFlow
                        ? 'Coordinated with physician'
                        : isFacilityPickupEnabled
                          ? 'Facility pickup ($0.00)'
                          : isHandDeliveryEnabled
                          ? 'FREE ($0.00)'
                          : `$${displayShippingCost.toFixed(2)}`}
                    </span>
	                </div>
                  {!isDelegateFlow && (
                    <>
	                  <div className="flex justify-between text-sm text-slate-700">
	                    <span>Estimated tax:</span>
	                    <span>{taxEstimatePending ? 'Calculating…' : `$${displayTaxAmount.toFixed(2)}`}</span>
	                  </div>
                    {taxEstimateError && (
                      <div className="flex items-start justify-between text-xs text-red-600">
                        <span className="pr-2">{taxEstimateError}</span>
                        <button
                          type="button"
                          onClick={handleRetryTaxEstimate}
                          className="underline decoration-dotted hover:text-red-700"
                        >
                          Retry
                        </button>
                      </div>
	                  )}
                    </>
                  )}
	                <Separator />
			                <div className="flex justify-between font-bold items-baseline gap-2">
			                  <span className="flex items-baseline gap-2">
			                    <span>Total:</span>
                        {retailPricingEnabled ? (
                          <span className="text-xs font-semibold text-green-700">(Retail)</span>
                        ) : null}
		                    {testOverrideApplied && (
		                      <span className="text-xs font-semibold text-amber-700">
		                        Test override: $0.01
		                      </span>
		                    )}
		                  </span>
			                  <span className={`${retailPricingEnabled ? 'text-green-700' : ''} tabular-nums`}>
	                        ${displayTotal.toFixed(2)}
	                      </span>
			                </div>
		                {showDualPricing && delegateTotal != null && (
		                  <div className="flex justify-between text-sm font-semibold text-[rgb(95,179,249)]">
		                    <span>Delegate pays you:</span>
		                    <span className="tabular-nums">
		                      ${delegateTotal.toFixed(2)}
		                    </span>
		                  </div>
		                )}
	                {testOverrideApplied && originalGrandTotal != null && (
	                  <div className="flex justify-between text-xs text-slate-500">
	                    <span>Original total:</span>
	                    <span className="tabular-nums line-through">
	                      ${originalGrandTotal.toFixed(2)}
	                    </span>
	                  </div>
	                )}
	              </div>

              {/* Checkout Button */}
              {canRejectProposalInCheckout && rejectNotesOpen && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-3">
                  <div className="space-y-2">
                    <Label htmlFor="proposal-reject-notes" className="text-sm font-semibold text-rose-900">
                      Rejection or suggestion notes for the delegate
                    </Label>
                    <Textarea
                      id="proposal-reject-notes"
                      value={rejectNotesDraft}
                      onChange={(event) => setRejectNotesDraft(event.target.value)}
                      placeholder="Explain what needs to change before this proposal can be approved…"
                      rows={4}
                      maxLength={4000}
                      className="border-rose-200 bg-white text-slate-900 placeholder:text-slate-400"
                    />
                    <p className="text-xs text-rose-800/80">
                      These notes are shown to the delegate in their proposal status panel.
                    </p>
                  </div>
                </div>
              )}
              <div className="pt-4 flex items-center gap-2">
                {canRejectProposalInCheckout && (
                  <>
                    {rejectNotesOpen && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (isRejectingProposal) return;
                          setRejectNotesOpen(false);
                          setRejectNotesDraft('');
                        }}
                        disabled={isRejectingProposal}
                        className="squircle-sm border-slate-300 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-800"
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={handleRejectProposalFromCheckout}
                      disabled={isProcessing || checkoutStatus === 'success' || isRejectingProposal}
                      className="w-[45%] min-w-[45%] squircle-sm border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-800"
                    >
                      {isRejectingProposal ? 'Rejecting…' : 'Reject or suggest'}
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  onClick={handlePrimaryAction}
                  disabled={!meetsCheckoutRequirements || isProcessing || checkoutStatus === 'success'}
                  className={isDelegateFlow
                    ? 'flex-1 squircle-sm gap-2 border-0 text-white transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0'
                    : 'flex-1 glass-brand squircle-sm gap-2 transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0'}
                  style={isDelegateFlow ? { backgroundColor: 'rgb(95, 179, 249)', borderColor: 'rgb(95, 179, 249)', color: '#ffffff', WebkitTextFillColor: '#ffffff' } : undefined}
                >
                  {isDelegateFlow ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-4 h-4 shrink-0"
                      aria-hidden="true"
                    >
                      <path d="M16.8812 4.34543C14.81 5.17401 12.5917 5.7132 10.276 5.91302C9.60847 5.97061 8.93276 6.00002 8.25 6.00002H7.5C4.60051 6.00002 2.25 8.35052 2.25 11.25C2.25 13.8496 4.13945 16.0079 6.61997 16.4266C6.95424 17.7956 7.41805 19.1138 7.99764 20.3674C8.46171 21.3712 9.67181 21.6875 10.5803 21.163L11.2366 20.784C12.1167 20.2759 12.4023 19.1913 12.0087 18.3159C11.7738 17.7935 11.5642 17.2574 11.3814 16.709C13.2988 16.9671 15.1419 17.4588 16.8812 18.1546C17.6069 15.9852 18 13.6635 18 11.25C18 8.83648 17.6069 6.51478 16.8812 4.34543Z" />
                      <path d="M18.2606 3.74072C19.0641 6.09642 19.5 8.6223 19.5 11.25C19.5 13.8777 19.0641 16.4036 18.2606 18.7593C18.2054 18.9211 18.1487 19.0821 18.0901 19.2422C17.9477 19.6312 18.1476 20.0619 18.5366 20.2043C18.9256 20.3467 19.3563 20.1468 19.4987 19.7578C19.6387 19.3753 19.7696 18.9884 19.891 18.5973C20.4147 16.9106 20.7627 15.1469 20.914 13.3278C21.431 12.7893 21.75 12.0567 21.75 11.25C21.75 10.4434 21.431 9.71073 20.914 9.17228C20.7627 7.35319 20.4147 5.58948 19.891 3.90274C19.7696 3.51165 19.6387 3.12472 19.4987 2.74221C19.3563 2.35324 18.9256 2.15334 18.5366 2.29572C18.1476 2.43811 17.9477 2.86885 18.0901 3.25783C18.1487 3.41795 18.2055 3.57898 18.2606 3.74072Z" />
                    </svg>
                  ) : (
                    <ShoppingCart className="w-4 h-4 shrink-0" aria-hidden="true" />
                  )}
                  {checkoutButtonLabel}
                </Button>
              </div>
            </>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
