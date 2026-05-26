import {
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { Product } from "../types/product";

const PRODUCT_TITLE_ROW_TOLERANCE_PX = 6;
const PRODUCT_TITLE_WRAP_TOLERANCE_PX = 2;

const parseCssPixels = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

type ProductTitleMeasurement = {
  card: HTMLElement;
  top: number;
  lineHeight: number;
  needsTwoLines: boolean;
};

const measureTitleNeedsTwoLines = (
  title: HTMLElement,
  computed: CSSStyleDeclaration,
  width: number,
  lineHeight: number,
) => {
  const text = title.textContent || "";
  const body = title.ownerDocument.body;
  if (!text.trim() || !body || width <= 0) {
    return false;
  }

  const measure = title.ownerDocument.createElement("div");
  measure.textContent = text;
  measure.style.position = "absolute";
  measure.style.visibility = "hidden";
  measure.style.pointerEvents = "none";
  measure.style.left = "-10000px";
  measure.style.top = "0";
  measure.style.width = `${width}px`;
  measure.style.maxWidth = `${width}px`;
  measure.style.padding = "0";
  measure.style.border = "0";
  measure.style.boxSizing = "border-box";
  measure.style.display = "block";
  measure.style.overflow = "visible";
  measure.style.whiteSpace = "normal";
  measure.style.font = computed.font;
  measure.style.fontFamily = computed.fontFamily;
  measure.style.fontSize = computed.fontSize;
  measure.style.fontWeight = computed.fontWeight;
  measure.style.fontStyle = computed.fontStyle;
  measure.style.fontStretch = computed.fontStretch;
  measure.style.lineHeight = computed.lineHeight;
  measure.style.letterSpacing = computed.letterSpacing;
  measure.style.wordSpacing = computed.wordSpacing;
  measure.style.textTransform = computed.textTransform;
  measure.style.wordBreak = computed.wordBreak;
  measure.style.overflowWrap = computed.overflowWrap;
  measure.style.setProperty("-webkit-line-clamp", "unset");
  measure.style.setProperty("-webkit-box-orient", "initial");

  body.appendChild(measure);
  const measuredHeight = measure.getBoundingClientRect().height || measure.scrollHeight;
  measure.remove();

  return measuredHeight > lineHeight + PRODUCT_TITLE_WRAP_TOLERANCE_PX;
};

const getProductCards = (grid: HTMLElement) =>
  Array.from(grid.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("catalog-product-card"),
  );

const useSmartProductTitleRows = (
  gridRef: RefObject<HTMLDivElement>,
  layoutSignature: string,
) => {
  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let animationFrame = 0;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const observeCurrentCards = () => {
      const grid = gridRef.current;
      if (!grid || !resizeObserver) return;

      resizeObserver.observe(grid);
      getProductCards(grid).forEach((card) => resizeObserver?.observe(card));
    };

    const measureRows = () => {
      animationFrame = 0;
      if (cancelled) return;

      const grid = gridRef.current;
      if (!grid) return;
      observeCurrentCards();

      const measurements = getProductCards(grid)
        .map<ProductTitleMeasurement | null>((card) => {
          const title = card.querySelector<HTMLElement>(".product-card-title");
          if (!title) return null;

          const titleRect = title.getBoundingClientRect();
          const computed = window.getComputedStyle(title);
          const fontSize = parseCssPixels(computed.fontSize, 16);
          const lineHeight = computed.lineHeight === "normal"
            ? fontSize * 1.5
            : parseCssPixels(computed.lineHeight, fontSize * 1.5);
          if (titleRect.width <= 0 || lineHeight <= 0) return null;

          return {
            card,
            top: card.getBoundingClientRect().top,
            lineHeight,
            needsTwoLines: measureTitleNeedsTwoLines(title, computed, titleRect.width, lineHeight),
          };
        })
        .filter((measurement): measurement is ProductTitleMeasurement => measurement !== null)
        .sort((left, right) => left.top - right.top);

      const rows: Array<typeof measurements> = [];
      measurements.forEach((measurement) => {
        const row = rows.find(
          (candidate) =>
            Math.abs(candidate[0].top - measurement.top) <= PRODUCT_TITLE_ROW_TOLERANCE_PX,
        );
        if (row) {
          row.push(measurement);
        } else {
          rows.push([measurement]);
        }
      });

      rows.forEach((row) => {
        const reserveTwoLines = row.some((measurement) => measurement.needsTwoLines);
        row.forEach(({ card, lineHeight }) => {
          const minHeight = `${Math.ceil(lineHeight * (reserveTwoLines ? 2 : 1))}px`;
          if (card.style.getPropertyValue("--product-card-title-min-height") !== minHeight) {
            card.style.setProperty("--product-card-title-min-height", minHeight);
          }
          card.dataset.productTitleRowLines = reserveTwoLines ? "2" : "1";
        });
      });
    };

    const scheduleMeasure = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(measureRows);
    };

    scheduleMeasure();

    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(scheduleMeasure);
      observeCurrentCards();
    } else {
      window.addEventListener("resize", scheduleMeasure);
    }

    if ("MutationObserver" in window) {
      const grid = gridRef.current;
      if (grid) {
        mutationObserver = new MutationObserver(() => {
          observeCurrentCards();
          scheduleMeasure();
        });
        mutationObserver.observe(grid, { childList: true });
      }
    }

    const fontsReady = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
    fontsReady?.then(scheduleMeasure).catch(() => undefined);

    return () => {
      cancelled = true;
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [gridRef, layoutSignature]);
};

export function CatalogProductGrid({
  products,
  children,
}: {
  products: Product[];
  children: ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const titleLayoutSignature = products
    .map((product) => `${product.id}:${product.name}`)
    .join("|");

  useSmartProductTitleRows(gridRef, titleLayoutSignature);

  return (
    <div ref={gridRef} className="grid gap-6 w-full px-4 sm:px-6 lg:px-0 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {children}
    </div>
  );
}
