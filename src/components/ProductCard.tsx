import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
import { Input } from './ui/input';
import { ImageWithFallback } from './ImageWithFallback';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogClose } from './ui/dialog';
import { ShoppingCart, Minus, Plus, Loader2, Download, X } from 'lucide-react';
import { api, wooAPI } from '../services/api';
import protixaIonSystemDossierPdf from '../content/documents/ProtixaIONSystemDossierS.pdf';

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
const PLACEHOLDER_IMAGE_SRC = '/PepPro_icon.png';

const roundCurrency = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

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

const VISIBLE_VARIANT_RETRY_INTERVAL_MS = (() => {
  const raw = String((import.meta as any).env?.VITE_VISIBLE_VARIANT_RETRY_INTERVAL_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1000) {
    return parsed;
  }
  return 4500;
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
  bulkPricingTiers?: BulkPricingTier[];
}

export interface BulkPricingTier {
  minQuantity: number;
  discountPercentage: number;
  unitPrice?: number;
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
  proposalMode?: boolean;
}

const pickDefaultVariation = (variations: ProductVariation[] | undefined | null) => {
  if (!Array.isArray(variations) || variations.length === 0) {
    return { id: 'default', strength: 'Standard', basePrice: 0 } as ProductVariation;
  }
  return variations.find((variation) => Boolean(variation?.image)) ?? variations[0];
};

let pdfJsRuntimePromise: Promise<{ getDocument: any; GlobalWorkerOptions: any }> | null = null;
const pdfByteCache = new Map<string, Uint8Array>();

const getPdfJsRuntime = async () => {
  if (!pdfJsRuntimePromise) {
    pdfJsRuntimePromise = (async () => {
      const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ]);
      GlobalWorkerOptions.workerSrc = workerModule.default;
      return { getDocument, GlobalWorkerOptions };
    })();
  }
  return pdfJsRuntimePromise;
};

const getCachedPdfBytes = async (src: string) => {
  const cached = pdfByteCache.get(src);
  if (cached) {
    return cached;
  }
  const response = await fetch(src, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Unable to load document preview (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  pdfByteCache.set(src, bytes);
  return bytes;
};

const prefersNativePdfPreview = () => {
  return true;
};

function PdfPreview({
  src,
  height,
  minHeight,
  scale = 0.84,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  preferNativePreview = prefersNativePdfPreview(),
}: {
  src: string;
  height?: string;
  minHeight: string;
  scale?: number;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  preferNativePreview?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<any>(null);
  const pageCacheRef = useRef<any[]>([]);
  const pageTextCacheRef = useRef<string[]>([]);
  const renderCycleRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentReadyVersion, setDocumentReadyVersion] = useState(0);
  const [useNativePreview, setUseNativePreview] = useState(preferNativePreview);

  useEffect(() => {
    let cancelled = false;
    documentRef.current = null;
    pageCacheRef.current = [];
    pageTextCacheRef.current = [];

    const loadPdf = async () => {
      const container = containerRef.current;
      if (!container || useNativePreview) {
        return;
      }

      container.replaceChildren();
      setLoading(true);
      setError(null);

      try {
        const { getDocument } = await getPdfJsRuntime();
        const pdfBytes = await getCachedPdfBytes(src);
        const loadingTask = getDocument({
          data: pdfBytes,
          disableRange: true,
          disableStream: true,
          disableAutoFetch: true,
        });
        const loadedDocument = await loadingTask.promise;
        if (cancelled) {
          try {
            loadedDocument?.destroy?.();
          } catch {
            // ignore cleanup errors
          }
          return;
        }
        documentRef.current = loadedDocument;
        setLoading(false);
        setDocumentReadyVersion((current) => current + 1);
      } catch (renderError: any) {
        if (cancelled) {
          return;
        }
        const message = typeof renderError?.message === 'string' ? renderError.message : '';
        const shouldFallbackToNative =
          message.toLowerCase().includes('readablestream')
          || message.toLowerCase().includes('missing request type')
          || message.toLowerCase().includes('import')
          || message.toLowerCase().includes('worker');
        if (shouldFallbackToNative) {
          setUseNativePreview(true);
          setLoading(false);
          return;
        }
        container.replaceChildren();
        setError(message || 'Unable to load document preview.');
        setLoading(false);
      }
    };

    void loadPdf();

    return () => {
      cancelled = true;
      try {
        documentRef.current?.destroy?.();
      } catch {
        // ignore cleanup errors
      }
      documentRef.current = null;
      pageCacheRef.current = [];
      pageTextCacheRef.current = [];
    };
  }, [src, useNativePreview]);

  useEffect(() => {
    let cancelled = false;
    const currentCycle = renderCycleRef.current + 1;
    renderCycleRef.current = currentCycle;
    const renderTasks: Array<{ cancel?: () => void; promise?: Promise<unknown> }> = [];

    const renderPdf = async () => {
      const container = containerRef.current;
      const currentDocument = documentRef.current;
      if (!container || !currentDocument || useNativePreview) {
        return;
      }

      container.replaceChildren();
      setError(null);
      setLoading(true);

      try {
        const deviceScale = typeof window !== 'undefined'
          ? Math.max(1.5, Math.min(window.devicePixelRatio || 1, 2))
          : 1.5;
        let firstPageRendered = false;
        const pageCount = currentDocument.numPages;
        const pageShells: HTMLDivElement[] = [];
        const pages: any[] = [];

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          if (cancelled) {
            return;
          }

          const cachedPage = pageCacheRef.current[pageNumber - 1];
          const page = cachedPage || await currentDocument.getPage(pageNumber);
          pageCacheRef.current[pageNumber - 1] = page;
          pages[pageNumber - 1] = page;
          const displayViewport = page.getViewport({ scale });
          const pageShell = document.createElement('div');
          pageShell.className = 'relative flex justify-center';
          pageShell.style.minHeight = `${displayViewport.height}px`;
          pageShell.style.width = '100%';
          container.appendChild(pageShell);
          pageShells.push(pageShell);
        }

        const renderPage = async (pageIndex: number) => {
          if (cancelled) {
            return;
          }

          const page = pages[pageIndex];
          if (!page) {
            return;
          }
          const displayViewport = page.getViewport({ scale });
          const renderViewport = page.getViewport({ scale: scale * deviceScale });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');

          if (!context) {
            throw new Error('Unable to render document preview.');
          }

          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';

          canvas.width = Math.ceil(renderViewport.width);
          canvas.height = Math.ceil(renderViewport.height);
          canvas.style.width = `${displayViewport.width}px`;
          canvas.style.height = `${displayViewport.height}px`;
          canvas.style.display = 'block';
          canvas.style.maxWidth = '100%';
          canvas.className = 'bg-white shadow-sm';

          const pageShell = pageShells[pageIndex];
          if (!pageShell) {
            throw new Error('Unable to reserve document page slot.');
          }
          pageShell.replaceChildren();

          const cachedPageText = pageTextCacheRef.current[pageIndex];
          let pageText = cachedPageText;
          if (typeof pageText !== 'string') {
            const textContent = await page.getTextContent();
            pageText = textContent.items
              .map((item: any) => {
                const text = typeof item?.str === 'string' ? item.str : '';
                return item?.hasEOL ? `${text}\n` : text;
              })
              .join(' ')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            pageTextCacheRef.current[pageIndex] = pageText;
          }

          if (pageText) {
            const textLayer = document.createElement('div');
            textLayer.setAttribute('aria-hidden', 'true');
            textLayer.style.position = 'absolute';
            textLayer.style.inset = '0';
            textLayer.style.padding = '0.25rem';
            textLayer.style.whiteSpace = 'pre-wrap';
            textLayer.style.wordBreak = 'break-word';
            textLayer.style.overflow = 'hidden';
            textLayer.style.opacity = '0.01';
            textLayer.style.color = 'transparent';
            textLayer.style.pointerEvents = 'none';
            textLayer.style.userSelect = 'text';
            textLayer.style.zIndex = '0';
            textLayer.textContent = pageText;
            pageShell.appendChild(textLayer);
          }

          canvas.style.position = 'relative';
          canvas.style.zIndex = '1';
          pageShell.appendChild(canvas);

          const renderTask = page.render({
            canvasContext: context,
            viewport: renderViewport,
          });
          renderTasks.push(renderTask);
          await renderTask.promise;
        };

        if (pageCount > 0) {
          await renderPage(0);
          if (!firstPageRendered && !cancelled && renderCycleRef.current === currentCycle) {
            firstPageRendered = true;
            setLoading(false);
          }
        }

        const remainingIndexes = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 1);
        const backgroundWorkers = Math.min(3, remainingIndexes.length);
        const runBackgroundWorker = async () => {
          while (remainingIndexes.length > 0) {
            if (cancelled || renderCycleRef.current !== currentCycle) {
              return;
            }
            const nextIndex = remainingIndexes.shift();
            if (typeof nextIndex !== 'number') {
              return;
            }
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => resolve());
            });
            await renderPage(nextIndex);
          }
        };

        await Promise.all(
          Array.from({ length: backgroundWorkers }, () => runBackgroundWorker()),
        );

        if (!cancelled && renderCycleRef.current === currentCycle && !firstPageRendered) {
          setLoading(false);
        }
      } catch (renderError: any) {
        if (cancelled) {
          return;
        }
        container.replaceChildren();
        setError(typeof renderError?.message === 'string' ? renderError.message : 'Unable to load document preview.');
        setLoading(false);
      }
    };

    void renderPdf();

    return () => {
      cancelled = true;
      renderTasks.forEach((task) => {
        try {
          task.cancel?.();
        } catch {
          // ignore cleanup errors
        }
      });
    };
  }, [documentReadyVersion, scale, useNativePreview]);

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      {!useNativePreview && (
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full border border-[var(--brand-glass-border-2)] bg-white/90 px-2 py-1 shadow-sm backdrop-blur">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-slate-700"
          onClick={onZoomOut}
          aria-label="Zoom out"
        >
          <Minus className="h-4 w-4" />
        </Button>
        <span className="min-w-[3rem] text-center text-xs font-semibold tabular-nums text-slate-700">
          {zoomPercent}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-slate-700"
          onClick={onZoomIn}
          aria-label="Zoom in"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      )}
      <div
        className={`w-full flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden ${useNativePreview ? '' : 'pt-14'}`}
        style={{
          height,
          minHeight,
        }}
      >
      {useNativePreview ? (
        <div className="h-full w-full min-w-0 overflow-auto bg-white">
          <iframe
            src={src}
            title="Protixa ION System Dossier"
            className="block h-full w-full bg-white"
            style={{
              height,
              minHeight,
              border: '0',
            }}
          />
        </div>
      ) : (
        <>
      {loading && (
        <div
          className="flex items-center justify-center gap-2 text-sm text-slate-600"
          style={{ minHeight }}
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading document…
        </div>
      )}
      {error && !loading && (
        <div
          className="flex items-center justify-center text-sm text-slate-600 text-center"
          style={{ minHeight }}
        >
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        className={`space-y-4 ${loading || error ? 'hidden' : ''}`}
      />
        </>
      )}
      </div>
    </div>
  );
}

export function ProductCard({ product, onAddToCart, onEnsureVariants, proposalMode = false }: ProductCardProps) {
  type DocumentationTabId = 'certificate' | 'nasals';
  const hasNasalsDocumentation = useMemo(() => {
    const normalizedCategory = String(product.category || '')
      .trim()
      .toLowerCase();
    if (!normalizedCategory) {
      return false;
    }
    return (
      normalizedCategory === 'nasals'
      || normalizedCategory.includes('nasal')
      || normalizedCategory.includes('oral sprays')
      || normalizedCategory.includes('spray top')
    );
  }, [product.category]);
  const documentationTabs = useMemo(
    () => ([
      { id: 'certificate', label: 'Certificate of Analysis' },
      ...(hasNasalsDocumentation ? [{ id: 'nasals', label: 'Technical Dossier' } as const] : []),
    ] as Array<{ id: DocumentationTabId; label: string }>),
    [hasNasalsDocumentation],
  );
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
  const variantRetryLastAttemptAtRef = useRef(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isCardVisible, setIsCardVisible] = useState(false);
  const userInteractedRef = useRef(false);
  const [documentationTab, setDocumentationTab] = useState<DocumentationTabId>('certificate');
  const autoCycleDoneRef = useRef<string | null>(null);
  const autoOpenDoneRef = useRef<string | null>(null);
  const [coaOpen, setCoaOpen] = useState(false);
  const [coaLoading, setCoaLoading] = useState(false);
  const [coaError, setCoaError] = useState<string | null>(null);
  const [coaObjectUrl, setCoaObjectUrl] = useState<string | null>(null);
  const [coaBlobType, setCoaBlobType] = useState<string | null>(null);
  const coaLoadAttemptedRef = useRef(false);
  const documentationTabsContainerRef = useRef<HTMLDivElement | null>(null);
  const [documentationIndicatorLeft, setDocumentationIndicatorLeft] = useState(0);
  const [documentationIndicatorWidth, setDocumentationIndicatorWidth] = useState(0);
  const [documentationIndicatorOpacity, setDocumentationIndicatorOpacity] = useState(0);
  const [documentationViewportHeight, setDocumentationViewportHeight] = useState<number | null>(null);
  const [nasalsPreviewScale, setNasalsPreviewScale] = useState(0.82);
  const [coaPreviewScale, setCoaPreviewScale] = useState(0.82);
  const [hasOpenedNasalsDocumentation, setHasOpenedNasalsDocumentation] = useState(false);

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
    if (!hasNasalsDocumentation && documentationTab === 'nasals') {
      setDocumentationTab('certificate');
    }
  }, [documentationTab, hasNasalsDocumentation]);

  useEffect(() => {
    if (hasNasalsDocumentation && documentationTab === 'nasals') {
      setHasOpenedNasalsDocumentation(true);
    }
  }, [documentationTab, hasNasalsDocumentation]);

  useEffect(() => {
    if (!coaOpen) {
      setNasalsPreviewScale(0.82);
      setCoaPreviewScale(0.82);
    }
  }, [coaOpen]);

  const updateDocumentationTabIndicator = useCallback(() => {
    const container = documentationTabsContainerRef.current;
    if (!container) return;
    const activeBtn =
      container.querySelector<HTMLButtonElement>(`button[data-documentation-tab="${documentationTab}"]`)
      || container.querySelector<HTMLButtonElement>('button[data-documentation-tab]');
    if (!activeBtn) return;
    const inset = 8;
    const scrollLeft = container.scrollLeft || 0;
    const left = Math.max(0, activeBtn.offsetLeft - scrollLeft + inset);
    const width = Math.max(0, activeBtn.offsetWidth - inset * 2);
    setDocumentationIndicatorLeft(left);
    setDocumentationIndicatorWidth(width);
    setDocumentationIndicatorOpacity(width > 0 ? 1 : 0);
  }, [documentationTab]);

  const setDocumentationTabsContainerRef = useCallback((node: HTMLDivElement | null) => {
    documentationTabsContainerRef.current = node;
    if (!node) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        updateDocumentationTabIndicator();
      });
    });
  }, [updateDocumentationTabIndicator]);

  useLayoutEffect(() => {
    if (!coaOpen) return;
    const frame = window.requestAnimationFrame(() => {
      updateDocumentationTabIndicator();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [coaOpen, documentationTab, documentationTabs, updateDocumentationTabIndicator]);

  useEffect(() => {
    if (!coaOpen) return;
    const handleResize = () => updateDocumentationTabIndicator();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [coaOpen, updateDocumentationTabIndicator]);

  useEffect(() => {
    if (!coaOpen || typeof window === 'undefined') {
      return;
    }

    const syncViewportHeight = () => {
      const nextHeight = Math.max(window.innerHeight || 0, window.visualViewport?.height || 0);
      setDocumentationViewportHeight(nextHeight > 0 ? nextHeight : null);
    };

    syncViewportHeight();
    window.addEventListener('resize', syncViewportHeight);
    window.addEventListener('orientationchange', syncViewportHeight);
    window.visualViewport?.addEventListener('resize', syncViewportHeight);

    return () => {
      window.removeEventListener('resize', syncViewportHeight);
      window.removeEventListener('orientationchange', syncViewportHeight);
      window.visualViewport?.removeEventListener('resize', syncViewportHeight);
    };
  }, [coaOpen]);

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

  const bulkTiers = selectedVariation.bulkPricingTiers ?? product.bulkPricingTiers ?? [];
  const quantityButtonClasses = 'h-8 w-8 squircle-sm';

  const calculatePrice = () => {
    if (bulkTiers.length === 0) {
      return roundCurrency(selectedVariation.basePrice);
    }
    const applicableTier = [...bulkTiers]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find((tier) => quantity >= tier.minQuantity);
    if (applicableTier) {
      const fixedUnitPrice = Number(applicableTier.unitPrice);
      if (Number.isFinite(fixedUnitPrice) && fixedUnitPrice > 0) {
        return roundCurrency(fixedUnitPrice);
      }
      const discount = applicableTier.discountPercentage / 100;
      return roundCurrency(selectedVariation.basePrice * (1 - discount));
    }
    return roundCurrency(selectedVariation.basePrice);
  };

  const currentUnitPrice = calculatePrice();
  const totalPrice = roundCurrency(currentUnitPrice * quantity);
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

  const triggerVariantLoad = useCallback(
    async (options?: { force?: boolean }) => {
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
    },
    [canLoadVariants, onEnsureVariants, variantsLoading],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const node = cardRef.current;
    if (!node) {
      return;
    }
    if (typeof IntersectionObserver !== 'function') {
      setIsCardVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        setIsCardVisible(Boolean(entry?.isIntersecting));
      },
      { root: null, rootMargin: '220px 0px', threshold: 0.01 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const stillNeedsVariants =
      needsVariants || selectableVariations.length === 0 || !uiVariationId;
    if (!isCardVisible || !canLoadVariants || !stillNeedsVariants) {
      return;
    }

    let cancelled = false;
    const runAttempt = () => {
      if (cancelled || variantsLoading) {
        return;
      }
      const now = Date.now();
      if (now - variantRetryLastAttemptAtRef.current < VISIBLE_VARIANT_RETRY_INTERVAL_MS) {
        return;
      }
      variantRetryLastAttemptAtRef.current = now;
      void triggerVariantLoad({ force: true });
    };

    runAttempt();
    const timer = window.setInterval(runAttempt, VISIBLE_VARIANT_RETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    canLoadVariants,
    isCardVisible,
    needsVariants,
    selectableVariations.length,
    triggerVariantLoad,
    uiVariationId,
    variantsLoading,
  ]);

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

  const ensureCertificateOfAnalysisLoaded = useCallback(async () => {
    setCoaError(null);
    if (coaObjectUrl || coaLoading || coaLoadAttemptedRef.current) {
      return;
    }
    if (!wooProductId) {
      coaLoadAttemptedRef.current = true;
      setCoaError('Certificate unavailable for this product.');
      return;
    }

    coaLoadAttemptedRef.current = true;
    setCoaLoading(true);
    try {
      const { blob } = await wooAPI.getCertificateOfAnalysis(wooProductId);
      const url = URL.createObjectURL(blob);
      setCoaBlobType(blob?.type || null);
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
  }, [coaLoading, coaObjectUrl, wooProductId]);

  const openDocumentationModal = () => {
    coaLoadAttemptedRef.current = false;
    setCoaOpen(true);
    setDocumentationTab(hasNasalsDocumentation ? 'nasals' : 'certificate');
    setCoaError(null);
  };

  useEffect(() => {
    if (!coaOpen || documentationTab !== 'certificate') {
      return;
    }
    void ensureCertificateOfAnalysisLoaded();
  }, [coaOpen, documentationTab, ensureCertificateOfAnalysisLoaded]);

  const downloadCertificateOfAnalysis = () => {
    if (!coaObjectUrl) return;
    const safeBase = product.name
      .trim()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    const extension = coaBlobType?.toLowerCase().includes('pdf') ? 'pdf' : 'png';
    const filename = `${safeBase || 'certificate_of_analysis'}.${extension}`;
    const link = document.createElement('a');
    link.href = coaObjectUrl;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();

    try {
      void api.post('/settings/downloads/track', {
        kind: 'coa',
        wooProductId,
        productId: product?.id,
        filename,
        at: new Date().toISOString(),
      });
    } catch {
      // Best-effort telemetry only.
    }
  };

  const downloadNasalsDocumentation = () => {
    const link = document.createElement('a');
    link.href = protixaIonSystemDossierPdf;
    link.download = 'ProtixaIONSystemDossierS.pdf';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const downloadActiveDocumentation = () => {
    if (hasNasalsDocumentation && documentationTab === 'nasals') {
      downloadNasalsDocumentation();
      return;
    }
    downloadCertificateOfAnalysis();
  };
  const hasActiveDocumentationPreview =
    (hasNasalsDocumentation && documentationTab === 'nasals')
    || (documentationTab === 'certificate' && Boolean(coaObjectUrl) && !coaLoading);
  const modalHeaderOffsetPx = 96;
  const modalBottomMarginPx = 12;
  const measuredModalMaxHeight = documentationViewportHeight
    ? Math.max(420, documentationViewportHeight - modalHeaderOffsetPx - modalBottomMarginPx)
    : null;
  const documentationModalMaxHeight = measuredModalMaxHeight
    ? `${measuredModalMaxHeight}px`
    : 'calc(100dvh - var(--modal-header-offset, 6rem))';
  const documentationPreviewHeight = hasActiveDocumentationPreview
    ? undefined
    : '320px';
  const documentationPreviewMinHeight = hasActiveDocumentationPreview ? '380px' : '320px';
  const nasalsDocumentationPreviewUrl = protixaIonSystemDossierPdf;
  const coaPreviewIsPdf = Boolean(coaBlobType?.toLowerCase().includes('pdf'));
  const nasalsPreviewPercent = Math.round(nasalsPreviewScale * 100);
  const coaPreviewPercent = Math.round(coaPreviewScale * 100);

			  const productMeta = (
			    <>
	      <h3 className="line-clamp-2 text-slate-900">{product.name}</h3>
      <button
	        type="button"
	        onClick={openDocumentationModal}
        className="line-clamp-2 text-left hover:underline"
        style={{ color: 'rgb(95, 179, 249)' }}
      >
        Documentation and Analysis
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
  const showVariationChevron = selectableVariations.length > 1;

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
            className={`w-full squircle-sm border border-[rgba(255,255,255,0.5)] bg-white/80 px-3 py-2 text-sm font-[Lexend] transition-all focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.4)] focus:border-[rgba(95,179,249,0.6)] product-card-select${showVariationChevron ? '' : ' pr-3'}`}
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
          {showVariationChevron && (
            <span className="product-card-select__chevron" aria-hidden="true">
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
          )}
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
      className={proposalMode ? 'squircle-sm btn-hover-lighter w-full border-0 text-white [&_svg]:text-white' : 'squircle-sm glass-brand btn-hover-lighter w-full'}
      style={proposalMode ? { backgroundColor: 'rgb(95, 179, 249)', borderColor: 'rgb(95, 179, 249)', color: '#ffffff', WebkitTextFillColor: '#ffffff' } : undefined}
	    >
	      {proposalMode ? (
	        <Plus className="w-4 h-4 mr-2" />
	      ) : (
	        <ShoppingCart className="w-4 h-4 mr-2" />
	      )}
	      {proposalMode ? '+ Add to Proposal' : 'Add to cart'}
	    </Button>
	  );

  const baseImageFrameClass = 'product-image-frame product-image-frame--flush';

  return (
    <>
      <Card
        ref={cardRef}
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
            coaLoadAttemptedRef.current = false;
            setDocumentationTab('certificate');
            setCoaError(null);
            setCoaBlobType(null);
            if (coaObjectUrl) {
              URL.revokeObjectURL(coaObjectUrl);
              setCoaObjectUrl(null);
            }
          }
        }}
	      >
              <DialogContent
              className="checkout-modal account-modal glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col overflow-hidden"
              containerClassName="fixed inset-x-0 bottom-0 z-[10000] flex items-end justify-center px-3 pb-3 sm:px-4 sm:pb-3"
              containerStyle={{
                top: 'var(--modal-header-offset, 6rem)',
                left: 0,
                right: 0,
              }}
              style={{
                backdropFilter: 'blur(38px) saturate(1.6)',
                height: documentationModalMaxHeight,
                maxHeight: documentationModalMaxHeight,
                margin: '0 auto',
                overflow: 'hidden',
              }}
              hideCloseButton
            >
              <DialogHeader className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 self-end">
                    <div className="flex items-stretch gap-6">
                      <div className="min-w-0 flex-shrink">
                        <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
                          Documentation and Analysis
                        </DialogTitle>
                        <DialogDescription className="truncate">{product.name}</DialogDescription>
                      </div>
                      <div className="relative ml-auto flex-shrink-0 account-tab-shell documentation-header-tabs">
                        <div
                          className="account-tab-scroll-container"
                          ref={setDocumentationTabsContainerRef}
                          onScroll={updateDocumentationTabIndicator}
                        >
                          <div className="flex items-center gap-4 pb-0 account-tab-row">
                            {documentationTabs.map((tab) => {
                              const isActive = documentationTab === tab.id;
                              return (
                                <button
                                  key={tab.id}
                                  type="button"
                                  onClick={() => setDocumentationTab(tab.id)}
                                  className={`relative inline-flex items-center gap-2 px-3 pt-1 text-sm font-semibold whitespace-nowrap transition-colors text-slate-600 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black/30 flex-shrink-0 ${
                                    isActive ? 'text-slate-900' : ''
                                  }`}
                                  data-documentation-tab={tab.id}
                                  aria-pressed={isActive}
                                >
                                  {tab.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <span
                          aria-hidden="true"
                          className="account-tab-underline-indicator"
                          style={{
                            left: documentationIndicatorLeft,
                            width: documentationIndicatorWidth,
                            opacity: documentationIndicatorOpacity,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={downloadActiveDocumentation}
                      disabled={documentationTab === 'certificate' && (!coaObjectUrl || coaLoading)}
                      title={
                        hasNasalsDocumentation && documentationTab === 'nasals'
                          ? 'Download nasals documentation'
                          : coaObjectUrl
                            ? 'Download certificate'
                            : 'Certificate not loaded yet'
                      }
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                      Download
                    </Button>
                    <DialogClose
                      className="dialog-close-btn inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full p-0 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
                      style={{
                        backgroundColor: 'rgb(95, 179, 249)',
                        borderRadius: '50%',
                      }}
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" />
                    </DialogClose>
                  </div>
                </div>
              </DialogHeader>
		
		          <div className={`flex flex-1 min-h-0 flex-col overflow-hidden px-6 ${hasActiveDocumentationPreview ? 'pb-5' : 'pb-6'}`}>
                <div className="flex flex-1 min-h-0 flex-col overflow-hidden pt-6">
                  <div
                    className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden rounded-xl border border-[var(--brand-glass-border-2)] bg-white/80 p-3 sm:p-4"
                    style={{
                      minHeight: documentationPreviewMinHeight,
                    }}
                  >
		            {hasNasalsDocumentation && hasOpenedNasalsDocumentation ? (
                    <div className={documentationTab === 'nasals' ? 'flex h-full min-h-0 w-full min-w-0 flex-1 self-stretch' : 'hidden'}>
                      <PdfPreview
                        src={nasalsDocumentationPreviewUrl}
                        height={documentationPreviewHeight}
                        minHeight={documentationPreviewMinHeight}
                        scale={nasalsPreviewScale}
                        zoomPercent={nasalsPreviewPercent}
                        onZoomOut={() => setNasalsPreviewScale((current) => Math.max(0.55, Number((current - 0.08).toFixed(2))))}
                        onZoomIn={() => setNasalsPreviewScale((current) => Math.min(1.4, Number((current + 0.08).toFixed(2))))}
                      />
                    </div>
                  ) : null}
                  {documentationTab === 'nasals' ? null : coaLoading ? (
		              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-600">
		                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
		                Loading certificate…
		              </div>
		            ) : coaObjectUrl ? (
                    coaPreviewIsPdf ? (
                      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 self-stretch">
                        <PdfPreview
                          src={coaObjectUrl}
                          height={documentationPreviewHeight}
                          minHeight={documentationPreviewMinHeight}
                          scale={coaPreviewScale}
                          zoomPercent={coaPreviewPercent}
                          onZoomOut={() => setCoaPreviewScale((current) => Math.max(0.55, Number((current - 0.08).toFixed(2))))}
                          onZoomIn={() => setCoaPreviewScale((current) => Math.min(1.4, Number((current + 0.08).toFixed(2))))}
                          preferNativePreview={false}
                        />
                      </div>
                    ) : (
                      <div
                        className="h-full w-full min-w-0 flex-1 self-stretch overflow-y-auto overflow-x-hidden bg-white"
                        style={{
                          minHeight: documentationPreviewMinHeight,
                        }}
                      >
                        <img
                          src={coaObjectUrl}
                          alt={`Certificate of Analysis for ${product.name}`}
                          className="block h-auto w-full max-w-full"
                        />
                      </div>
                    )
		            ) : (
		              <div className="flex flex-1 items-center justify-center text-sm text-slate-600 text-center">
		                {coaError || 'Unable to load certificate.'}
		              </div>
		            )}
                  </div>
                </div>
              </div>
		        </DialogContent>
		      </Dialog>
		    </>
		  );
		}
