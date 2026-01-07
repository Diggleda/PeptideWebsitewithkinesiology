import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
import { Input } from './ui/input';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogClose } from './ui/dialog';
import { ShoppingCart, Minus, Plus, Loader2, Download, X } from 'lucide-react';
import { wooAPI } from '../services/api';

const AUTO_OPEN_STRENGTH_ENABLED = (() => {
  const raw = String((import.meta as any).env?.VITE_AUTO_OPEN_STRENGTH ?? '').toLowerCase().trim();
  if (!raw) return true; // default ON (can be disabled with VITE_AUTO_OPEN_STRENGTH=false)
  return raw === 'true';
})();
const AUTO_OPEN_STRENGTH_DELAY_MS = (() => {
  const raw = String((import.meta as any).env?.VITE_AUTO_OPEN_STRENGTH_DELAY_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 750;
})();

const AUTO_OPEN_STRENGTH_PACE_MS = (() => {
  const raw = String((import.meta as any).env?.VITE_AUTO_OPEN_STRENGTH_PACE_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 500;
})();

// Off by default; enable only when explicitly set to true.
const AUTO_CYCLE_STRENGTH_ENABLED =
  String((import.meta as any).env?.VITE_AUTO_CYCLE_STRENGTH || '').toLowerCase().trim() === 'true';
const AUTO_CYCLE_STRENGTH_DELAY_MS = (() => {
  const raw = String((import.meta as any).env?.VITE_AUTO_CYCLE_STRENGTH_DELAY_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 175;
})();

const PLACEHOLDER_VARIATION_ID = '__peppro_needs_variant__';
const PLACEHOLDER_IMAGE_SRC = '/Peppro_IconLogo_Transparent_NoBuffer.png';

const AUTO_OPEN_IMAGE_TIMEOUT_MS = (() => {
  const raw = String((import.meta as any).env?.VITE_AUTO_OPEN_IMAGE_TIMEOUT_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 45000;
})();

const AUTO_OPEN_IMAGE_MAX_ATTEMPTS = (() => {
  const raw = String((import.meta as any).env?.VITE_AUTO_OPEN_IMAGE_MAX_ATTEMPTS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return 10;
})();

const prefetchImageOnce = (src: string, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    img.onload = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(true);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(false);
    };
    img.src = src;
  });

const buildImageRetryUrl = (src: string, attempt: number) => {
  const sep = src.includes('?') ? '&' : '?';
  return `${src}${sep}_imgRetry=${Date.now()}_${attempt}`;
};

const waitForImageWithRetry = async (src: string, timeoutMs: number): Promise<boolean> => {
  const trimmed = src.trim();
  if (!trimmed || trimmed === PLACEHOLDER_IMAGE_SRC || trimmed.startsWith('data:')) {
    return true;
  }

  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs && attempt < AUTO_OPEN_IMAGE_MAX_ATTEMPTS) {
    attempt += 1;
    // eslint-disable-next-line no-await-in-loop
    const ok = await prefetchImageOnce(attempt === 1 ? trimmed : buildImageRetryUrl(trimmed, attempt), 25000);
    if (ok) {
      return true;
    }
    const delayMs = Math.min(60000, 900 * Math.pow(1.7, attempt - 1));
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
  }
  return false;
};

const autoOpenQueue: Array<() => Promise<void>> = [];
let autoOpenActive = false;
const runAutoOpenQueue = () => {
  if (autoOpenActive) return;
  if (autoOpenQueue.length === 0) return;
  autoOpenActive = true;
  const next = autoOpenQueue.shift();
  if (!next) {
    autoOpenActive = false;
    return;
  }
  void next()
    .catch(() => {})
    .finally(() => {
      autoOpenActive = false;
      runAutoOpenQueue();
    });
};
const enqueueAutoOpen = (fn: () => Promise<void>) => {
  autoOpenQueue.push(fn);
  runAutoOpenQueue();
};

export interface ProductVariation {
  id: string;
  strength: string; // e.g., "10mg", "20mg", "50mg"
  basePrice: number;
  image?: string;
  stockQuantity?: number | null;
}

export interface BulkPricingTier {
  minQuantity: number;
  discountPercentage: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  image: string;
  images?: string[];
  inStock: boolean;
  stockQuantity?: number | null;
  manufacturer: string;
  variations: ProductVariation[];
  bulkPricingTiers: BulkPricingTier[];
}

interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: string, variationId: string, quantity: number) => void;
  onEnsureVariants?: (options?: { force?: boolean }) => Promise<unknown> | void;
}

const pickDefaultVariation = (variations: ProductVariation[] | undefined | null) => {
  if (!Array.isArray(variations) || variations.length === 0) {
    return { id: 'default', strength: 'Standard', basePrice: 0 } as ProductVariation;
  }
  return variations.find((variation) => Boolean(variation?.image)) ?? variations[0];
};

export function ProductCard({ product, onAddToCart, onEnsureVariants }: ProductCardProps) {
  const selectableVariations = useMemo(() => {
    const variations = Array.isArray(product.variations) ? product.variations : [];
    return variations.filter((variation) => variation?.id !== PLACEHOLDER_VARIATION_ID);
  }, [product.variations]);

  const needsVariants =
    Array.isArray(product.variations) &&
    product.variations.length === 1 &&
    product.variations[0]?.id === PLACEHOLDER_VARIATION_ID;

  const [selectedVariation, setSelectedVariation] = useState<ProductVariation>(
    pickDefaultVariation(selectableVariations.length > 0 ? selectableVariations : product.variations),
  );
  const [uiVariationId, setUiVariationId] = useState<string>('');
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState('1');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const variantsLoadTriggeredRef = useRef(false);
  const userInteractedRef = useRef(false);
  const autoCycleDoneRef = useRef<string | null>(null);
  const autoOpenDoneRef = useRef<string | null>(null);
  const [coaOpen, setCoaOpen] = useState(false);
  const [coaLoading, setCoaLoading] = useState(false);
  const [coaError, setCoaError] = useState<string | null>(null);
  const [coaObjectUrl, setCoaObjectUrl] = useState<string | null>(null);

  const wooProductId = useMemo(() => {
    const raw = String(product.id || '').trim();
    const match = raw.match(/^woo-(\d+)$/i);
    if (match && match[1]) {
      const parsed = Number.parseInt(match[1], 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits) {
      const parsed = Number.parseInt(digits, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }, [product.id]);

  useEffect(() => {
    return () => {
      if (coaObjectUrl) {
        URL.revokeObjectURL(coaObjectUrl);
      }
    };
  }, [coaObjectUrl]);

  useEffect(() => {
    const rawVariations = Array.isArray(product.variations) ? product.variations : [];
    if (rawVariations.length === 0) return;

    const nextSelectable = rawVariations.filter((variation) => variation?.id !== PLACEHOLDER_VARIATION_ID);
    const resolvedForSelection = nextSelectable.length > 0 ? nextSelectable : rawVariations;

    setSelectedVariation((prev) => {
      const next =
        resolvedForSelection.find((variation) => variation.id === prev.id) ??
        pickDefaultVariation(resolvedForSelection);
      return next?.id === prev.id ? prev : next;
    });

    // Keep "Select strength" until variants are actually loaded, then switch the UI to a real variant id
    // so the dropdown renders the option list consistently.
    setUiVariationId((prev) => {
      if (nextSelectable.length === 0) {
        return '';
      }
      const exists = prev ? nextSelectable.some((variation) => variation.id === prev) : false;
      if (exists) return prev;
      return pickDefaultVariation(nextSelectable).id;
    });
  }, [product.id, product.variations]);

  useEffect(() => {
    if (!AUTO_CYCLE_STRENGTH_ENABLED) {
      return;
    }
    if (variantsLoading) {
      return;
    }
    if (userInteractedRef.current) {
      return;
    }
    if (!Array.isArray(product.variations) || product.variations.length < 2) {
      return;
    }
    if (autoCycleDoneRef.current === product.id) {
      return;
    }

    // Only cycle once per product, and only through variants that have an image.
    const candidates = product.variations.filter((variation) => Boolean(variation?.image));
    if (candidates.length === 0) {
      return;
    }

    autoCycleDoneRef.current = product.id;
    let cancelled = false;

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const run = async () => {
      for (const variation of candidates) {
        if (cancelled || userInteractedRef.current) return;
        setSelectedVariation(variation);
        // eslint-disable-next-line no-await-in-loop
        await sleep(AUTO_CYCLE_STRENGTH_DELAY_MS);
      }
      if (cancelled || userInteractedRef.current) return;
      setSelectedVariation(pickDefaultVariation(product.variations));
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [product.id, product.variations, variantsLoading]);

  const bulkTiers = product.bulkPricingTiers ?? [];
  const quantityButtonClasses = 'h-8 w-8 squircle-sm';

  const calculatePrice = () => {
    if (bulkTiers.length === 0) {
      return selectedVariation.basePrice;
    }
    const applicableTier = [...bulkTiers]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find((tier) => quantity >= tier.minQuantity);
    if (applicableTier) {
      const discount = applicableTier.discountPercentage / 100;
      return selectedVariation.basePrice * (1 - discount);
    }
    return selectedVariation.basePrice;
  };

  const currentUnitPrice = calculatePrice();
  const totalPrice = currentUnitPrice * quantity;
  const nextTier = bulkTiers.find((tier) => tier.minQuantity > quantity) || null;

  const visibleBulkTiers = useMemo(() => {
    if (!bulkTiers.length) {
      return [];
    }
    const sorted = [...bulkTiers].sort((a, b) => a.minQuantity - b.minQuantity);
    const currentIdx = sorted.findIndex((tier) => quantity < tier.minQuantity);
    let start = currentIdx === -1 ? Math.max(0, sorted.length - 5) : Math.max(0, currentIdx - 2);
    let slice = sorted.slice(start, start + 5);
    if (slice.length < 5 && start > 0) {
      start = Math.max(0, start - (5 - slice.length));
      slice = sorted.slice(start, start + 5);
    }
    return slice;
  }, [bulkTiers, quantity]);

  const handleQuantityChange = (delta: number) => {
    const newQuantity = Math.max(1, quantity + delta);
    setQuantity(newQuantity);
    setQuantityInput(String(newQuantity));
    setBulkOpen(true);
  };

  const canLoadVariants =
    typeof onEnsureVariants === 'function' &&
    (needsVariants || product.variations.some((variation) => String(variation.id).startsWith('woo-variation-')));

  const triggerVariantLoad = async (options?: { force?: boolean }) => {
    if (!canLoadVariants) {
      return;
    }
    const isForce = options?.force === true;
    if (variantsLoading) {
      return;
    }
    if (!isForce && variantsLoadTriggeredRef.current) {
      return;
    }
    if (!isForce) {
      variantsLoadTriggeredRef.current = true;
    }
    try {
      setVariantsLoading(true);
      return await onEnsureVariants(options);
    } finally {
      setVariantsLoading(false);
    }
  };

  const handleVariationChange = (variationId: string) => {
    userInteractedRef.current = true;
    setUiVariationId(variationId);
    if (!variationId || variationId === PLACEHOLDER_VARIATION_ID) {
      void triggerVariantLoad({ force: true });
      return;
    }
    const variation = selectableVariations?.find((v) => v.id === variationId);
    if (variation) {
      setSelectedVariation(variation);
    }
  };

  useEffect(() => {
    if (!AUTO_OPEN_STRENGTH_ENABLED) {
      return;
    }
    if (!needsVariants || typeof onEnsureVariants !== 'function') {
      return;
    }
    if (variantsLoading || variantsLoadTriggeredRef.current) {
      return;
    }
    if (userInteractedRef.current) {
      return;
    }
    if (autoOpenDoneRef.current === product.id) {
      return;
    }
    autoOpenDoneRef.current = product.id;

    const shouldDelay = !autoOpenActive && autoOpenQueue.length === 0;
    enqueueAutoOpen(async () => {
      if (shouldDelay && AUTO_OPEN_STRENGTH_DELAY_MS > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, AUTO_OPEN_STRENGTH_DELAY_MS));
      }
      if (userInteractedRef.current) {
        return;
      }
      const nextProduct = await triggerVariantLoad();
      if (userInteractedRef.current) {
        return;
      }
      const candidateImage = (() => {
        const payload: any = nextProduct;
        const variants = Array.isArray(payload?.variants) ? payload.variants : [];
        const defaultVariantId =
          typeof payload?.defaultVariantId === 'string' && payload.defaultVariantId.trim().length > 0
            ? payload.defaultVariantId.trim()
            : null;
        const defaultVariant = defaultVariantId ? variants.find((v: any) => v?.id === defaultVariantId) : null;
        const variantWithImage =
          (defaultVariant &&
          typeof (defaultVariant as any)?.image === 'string' &&
          (defaultVariant as any).image.trim().length > 0
            ? defaultVariant
            : null) ??
          variants.find((v: any) => typeof v?.image === 'string' && v.image.trim().length > 0);
        const fallback = typeof payload?.image === 'string' ? payload.image : null;
        return (variantWithImage?.image as string | undefined) ?? fallback ?? null;
      })();
      if (typeof candidateImage === 'string' && candidateImage.trim().length > 0) {
        await waitForImageWithRetry(candidateImage.trim(), AUTO_OPEN_IMAGE_TIMEOUT_MS);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, AUTO_OPEN_STRENGTH_PACE_MS));
    });
  }, [needsVariants, onEnsureVariants, product.id, variantsLoading]);

  const openCertificateOfAnalysis = async () => {
    setCoaOpen(true);
    setCoaError(null);
    if (coaObjectUrl || coaLoading) {
      return;
    }
    if (!wooProductId) {
      setCoaError('Certificate unavailable for this product.');
      return;
    }

    setCoaLoading(true);
    try {
      const { blob } = await wooAPI.getCertificateOfAnalysis(wooProductId);
      const url = URL.createObjectURL(blob);
      setCoaObjectUrl(url);
    } catch (error: any) {
      const status = typeof error?.status === 'number' ? error.status : null;
      if (status === 404) {
        setCoaError('We are working to attach a certificate for this product.');
      } else {
        setCoaError(typeof error?.message === 'string' ? error.message : 'Failed to load certificate.');
      }
    } finally {
      setCoaLoading(false);
    }
  };

  const downloadCertificateOfAnalysis = () => {
    if (!coaObjectUrl) return;
    const safeBase = product.name
      .trim()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    const filename = `${safeBase || 'certificate_of_analysis'}.png`;
    const link = document.createElement('a');
    link.href = coaObjectUrl;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

			  const productMeta = (
			    <>
	      <h3 className="line-clamp-2 text-slate-900">{product.name}</h3>
	      <button
	        type="button"
	        onClick={() => void openCertificateOfAnalysis()}
        className="line-clamp-2 text-left hover:underline"
        style={{ color: 'rgb(95, 179, 249)' }}
      >
        Certificate of Analysis
      </button>
      {product.manufacturer && <p className="text-xs text-gray-500">{product.manufacturer}</p>}
    </>
  );

  const galleryImages = useMemo(() => {
    const baseImages = Array.isArray(product.images) && product.images.length > 0 ? product.images : [product.image];
    if (selectedVariation?.image) {
      return [selectedVariation.image, ...baseImages].filter(
        (src, index, arr) => Boolean(src) && arr.indexOf(src) === index,
      );
    }
    return baseImages;
  }, [product.images, product.image, selectedVariation?.image]);

  const primaryImage = galleryImages[0] || product.image;

  const variationSelector =
    product.variations && product.variations.length > 0 ? (
      <div className="space-y-1">
        <label className="text-xs text-gray-600" htmlFor={`variation-${product.id}`}>
          Strength
        </label>
        <div className="relative">
          <select
            id={`variation-${product.id}`}
            value={uiVariationId}
            onChange={(e) => handleVariationChange(e.target.value)}
            onFocus={() => {
              userInteractedRef.current = true;
              if (needsVariants || selectableVariations.length === 0) {
                void triggerVariantLoad({ force: true });
              }
            }}
            onClick={() => {
              userInteractedRef.current = true;
              if (needsVariants || selectableVariations.length === 0) {
                void triggerVariantLoad({ force: true });
              }
            }}
            onMouseDown={() => {
              userInteractedRef.current = true;
              if (needsVariants || selectableVariations.length === 0) {
                void triggerVariantLoad({ force: true });
              }
            }}
            disabled={variantsLoading}
            className="w-full squircle-sm border border-[rgba(255,255,255,0.5)] bg-white/80 px-3 py-2 text-sm font-[Lexend] transition-all focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.4)] focus:border-[rgba(95,179,249,0.6)] product-card-select"
            >
            {(needsVariants || !uiVariationId || selectableVariations.length === 0) && (
              <option value="" disabled>
                {variantsLoading ? 'Loading variants…' : 'Select strength'}
              </option>
            )}
            {selectableVariations.map((variation) => (
              <option key={variation.id} value={variation.id}>
                {variantsLoading ? 'Loading variants…' : variation.strength}
              </option>
            ))}
          </select>
          <span className="product-card-select__chevron" aria-hidden="true">
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
        </div>
      </div>
    ) : null;

  const quantitySelector = (
    <div className="space-y-1">
      <label className="text-xs text-gray-600">Quantity</label>
      <div className="flex items-center gap-2 sm:gap-3">
        <Button
          variant="outline"
          size="icon"
          className={quantityButtonClasses}
          onClick={() => handleQuantityChange(-1)}
          disabled={quantity <= 1}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <div className="flex-1 text-center px-3 py-1 glass-card squircle-sm">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            min={1}
            value={quantityInput}
            onChange={(event) => {
              const digits = event.target.value.replace(/[^0-9]/g, '');
              setQuantityInput(digits);
              if (digits) {
                const next = Math.max(1, Number(digits));
                setQuantity(next);
              }
              setBulkOpen(true);
            }}
            onBlur={() => {
              if (!quantityInput) {
                setQuantity(1);
                setQuantityInput('1');
              }
            }}
            className="h-auto border-none bg-transparent text-center text-base font-semibold focus-visible:ring-0 focus-visible:outline-none"
          />
        </div>
        <Button variant="outline" size="icon" className={quantityButtonClasses} onClick={() => handleQuantityChange(1)}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  const pricingSummary = (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-gray-600">Unit Price:</span>
        <span className="font-bold text-green-600">${currentUnitPrice.toFixed(2)}</span>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-gray-600">Total:</span>
        <span className="text-lg font-bold text-green-700">${totalPrice.toFixed(2)}</span>
      </div>
    </div>
  );

  const bulkContent =
    bulkTiers.length > 0 ? (
      <>
        <button
          type="button"
          onClick={() => setBulkOpen((prev) => !prev)}
          className="flex w-full items-center justify-between text-xs font-semibold text-slate-700 focus-visible:outline-none"
        >
          <span className="tracking-wide uppercase text-[0.65rem]">Bulk Pricing</span>
          <span className="text-[rgb(95,179,249)] text-[0.65rem] font-medium">{bulkOpen ? 'Hide' : 'Show'}</span>
        </button>
        {bulkOpen && (
          <>
            <div className="space-y-1.5 pt-1">
              {visibleBulkTiers.map((tier) => (
                <div
                  key={`${tier.minQuantity}-${tier.discountPercentage}`}
                  className="flex items-center justify-between rounded-md px-2 py-1 text-[0.8rem]"
                >
                  <span className={quantity >= tier.minQuantity ? 'text-green-600 font-semibold' : 'text-slate-600'}>
                    Buy {tier.minQuantity}+
                  </span>
                  <span
                    className={
                      quantity >= tier.minQuantity
                        ? 'text-green-600 font-semibold tabular-nums'
                        : 'text-slate-600 tabular-nums'
                    }
                  >
                    Save {tier.discountPercentage}%
                  </span>
                </div>
              ))}
            </div>
            {nextTier && (
              <p className="text-xs text-[rgb(95,179,249)] mt-1 font-medium">
                Buy {nextTier.minQuantity - quantity} more to save {nextTier.discountPercentage}%
              </p>
            )}
          </>
        )}
      </>
    ) : null;

  const gridBulkSection = bulkContent ? (
    <div className="glass-card squircle-sm border border-[var(--brand-glass-border-2)] p-3 space-y-2">{bulkContent}</div>
  ) : null;

  const addToCartButton = (
    <Button
      onClick={() => {
        onAddToCart(product.id, selectedVariation.id, quantity);
        setQuantity(1);
        setQuantityInput('1');
        setBulkOpen(false);
      }}
      className="squircle-sm glass-brand btn-hover-lighter w-full"
    >
      <ShoppingCart className="w-4 h-4 mr-2" />
      Add to Cart
    </Button>
  );

  const baseImageFrameClass = 'product-image-frame product-image-frame--flush';

  return (
    <>
      <Card
        className="group h-full gap-3 overflow-hidden glass-card squircle-lg shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-[rgba(95,179,249,0.5)] border-t border-r border-b border-[rgba(255,255,255,0.45)]"
        style={{
          background:
            'linear-gradient(to right, rgba(95,179,249,0.08) 0%, rgba(255,255,255,0.35) 8px, rgba(255,255,255,0.35) 100%)',
          backdropFilter: 'blur(40px) saturate(1.7)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.7)',
        }}
      >
        <CardContent className="flex-1 p-0">
          <div className={baseImageFrameClass}>
            <ImageWithFallback
              src={primaryImage}
              alt={product.name}
              className="product-image-frame__img"
            />
          </div>
          <div className="p-4 pb-3 space-y-3">
            <div className="space-y-1">{productMeta}</div>
            {variationSelector}
            {quantitySelector}
            {pricingSummary}
            {gridBulkSection}
          </div>
        </CardContent>
        <CardFooter className="mt-auto p-4 pt-0">{addToCartButton}</CardFooter>
      </Card>

	      <Dialog
	        open={coaOpen}
	        onOpenChange={(open) => {
          setCoaOpen(open);
          if (!open) {
            setCoaError(null);
            if (coaObjectUrl) {
              URL.revokeObjectURL(coaObjectUrl);
              setCoaObjectUrl(null);
            }
          }
        }}
	      >
			      <DialogContent className="max-w-4xl" hideCloseButton>
				        <div className="sticky top-0 z-30 -mx-6 -mt-6 mb-4 border-b border-slate-200/70 bg-white px-6 pt-6 pb-4 shadow-sm">
			          <div className="flex items-start justify-between gap-3">
			            <div className="min-w-0">
			              <DialogTitle>Certificate of Analysis</DialogTitle>
			              <DialogDescription className="truncate">{product.name}</DialogDescription>
			            </div>
			            <div className="flex items-center gap-3 shrink-0">
			              <Button
			                type="button"
			                variant="outline"
			                size="sm"
			                className="gap-2"
			                onClick={downloadCertificateOfAnalysis}
			                disabled={!coaObjectUrl || coaLoading}
			                title={coaObjectUrl ? 'Download certificate' : 'Certificate not loaded yet'}
			              >
			                <Download className="h-4 w-4" aria-hidden="true" />
			                Download
			              </Button>
			              <DialogClose
			                className="dialog-close-btn mb-2 inline-flex flex-none items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150 disabled:pointer-events-none"
			                aria-label="Close"
			                style={{ backgroundColor: 'rgb(95, 179, 249)', width: '38px', height: '38px', borderRadius: '50%' }}
			              >
			                <X className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
			              </DialogClose>
			            </div>
			          </div>
			        </div>
		
		          <div className="min-h-[320px] rounded-xl border border-[var(--brand-glass-border-2)] bg-white/80 p-3 sm:p-4 flex items-center justify-center">
		            {coaLoading ? (
		              <div className="flex items-center gap-2 text-sm text-slate-600">
		                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
		                Loading certificate…
		              </div>
		            ) : coaObjectUrl ? (
		              <img
		                src={coaObjectUrl}
		                alt={`Certificate of Analysis for ${product.name}`}
		                className="max-h-[70vh] w-auto max-w-full object-contain"
		              />
		            ) : (
		              <div className="text-sm text-slate-600 text-center">
		                {coaError || 'Unable to load certificate.'}
		              </div>
		            )}
		          </div>
		        </DialogContent>
		      </Dialog>
		    </>
		  );
		}
