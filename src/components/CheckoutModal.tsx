import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react';
import { CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogClose } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Card, CardContent } from './ui/card';
import { Minus, Plus, CreditCard, Trash2, LogIn, ShoppingCart, X, Landmark } from 'lucide-react';
import type { Product, ProductVariant } from '../types/product';
import { toast } from 'sonner@2.0.3';
import { ordersAPI, paymentsAPI, shippingAPI } from '../services/api';
import { ProductImageCarousel } from './ProductImageCarousel';
import type { CSSProperties } from 'react';
import { sanitizeServiceNames } from '../lib/publicText';
import { computeUnitPrice } from '../lib/pricing';

interface CheckoutResult {
  success?: boolean;
  message?: string | null;
  integrations?: {
    wooCommerce?: {
      response?: {
        payment_url?: string | null;
        paymentUrl?: string | null;
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

type ShippingAddress = {
  name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
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

const normalizeAddressField = (value?: string | null) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const isAddressComplete = (address: ShippingAddress) =>
  Boolean(
    normalizeAddressField(address.addressLine1)
    && normalizeAddressField(address.city)
    && normalizeAddressField(address.state)
    && normalizeAddressField(address.postalCode)
    && normalizeAddressField(address.country)
  );

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
  onCheckout: (payload: {
    shippingAddress: ShippingAddress;
    shippingRate: ShippingRate | null;
    shippingTotal: number;
    expectedShipmentWindow?: string | null;
    physicianCertificationAccepted: boolean;
    taxTotal?: number | null;
    paymentMethod?: 'stripe' | 'bacs' | string | null;
  }) => Promise<CheckoutResult | void> | CheckoutResult | void;
  onClearCart?: () => void;
  onPaymentSuccess?: () => void;
  onUpdateItemQuantity: (cartItemId: string, quantity: number) => void;
  onRemoveItem: (cartItemId: string) => void;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
  physicianName?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  defaultShippingAddress?: ShippingAddress | null;
  availableCredits?: number;
  stripeAvailable?: boolean;
  stripeOnsiteEnabled?: boolean;
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
  onCheckout,
  onUpdateItemQuantity,
  onRemoveItem,
  isAuthenticated,
  onRequireLogin,
  physicianName,
  customerEmail,
  customerName,
  onClearCart,
  onPaymentSuccess,
  defaultShippingAddress,
  availableCredits = 0,
  stripeAvailable,
  stripeOnsiteEnabled: stripeOnsiteEnabledFromServer,
}: CheckoutModalProps) {
  const wooRedirectEnabled = import.meta.env.VITE_WOO_REDIRECT_ENABLED !== 'false';
  const stripeOnsiteEnabled = typeof stripeOnsiteEnabledFromServer === 'boolean'
    ? stripeOnsiteEnabledFromServer
    : import.meta.env.VITE_STRIPE_ONSITE_ENABLED === 'true';
  const stripeReady = stripeOnsiteEnabled && Boolean(stripeAvailable);
  const stripe = useStripe();
  const elements = useElements();
  const cardElementOptions = useMemo(
    () => ({
      style: {
        base: {
          fontSize: '16px',
          color: '#1f2933',
          '::placeholder': { color: '#9ca3af' },
        },
        invalid: { color: '#ef4444' },
      },
    }),
    [],
  );
  const defaultCardholderName = (defaultShippingAddress?.name || physicianName || customerName || '').trim();
  // Referral codes are no longer collected at checkout.
  const [quantityInputs, setQuantityInputs] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [bulkOpenMap, setBulkOpenMap] = useState<Record<string, boolean>>({});
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'bacs'>('stripe');
  const [cardholderName, setCardholderName] = useState(defaultCardholderName);
  const cardholderAutofillRef = useRef(defaultCardholderName);
  const [checkoutStatus, setCheckoutStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [checkoutStatusMessage, setCheckoutStatusMessage] = useState<string | null>(null);
  const checkoutStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQuotedAddressRef = useRef<string | null>(null);
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
  const [taxEstimate, setTaxEstimate] = useState<{ amount: number; currency: string; grandTotal: number; source?: string | null } | null>(null);
  const [taxEstimateError, setTaxEstimateError] = useState<string | null>(null);
  const [taxEstimatePending, setTaxEstimatePending] = useState(false);
  const lastTaxQuoteRef = useRef<{ key: string; ts: number } | null>(null);
  const activeTaxRequestRef = useRef<AbortController | null>(null);

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

  const getVisibleBulkTiers = (product: Product, quantity: number) => {
    const tiers = product.bulkPricingTiers ?? [];
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

  const checkoutLineItems = useMemo(
    () =>
      cartItems.map(({ id, product, quantity, note, variant }, index) => {
        const unitPrice = computeUnitPrice(product, variant, quantity);
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
    [cartItems],
  );
  const cartLineItemSignature = useMemo(
    () =>
      checkoutLineItems
        .map((item) => `${item.productId}:${item.variantId || 'base'}:${item.quantity}:${item.price}`)
        .join('|'),
    [checkoutLineItems],
  );
  const subtotal = useMemo(
    () => checkoutLineItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [checkoutLineItems],
  );
  const selectedShippingRate = selectedRateIndex != null && shippingRates
    ? shippingRates[selectedRateIndex]
    : null;
  const shippingCost = selectedShippingRate?.rate
    ? Number(selectedShippingRate.rate) || 0
    : 0;
  const taxAmount = Math.max(0, typeof taxEstimate?.amount === 'number' ? taxEstimate.amount : 0);
  const normalizedCredits = Math.max(0, Number(availableCredits || 0));
  const appliedCredits = Math.min(subtotal, normalizedCredits);
  const total = Math.max(0, subtotal - appliedCredits + shippingCost + taxAmount);
  const shippingAddressSignature = [
    shippingAddress.addressLine1,
    shippingAddress.addressLine2,
    shippingAddress.city,
    shippingAddress.state,
    shippingAddress.postalCode,
    shippingAddress.country,
  ]
    .map((value) => normalizeAddressField(value).toUpperCase())
    .join('|');
  const shippingAddressComplete = isAddressComplete(shippingAddress);
  const isPaymentValid = paymentMethod === 'bacs'
    ? true
    : (stripeReady ? cardholderName.trim().length >= 2 : true);
  const hasSelectedShippingRate = Boolean(shippingRates && shippingRates.length > 0 && selectedRateIndex != null);
  const shouldFetchTax = Boolean(
    isOpen
    && isAuthenticated
    && hasSelectedShippingRate
    && shippingAddressComplete
    && checkoutLineItems.length > 0,
  );
  const taxReady = !shouldFetchTax || (!!taxEstimate && !taxEstimatePending);
  const meetsCheckoutRequirements = termsAccepted && isPaymentValid && hasSelectedShippingRate && taxReady;
  const taxQuoteKey = useMemo(() => {
    if (!shouldFetchTax) {
      return null;
    }
    const rateFingerprint = selectedShippingRate?.addressFingerprint
      || `${selectedShippingRate?.carrierId || 'carrier'}:${selectedShippingRate?.serviceCode || selectedShippingRate?.serviceType || 'service'}`;
    return [
      cartLineItemSignature || 'items',
      shippingAddressSignature || 'address',
      rateFingerprint,
      shippingCost.toFixed(2),
    ].join('|');
  }, [shouldFetchTax, cartLineItemSignature, shippingAddressSignature, selectedShippingRate, shippingCost]);
  const canCheckout = meetsCheckoutRequirements && isAuthenticated;
  let checkoutButtonLabel = `Complete Purchase (${total.toFixed(2)})`;
  if (checkoutStatus === 'success' && checkoutStatusMessage) {
    checkoutButtonLabel = checkoutStatusMessage;
  } else if (checkoutStatus === 'error' && checkoutStatusMessage) {
    checkoutButtonLabel = checkoutStatusMessage;
  } else if (taxEstimatePending && shouldFetchTax) {
    checkoutButtonLabel = 'Calculating taxes…';
  } else if (isProcessing) {
    checkoutButtonLabel = 'Processing order...';
  }

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

    const backorderDays = requiresBackorder ? 3 : 0;
    const processingMinDays = isAfterCutoff ? 2 : 1;
    const processingMaxDays = isAfterCutoff ? 3 : 2;
    const shipMinDays = backorderDays + processingMinDays;
    const shipMaxDays = backorderDays + processingMaxDays;

    const shipMinDate = addBusinessDays(now, shipMinDays);
    const shipMaxDate = addBusinessDays(now, shipMaxDays);

    const shipWindowLabel =
      shipMinDate.toDateString() === shipMaxDate.toDateString()
        ? shipMinDate.toLocaleDateString()
        : `${shipMinDate.toLocaleDateString()}–${shipMaxDate.toLocaleDateString()}`;

    const mathParts: string[] = [];
    if (backorderDays) {
      mathParts.push('3 business day backorder');
    }
    mathParts.push(`${processingMinDays}–${processingMaxDays} business day processing`);
    const mathText = `${mathParts.join(' + ')}${isAfterCutoff ? ' (order placed after 1pm PT)' : ''}`;

    return {
      shipWindowLabel,
      mathText,
      disclaimer: 'Carrier transit begins after shipment and is not guaranteed.',
    };
  }, [requiresBackorder, selectedShippingRate]);

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
      const payload = {
        shippingAddress,
        items: cartItems.map((item) => {
          const dimensions = item.variant?.dimensions || item.product.dimensions || {};
          return {
            name: item.product.name,
            quantity: item.quantity,
            weightOz: item.variant?.weightOz ?? item.product.weightOz ?? null,
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
    console.debug('[CheckoutModal] Checkout start', {
      total,
      items: cartItems.map((item) => ({
        id: item.id,
        productId: item.product.id,
        variantId: item.variant?.id,
        qty: item.quantity
      }))
    });
    setIsProcessing(true);
    let createdOrderId: string | null = null;
    try {
      const result = await onCheckout({
        shippingAddress,
        shippingRate: selectedShippingRate,
        shippingTotal: shippingCost,
        expectedShipmentWindow: deliveryEstimate?.shipWindowLabel ?? null,
        physicianCertificationAccepted: termsAccepted,
        taxTotal: taxAmount,
        paymentMethod,
      });
      createdOrderId = result?.order?.id ?? null;
      const stripeInfo = result && typeof result === 'object'
        ? result?.integrations?.stripe
        : null;
      const clientSecret = stripeInfo?.clientSecret || null;
      const stripeIntentId = stripeInfo?.paymentIntentId || null;
      const successMessage = result && typeof result === 'object' && 'message' in result && result.message
        ? String(result.message)
        : 'Order received! We\'ll email you updates.';
      const paymentUrl =
        result?.integrations?.wooCommerce?.response?.payment_url
        || result?.integrations?.wooCommerce?.response?.paymentUrl
        || null;
      const shouldUseStripe = paymentMethod === 'stripe' && stripeReady && Boolean(clientSecret);
      const shouldRedirectToWoo = paymentMethod === 'stripe' && Boolean(paymentUrl) && wooRedirectEnabled && !shouldUseStripe;

      console.debug('[CheckoutModal] Checkout integrations', {
        stripeReady,
        stripeOnsiteEnabled,
        stripeIntentId,
        hasClientSecret: Boolean(clientSecret),
        stripeStatus: stripeInfo?.status || null,
        stripeReason: stripeInfo?.reason || null,
        stripeMessage: stripeInfo?.message || null,
        paymentUrl,
      });

      if (shouldUseStripe) {
        if (!stripe || !elements) {
          throw new Error('Payment form is not ready. Please refresh and try again.');
        }
        const cardElement = elements.getElement(CardElement);
        if (!cardElement) {
          throw new Error('Enter your card details to continue.');
        }
        const confirmation = await stripe.confirmCardPayment(clientSecret, {
          payment_method: {
            card: cardElement,
            billing_details: {
              name: cardholderName || customerName || 'PepPro Customer',
              email: customerEmail || undefined,
              address: {
                postal_code: shippingAddress?.postalCode || undefined,
              },
            },
          },
        });
        if (confirmation.error) {
          throw new Error(confirmation.error.message || 'Payment could not be completed.');
        }
        const intentStatus = confirmation.paymentIntent?.status;
        if (intentStatus !== 'succeeded') {
          throw new Error('Payment did not complete. Please try again.');
        }
        console.debug('[CheckoutModal] Stripe payment confirmed', { stripeIntentId, intentStatus });
        if (stripeIntentId) {
          void paymentsAPI.confirmStripeIntent(stripeIntentId).catch((confirmError) => {
            console.warn('[CheckoutModal] Failed to confirm Stripe intent server-side', confirmError);
            toast.info(
              'Payment received, but order sync is still pending. If you do not receive an email shortly, contact support.',
            );
          });
        }
      } else if (paymentMethod === 'stripe' && stripeReady && !clientSecret) {
        console.warn('[CheckoutModal] Stripe onsite enabled but no clientSecret returned', stripeInfo);
        if (paymentUrl && wooRedirectEnabled) {
          toast.info('Redirecting to complete payment…');
          window.location.assign(paymentUrl);
          return;
        }
        const reasonTextRaw =
          stripeInfo?.message || stripeInfo?.reason || 'Payment is unavailable right now.';
        throw new Error(sanitizeServiceNames(String(reasonTextRaw)));
      } else if (paymentMethod === 'stripe' && !stripeReady && paymentUrl && wooRedirectEnabled) {
        toast.info('Redirecting to complete payment…');
        window.location.assign(paymentUrl);
        return;
      }

      setCheckoutStatus('success');
      setCheckoutStatusMessage(successMessage);
      toast.success(successMessage);
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
        if (shouldRedirectToWoo && paymentUrl) {
          window.location.assign(paymentUrl);
        }
      }, shouldRedirectToWoo ? 600 : 1800);
      if (shouldRedirectToWoo) {
        toast.info('Redirecting to complete payment…');
      }
    } catch (error: any) {
      if (createdOrderId) {
        try {
          await ordersAPI.cancelOrder(createdOrderId, error?.message ?? 'Payment confirmation failed');
        } catch (cancelError) {
          console.warn('[CheckoutModal] Failed to cancel order after payment failure', cancelError);
        }
      }
      console.warn('[CheckoutModal] Checkout handler threw', error);
      const message = typeof error?.message === 'string' && error.message.trim().length > 0
        ? error.message
        : 'Unable to complete purchase. Please try again.';
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
      toast.error('Enter valid payment details and accept the terms to continue.');
      return;
    }
    if (!hasSelectedShippingRate) {
      toast.error('Select a shipping option before completing your purchase.');
      return;
    }
    if (shouldFetchTax && (!taxEstimate || taxEstimatePending)) {
      toast.error('We are calculating taxes for this order. Please try again in a moment.');
      return;
    }
    if (!isAuthenticated) {
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
      setPaymentMethod('stripe');
      setCardholderName(defaultCardholderName);
      cardholderAutofillRef.current = defaultCardholderName;
      setCheckoutStatus('idle');
      setCheckoutStatusMessage(null);
      setShippingRates(null);
      setSelectedRateIndex(null);
      setShippingRateError(null);
      setTaxEstimate(null);
      setTaxEstimateError(null);
      setTaxEstimatePending(false);
      lastTaxQuoteRef.current = null;
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
  }, [defaultShippingAddress, customerName, defaultCardholderName, isOpen, physicianName]);

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
    setCardholderName((prev) => {
      const trimmedPrev = prev.trim();
      if (!trimmedPrev || trimmedPrev === cardholderAutofillRef.current) {
        cardholderAutofillRef.current = defaultCardholderName;
        return defaultCardholderName;
      }
      return prev;
    });
  }, [defaultCardholderName]);

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

  const requestTaxEstimate = useCallback(async (options?: { force?: boolean }) => {
    if (!shouldFetchTax || !taxQuoteKey) {
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
      const response = await ordersAPI.estimateTotals(
        {
          items: checkoutLineItems.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            price: item.price,
            quantity: item.quantity,
          })),
          shippingAddress,
          shippingEstimate: selectedShippingRate,
          shippingTotal: shippingCost,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      const totals = response?.totals || null;
      const amount = Math.max(0, Number(totals?.taxTotal) || 0);
      const grandTotalFromApi = Number(totals?.grandTotal);
      const fallbackGrandTotal = Math.max(0, subtotal - appliedCredits + shippingCost + amount);
      setTaxEstimate({
        amount,
        currency: typeof totals?.currency === 'string' && totals.currency ? totals.currency : 'USD',
        grandTotal: Number.isFinite(grandTotalFromApi) ? Math.max(0, grandTotalFromApi) : fallbackGrandTotal,
        source: totals?.source || null,
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
  }, [appliedCredits, checkoutLineItems, selectedShippingRate, shippingAddress, shippingCost, shouldFetchTax, subtotal, taxQuoteKey]);

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
        className="checkout-modal glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
        style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}
        containerStyle={legalModalOpen ? { pointerEvents: 'none' } : undefined}
        overlayStyle={legalModalOpen ? { pointerEvents: 'none' } : undefined}
        data-legal-overlay={legalModalOpen ? 'true' : 'false'}
        trapFocus={!legalModalOpen}
        disableOutsidePointerEvents={false}
      >
        <DialogHeader className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
                Checkout
              </DialogTitle>
              <DialogDescription>Review your order and complete your purchase</DialogDescription>
            </div>
            <DialogClose
              className="dialog-close-btn inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full p-0 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              style={{
                backgroundColor: 'rgb(95, 179, 249)',
                borderRadius: '50%',
              }}
              aria-label="Close checkout"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6" ref={checkoutScrollRef}>
          <div className="space-y-6 pt-6">
            <>
              {/* Cart Items */}
              <div className="space-y-4">
                <h3>Order Summary</h3>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 auto-rows-fr">
                {cartItems.map((item, index) => {
                  const baseImages = item.product.images.length > 0 ? item.product.images : [item.product.image];
                  const carouselImages = item.variant?.image
                    ? [item.variant.image, ...baseImages].filter((src, index, self) => src && self.indexOf(src) === index)
                    : baseImages;
                  const unitPrice = computeUnitPrice(item.product, item.variant, item.quantity);
                  const lineTotal = unitPrice * item.quantity;
                  const allTiers = (item.product.bulkPricingTiers ?? []).sort((a, b) => a.minQuantity - b.minQuantity);
                  const visibleTiers = getVisibleBulkTiers(item.product, item.quantity);
                  const upcomingTier = allTiers.find((tier) => item.quantity < tier.minQuantity) || null;
                  const isBulkOpen = bulkOpenMap[item.id] ?? false;
                  return (
                    <Card
                      key={item.id}
                      className="glass squircle-sm h-full w-full"
                    >
                      <CardContent className="p-4 relative">
                        <div className="absolute right-4 top-4 flex flex-col items-end gap-3 w-[92px] sm:w-[150px] text-right">
                          <p className="font-bold tabular-nums tracking-tight">${lineTotal.toFixed(2)}</p>
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
                        <div className="flex items-start gap-4 pr-[120px] sm:pr-[180px]">
                          <div className="flex items-center gap-4 flex-grow">
                            <div
                              className="flex-shrink-0 self-stretch"
                              style={{ flexBasis: '25%', maxWidth: '25%' }}
                            >
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
                            <div>
                              <h4 className="line-clamp-1">#{index + 1} — {item.product.name}</h4>
                              <p className="text-sm text-gray-600">{item.product.dosage}</p>
                              {item.variant && (
                                <p className="text-xs text-gray-500">Variant: {item.variant.label}</p>
                              )}
                              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                                <span className="text-green-600 font-bold">
                                  ${unitPrice.toFixed(2)}
                                </span>
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
                              {visibleTiers.length > 0 && (
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
                                      <div className="space-y-1.5 pt-1">
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
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                </div>
              </div>

              {/* Shipping */}
              <div className="space-y-4">
                <h3>Shipping Address</h3>
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
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleGetRates}
                    disabled={isFetchingRates || cartItems.length === 0 || !shippingAddressComplete}
                    className="squircle-sm"
                  >
                    {isFetchingRates ? 'Fetching rates...' : 'Get shipping rates'}
                  </Button>
                  {shippingRateError && <p className="text-sm text-red-600">{shippingRateError}</p>}
                </div>
                {shippingRates && shippingRates.length > 0 && (
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
                              Estimated Shipping window: {deliveryEstimate.shipWindowLabel}
                            </p>
                            <p className="text-xs text-slate-600">
                              {deliveryEstimate.mathText}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {deliveryEstimate.disclaimer}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Payment Form */}
              <div className="space-y-5">
                <h3>Payment Information</h3>
                {stripeReady ? (
                  <div className="grid grid-cols-1 gap-4">
                    {paymentMethod === 'stripe' ? (
                      <>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="cardName">Cardholder Name</Label>
                          <Input
                            id="cardName"
                            name="cc-name"
                            autoComplete="cc-name"
                            placeholder="John Doe"
                            className="squircle-sm mt-1 bg-slate-50 border-2"
                            value={cardholderName}
                            onChange={(event) => setCardholderName(event.target.value)}
                          />
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label>Card Details</Label>
                          <div className="squircle-sm mt-1 border-2 bg-white px-3 py-2">
                            <CardElement options={cardElementOptions} />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-xl border border-slate-200 bg-white/70 px-6 py-5 text-sm text-slate-700 leading-relaxed">
                        You selected Direct Bank Transfer. After placing your order, you’ll receive payment instructions by email.
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant={paymentMethod === 'bacs' ? 'default' : 'secondary'}
                        onClick={() => setPaymentMethod('bacs')}
                        className="squircle-sm justify-center gap-2"
                      >
                        <Landmark className="h-4 w-4" />
                        Direct Bank Transfer
                      </Button>
                      {paymentMethod === 'bacs' && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setPaymentMethod('stripe')}
                          className="justify-center gap-2 text-slate-600"
                        >
                          <CreditCard className="h-4 w-4" />
                          Use Credit Card Instead
                        </Button>
                      )}
                    </div>
                  </div>
	                ) : (
	                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
		                    On-site checkout is currently unavailable. After you place your order, you'll be redirected to complete payment.
	                  </div>
	                )}
	              </div>

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="physician-terms"
                  className="brand-checkbox"
                  checked={termsAccepted}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                />
	                <label htmlFor="physician-terms" className="text-sm text-slate-700 leading-snug flex-1">
	                  I certify that I am {physicianName || 'the licensed physician for this account'}, and I agree to PepPro's{' '}
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
                  <span>${subtotal.toFixed(2)}</span>
                </div>
                {appliedCredits > 0 && (
                  <div className="flex justify-between text-sm font-semibold text-[rgb(95,179,249)]">
                    <span>Referral Credit</span>
                    <span>
                      - ${appliedCredits.toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-sm text-slate-700">
                  <span>Shipping:</span>
                  <span>${shippingCost.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm text-slate-700">
                  <span>Estimated tax:</span>
                  <span>{taxEstimatePending ? 'Calculating…' : `$${taxAmount.toFixed(2)}`}</span>
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
                <Separator />
                <div className="flex justify-between font-bold">
                  <span>Total:</span>
                  <span>${total.toFixed(2)}</span>
                </div>
              </div>

              {/* Checkout Button */}
              <div className="pt-4">
                <Button
                  variant="ghost"
                  onClick={handlePrimaryAction}
                  disabled={!meetsCheckoutRequirements || isProcessing || checkoutStatus === 'success'}
                  className="w-full glass-brand squircle-sm transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                >
                  {canCheckout ? (
                    <CreditCard className="w-4 h-4 mr-2" />
                  ) : (
                    <LogIn className="w-4 h-4 mr-2" />
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
