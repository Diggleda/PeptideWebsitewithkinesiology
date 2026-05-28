import { getSvgPath } from "figma-squircle";

const DASHBOARD_SQUIRCLE_SELECTOR = [
  "[data-dashboard-squircle-surface]",
  '[data-slot="card"]',
  ".glass-card",
  ".glass-liquid",
  ".landing-glass",
  ".marketing-landing__capability",
  ".marketing-landing__standard",
  ".marketing-landing__mechanism",
  ".catalog-filter-card",
  ".catalog-product-card",
  ".catalog-personalized-product-card",
  ".catalog-skeleton-card",
  ".news-loading-card",
  ".manufacturing-standards-card",
  ".info-highlight-card",
  ".physician-network-card",
  ".physician-network-map-profile-card",
  ".physician-network-state-breakdown__profile-card",
  ".post-login-info",
  ".dashboard-feedback-note",
  ".physician-dashboard-container",
  ".physician-dashboard-panel",
  ".sales-rep-dashboard",
  ".admin-dashboard-list",
  ".admin-dashboard-list-card",
  ".admin-revenue-outlook-card",
  ".admin-revenue-outlook-summary-card__stat",
  ".database-visualizer-card",
  ".database-visualizer-controls-panel",
  ".database-visualizer-layout",
  ".database-visualizer-layout > aside",
  ".database-visualizer-layout > div",
  ".referrals-table-container",
  ".sales-rep-leads-card",
  ".sales-rep-combined-card",
  ".sales-rep-table-wrapper",
  ".sales-metric-pill",
  ".sales-tracking-card",
  ".sales-tracking-row",
  ".sales-tracking-summary-item",
  ".lead-panel",
  ".lead-list-item",
  ".quote-panel-card",
  ".quote-history-row",
  ".sales-order-card",
  ".account-order-card",
  ".admin-todo-list__item",
  ".referrals-table__row",
  ".sales-doctor-detail-panel",
  ".sales-doctor-row",
  ".patient-link-group",
  ".delegate-white-label-details",
  ".reseller-permit-settings-card",
].join(",");

const DASHBOARD_SQUIRCLE_EXCLUDE_SELECTOR = [
  "[data-app-header]",
  ".app-header-blur",
  ".modal-squircle",
  ".modal-squircle *",
  "[data-dashboard-squircle='off']",
].join(",");

const DEFAULT_DASHBOARD_SQUIRCLE_RADIUS = 28;
const DEFAULT_DASHBOARD_SQUIRCLE_SMOOTHING = 0.8;
const DASHBOARD_SQUIRCLE_BORDER_FALLBACK = "rgba(11, 6, 121, 0.55)";
const DASHBOARD_SQUIRCLE_SHAPE_CLASS = "dashboard-squircle-shape";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const observedElements = new WeakSet<HTMLElement>();
const pendingElements = new Set<HTMLElement>();
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let frameId = 0;

type SquircleSize = {
  height: number;
  width: number;
};

const supportsClipPathPath = () => {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  return (
    CSS.supports("clip-path", 'path("M 0 0 L 1 0 L 1 1 L 0 1 Z")') ||
    CSS.supports("-webkit-clip-path", 'path("M 0 0 L 1 0 L 1 1 L 0 1 Z")')
  );
};

const parsePixelValue = (value: string | null | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getElementRadius = (element: HTMLElement) => {
  const styles = window.getComputedStyle(element);
  return parsePixelValue(
    styles.getPropertyValue("--dashboard-squircle-radius").trim() ||
      styles.getPropertyValue("--container-squircle-radius").trim() ||
      styles.getPropertyValue("--container-radius").trim(),
    DEFAULT_DASHBOARD_SQUIRCLE_RADIUS,
  );
};

const getElementSmoothing = (element: HTMLElement) => {
  const styles = window.getComputedStyle(element);
  const parsed = Number.parseFloat(styles.getPropertyValue("--dashboard-squircle-smoothing").trim());
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DASHBOARD_SQUIRCLE_SMOOTHING;
  }
  return Math.min(1, Math.max(0, parsed));
};

const svgMaskUrl = (path: string, width: number, height: number) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path fill="white" d="${path}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

const isTransparentColor = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "transparent") {
    return true;
  }
  return /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(normalized);
};

const getBorderStroke = (element: HTMLElement) => {
  const styles = window.getComputedStyle(element);
  const widths = [
    parsePixelValue(styles.borderTopWidth, 0),
    parsePixelValue(styles.borderRightWidth, 0),
    parsePixelValue(styles.borderBottomWidth, 0),
    parsePixelValue(styles.borderLeftWidth, 0),
  ];
  const colors = [
    styles.borderTopColor,
    styles.borderRightColor,
    styles.borderBottomColor,
    styles.borderLeftColor,
  ];
  const borderStyles = [
    styles.borderTopStyle,
    styles.borderRightStyle,
    styles.borderBottomStyle,
    styles.borderLeftStyle,
  ];
  const hasBoxedBorder = widths.every((width) => width > 0) && borderStyles.every((style) => style !== "none" && style !== "hidden");
  if (!hasBoxedBorder) {
    return null;
  }

  const storedColor = element.dataset.dashboardSquircleBorderColor;
  const maxWidth = Math.max(...widths);
  const maxWidthIndex = widths.findIndex((width) => width === maxWidth);
  const computedColor = colors[maxWidthIndex] || styles.borderTopColor;
  if (!storedColor && isTransparentColor(computedColor)) {
    return null;
  }

  const color = storedColor || computedColor || DASHBOARD_SQUIRCLE_BORDER_FALLBACK;
  element.dataset.dashboardSquircleBorderColor = color;

  return {
    color,
    width: maxWidth,
  };
};

const getExistingShape = (element: HTMLElement) =>
  Array.from(element.children).find(
    (child): child is SVGSVGElement =>
      child instanceof SVGSVGElement && child.classList.contains(DASHBOARD_SQUIRCLE_SHAPE_CLASS),
  ) ?? null;

const ensureBorderShape = (element: HTMLElement) => {
  let svg = getExistingShape(element);
  let path = svg?.querySelector<SVGPathElement>("path") ?? null;

  if (!svg) {
    svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.classList.add(DASHBOARD_SQUIRCLE_SHAPE_CLASS);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("preserveAspectRatio", "none");
    element.insertBefore(svg, element.firstChild);
  }

  if (!path) {
    path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(path);
  }

  return { path, svg };
};

const removeBorderShape = (element: HTMLElement) => {
  getExistingShape(element)?.remove();
  delete element.dataset.dashboardSquircleBorder;
};

const clearDashboardSquircle = (element: HTMLElement) => {
  const hadGeneratedSquircle =
    element.dataset.dashboardSquircle === "on" ||
    Boolean(element.style.getPropertyValue("--dashboard-squircle-clip-path")) ||
    Boolean(getExistingShape(element));
  if (!hadGeneratedSquircle) {
    return;
  }

  removeBorderShape(element);
  delete element.dataset.dashboardSquircle;
  delete element.dataset.dashboardSquircleBorderColor;
  element.style.removeProperty("--dashboard-squircle-clip-path");
  element.style.removeProperty("clip-path");
  element.style.removeProperty("-webkit-clip-path");
  element.style.removeProperty("mask-image");
  element.style.removeProperty("mask-repeat");
  element.style.removeProperty("mask-size");
  element.style.removeProperty("-webkit-mask-image");
  element.style.removeProperty("-webkit-mask-repeat");
  element.style.removeProperty("-webkit-mask-size");
  element.style.removeProperty("border-color");
};

const getResizeObserverBorderBox = (entry: ResizeObserverEntry): SquircleSize | null => {
  const borderBoxSize = entry.borderBoxSize;
  const borderBox = Array.isArray(borderBoxSize) ? borderBoxSize[0] : borderBoxSize;
  if (!borderBox) {
    return null;
  }
  return {
    height: Math.round(borderBox.blockSize),
    width: Math.round(borderBox.inlineSize),
  };
};

const queueElement = (element: HTMLElement) => {
  pendingElements.add(element);
  if (frameId) return;
  frameId = window.requestAnimationFrame(() => {
    frameId = 0;
    const nextElements = Array.from(pendingElements);
    pendingElements.clear();
    nextElements.forEach(applyDashboardSquircle);
  });
};

const applyDashboardSquircle = (element: HTMLElement, observedSize?: SquircleSize | null) => {
  if (!element.isConnected) {
    return;
  }

  if (element.matches(DASHBOARD_SQUIRCLE_EXCLUDE_SELECTOR)) {
    clearDashboardSquircle(element);
    return;
  }

  const width = observedSize?.width ?? Math.round(element.offsetWidth);
  const height = observedSize?.height ?? Math.round(element.offsetHeight);
  if (width < 2 || height < 2) {
    return;
  }

  const cornerRadius = Math.min(getElementRadius(element), Math.floor(Math.min(width, height) / 2));
  const cornerSmoothing = getElementSmoothing(element);
  const path = getSvgPath({
    cornerRadius,
    cornerSmoothing,
    height,
    preserveSmoothing: true,
    width,
  });
  const clipPath = `path("${path}")`;

  element.dataset.dashboardSquircle = "on";
  element.style.setProperty("--dashboard-squircle-clip-path", clipPath);
  element.style.clipPath = clipPath;
  element.style.setProperty("-webkit-clip-path", clipPath);

  const currentPosition = window.getComputedStyle(element).position;
  if (currentPosition === "static") {
    element.style.position = "relative";
  }

  const borderStroke = getBorderStroke(element);
  if (borderStroke) {
    const strokeWidth = Math.min(borderStroke.width, Math.floor(Math.min(width, height) / 2));
    const strokeOffset = strokeWidth / 2;
    const strokePathWidth = Math.max(0, width - strokeWidth);
    const strokePathHeight = Math.max(0, height - strokeWidth);
    const strokePath =
      strokePathWidth > 0 && strokePathHeight > 0
        ? getSvgPath({
            cornerRadius: Math.max(0, cornerRadius - strokeOffset),
            cornerSmoothing,
            height: strokePathHeight,
            preserveSmoothing: true,
            width: strokePathWidth,
          })
        : "";

    if (strokePath) {
      const { path: borderPath, svg } = ensureBorderShape(element);
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("width", String(width));
      borderPath.setAttribute("d", strokePath);
      borderPath.setAttribute("stroke", borderStroke.color);
      borderPath.setAttribute("stroke-width", String(strokeWidth));
      borderPath.setAttribute("transform", `translate(${strokeOffset} ${strokeOffset})`);
      element.dataset.dashboardSquircleBorder = "on";
      element.style.setProperty("border-color", "transparent", "important");
    } else {
      removeBorderShape(element);
    }
  } else {
    removeBorderShape(element);
  }

  if (!supportsClipPathPath()) {
    const mask = svgMaskUrl(path, width, height);
    element.style.setProperty("mask-image", mask);
    element.style.setProperty("mask-size", "100% 100%");
    element.style.setProperty("mask-repeat", "no-repeat");
    element.style.setProperty("mask-mode", "alpha");
    element.style.setProperty("-webkit-mask-image", mask);
    element.style.setProperty("-webkit-mask-size", "100% 100%");
    element.style.setProperty("-webkit-mask-repeat", "no-repeat");
    element.style.setProperty("-webkit-mask-mode", "alpha");
  }
};

const observeElement = (element: HTMLElement) => {
  if (element.matches(DASHBOARD_SQUIRCLE_EXCLUDE_SELECTOR)) {
    clearDashboardSquircle(element);
    return;
  }

  if (observedElements.has(element)) {
    queueElement(element);
    return;
  }
  observedElements.add(element);
  resizeObserver?.observe(element);
  queueElement(element);
};

const scanDashboardSquircleSurfaces = (root: ParentNode = document) => {
  if (root instanceof HTMLElement && root.matches(DASHBOARD_SQUIRCLE_SELECTOR)) {
    observeElement(root);
  }
  root.querySelectorAll<HTMLElement>(DASHBOARD_SQUIRCLE_SELECTOR).forEach(observeElement);
};

const scanMutationTarget = (target: HTMLElement) => {
  if (target.matches(DASHBOARD_SQUIRCLE_EXCLUDE_SELECTOR)) {
    clearDashboardSquircle(target);
    return;
  }
  scanDashboardSquircleSurfaces(target);
};

export const installDashboardSquircleSurfaces = () => {
  if (typeof window === "undefined" || typeof document === "undefined" || mutationObserver) {
    return;
  }

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target instanceof HTMLElement) {
          applyDashboardSquircle(entry.target, getResizeObserverBorderBox(entry));
        }
      });
    });
  }

  mutationObserver = new MutationObserver((records) => {
    const scanRoots = new Set<HTMLElement>();

    records.forEach((record) => {
      if (record.type === "attributes") {
        if (!(record.target instanceof HTMLElement)) {
          return;
        }

        if (record.target.matches(DASHBOARD_SQUIRCLE_EXCLUDE_SELECTOR)) {
          clearDashboardSquircle(record.target);
        }

        if (record.attributeName !== "data-dashboard-squircle") {
          scanRoots.add(record.target);
        }

        return;
      }

      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          scanRoots.add(node);
        }
      });
    });

    scanRoots.forEach(scanMutationTarget);
  });

  scanDashboardSquircleSurfaces();
  mutationObserver.observe(document.documentElement, {
    attributeFilter: ["class", "data-dashboard-squircle", "data-dashboard-squircle-surface"],
    attributes: true,
    childList: true,
    subtree: true,
  });
};
