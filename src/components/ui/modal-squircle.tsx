"use client";

import * as React from "react";
import { getSvgPath } from "figma-squircle";

import { cn } from "./utils";

type ModalSquircleProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  borderColor?: string;
  borderWidth?: number;
  cornerRadius?: number;
  cornerSmoothing?: number;
  shadow?: string;
  surface?: string;
  surfaceFilter?: string;
};

const DEFAULT_MODAL_SQUIRCLE_BORDER = "rgba(11, 6, 121, 0.65)";
const DEFAULT_MODAL_SQUIRCLE_RADIUS = 28;
const DEFAULT_MODAL_SQUIRCLE_SHADOW = "0 24px 38px rgba(7, 27, 27, 0.24)";
const DEFAULT_MODAL_SQUIRCLE_SURFACE = "rgba(245, 251, 255, 0.94)";
const DEFAULT_MODAL_SQUIRCLE_SURFACE_FILTER = "blur(16px) saturate(1.45)";

const setForwardedRef = (ref: React.ForwardedRef<unknown>, value: HTMLElement | null) => {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
};

type SquircleDimensions = {
  height: number;
  width: number;
};

type SquircleContentClip = SquircleDimensions & {
  cornerRadius: number;
};

const ModalSquircle = React.forwardRef<unknown, ModalSquircleProps>(
  (
    {
      as,
      borderColor = DEFAULT_MODAL_SQUIRCLE_BORDER,
      borderWidth = 2,
      children,
      className,
      cornerRadius = DEFAULT_MODAL_SQUIRCLE_RADIUS,
      cornerSmoothing = 0.8,
      shadow = DEFAULT_MODAL_SQUIRCLE_SHADOW,
      style,
      surface = DEFAULT_MODAL_SQUIRCLE_SURFACE,
      surfaceFilter = DEFAULT_MODAL_SQUIRCLE_SURFACE_FILTER,
      ...props
    },
    ref,
  ) => {
    const elementRef = React.useRef<HTMLElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const [dimensions, setDimensions] = React.useState<SquircleDimensions | null>(null);
    const [contentClip, setContentClip] = React.useState<SquircleContentClip | null>(null);
    const Component = as ?? "div";
    const setElementRef = React.useCallback(
      (element: HTMLElement | null) => {
        elementRef.current = element;
        setForwardedRef(ref, element);
      },
      [ref],
    );

    React.useLayoutEffect(() => {
      const element = elementRef.current;
      if (!element || typeof ResizeObserver === "undefined") {
        return undefined;
      }

      const updateDimensions = () => {
        const next = {
          height: element.clientHeight,
          width: element.clientWidth,
        };
        setDimensions((previous) =>
          previous?.height === next.height && previous.width === next.width ? previous : next,
        );

        const contentElement = contentRef.current;
        if (!contentElement) {
          setContentClip(null);
          return;
        }

        const elementRect = element.getBoundingClientRect();
        const contentRect = contentElement.getBoundingClientRect();
        const contentInset = Math.max(
          0,
          Math.min(
            contentRect.left - elementRect.left,
            contentRect.top - elementRect.top,
            elementRect.right - contentRect.right,
            elementRect.bottom - contentRect.bottom,
          ),
        );
        const nextContentClip = {
          cornerRadius: Math.max(0, cornerRadius - contentInset),
          height: contentElement.clientHeight,
          width: contentElement.clientWidth,
        };
        setContentClip((previous) =>
          previous?.height === nextContentClip.height &&
          previous.width === nextContentClip.width &&
          previous.cornerRadius === nextContentClip.cornerRadius
            ? previous
            : nextContentClip,
        );
      };

      const resizeObserver = new ResizeObserver(updateDimensions);
      resizeObserver.observe(element);
      if (contentRef.current) {
        resizeObserver.observe(contentRef.current);
      }
      updateDimensions();
      const frameId = window.requestAnimationFrame(updateDimensions);
      const timeoutId = window.setTimeout(updateDimensions, 180);

      return () => {
        window.cancelAnimationFrame(frameId);
        window.clearTimeout(timeoutId);
        resizeObserver.disconnect();
      };
    }, [cornerRadius]);

    const pathWidth = dimensions ? Math.max(0, dimensions.width - borderWidth) : 0;
    const pathHeight = dimensions ? Math.max(0, dimensions.height - borderWidth) : 0;
    const squirclePath =
      pathWidth > 0 && pathHeight > 0
        ? getSvgPath({
            cornerRadius: Math.max(0, cornerRadius - borderWidth / 2),
            cornerSmoothing,
            height: pathHeight,
            preserveSmoothing: true,
            width: pathWidth,
          })
        : "";
    const contentCornerRadius = contentClip
      ? Math.min(
          contentClip.cornerRadius,
          Math.floor(Math.min(contentClip.width, contentClip.height) / 2),
        )
      : 0;
    const contentSquirclePath =
      contentClip && contentClip.width > 0 && contentClip.height > 0 && contentCornerRadius > 0
        ? getSvgPath({
            cornerRadius: contentCornerRadius,
            cornerSmoothing,
            height: contentClip.height,
            preserveSmoothing: true,
            width: contentClip.width,
          })
        : "";
    const contentClipPath = contentSquirclePath ? `path("${contentSquirclePath}")` : undefined;

    return (
      <Component
        ref={setElementRef}
        className={cn("modal-squircle", className)}
        style={{
          ...style,
          "--modal-squircle-border": borderColor,
          "--modal-squircle-border-width": `${borderWidth}px`,
          "--modal-squircle-shadow": shadow,
          "--modal-squircle-surface": surface,
          "--modal-squircle-surface-filter": surfaceFilter,
          background: "transparent",
          backgroundColor: "transparent",
          border: 0,
          borderRadius: 0,
          borderWidth: 0,
          boxShadow: "none",
          filter: "none",
        } as React.CSSProperties}
        {...props}
      >
        {dimensions && squirclePath ? (
          <svg
            aria-hidden="true"
            className="modal-squircle-shape"
            focusable="false"
            height={dimensions.height}
            preserveAspectRatio="none"
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            width={dimensions.width}
          >
            <path
              d={squirclePath}
              fill={surface}
              stroke={borderColor}
              strokeWidth={borderWidth}
              transform={`translate(${borderWidth / 2} ${borderWidth / 2})`}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : null}
        <div
          ref={contentRef}
          className="modal-squircle-content"
          style={
            contentClipPath
              ? ({
                  "--modal-squircle-content-clip-path": contentClipPath,
                  WebkitClipPath: contentClipPath,
                  clipPath: contentClipPath,
                } as React.CSSProperties)
              : undefined
          }
        >
          {children}
        </div>
      </Component>
    );
  },
);
ModalSquircle.displayName = "ModalSquircle";

export { ModalSquircle };
