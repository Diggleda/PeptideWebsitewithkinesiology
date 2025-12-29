import React, { useEffect, useMemo, useRef, useState } from 'react'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

const toOptionalNumber = (value: string | undefined) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const IMAGE_RETRY_MAX_ATTEMPTS =
  toOptionalNumber(import.meta.env.VITE_IMAGE_RETRY_MAX_ATTEMPTS) ?? null;
const IMAGE_RETRY_MAX_MS =
  toOptionalNumber(import.meta.env.VITE_IMAGE_RETRY_MAX_MS) ?? null;

export function ImageWithFallback(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [didError, setDidError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const retryTimerRef = useRef<number | null>(null);
  const firstSeenAtRef = useRef<number>(Date.now());
  const {
    alt,
    style,
    className,
    loading = 'lazy',
    decoding = 'async',
    referrerPolicy = 'no-referrer',
    crossOrigin,
    src,
    ...rest
  } = props

  const PLACEHOLDER = '/Peppro_IconLogo_Transparent_NoBuffer.png';
  const normalizedSrc = typeof src === 'string' ? src.trim() : '';
  const baseSrc = normalizedSrc ? normalizedSrc : PLACEHOLDER;
  const effectiveSrc = displaySrc ?? baseSrc;
  const isPlaceholder = effectiveSrc === PLACEHOLDER;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    firstSeenAtRef.current = Date.now();
    setRetryAttempt(0);
    setDidError(false);
    setIsLoaded(baseSrc === PLACEHOLDER);
    setDisplaySrc(baseSrc);
  }, [baseSrc]);

  const canRetry = useMemo(() => {
    if (!baseSrc || baseSrc === PLACEHOLDER) {
      return false;
    }
    if (IMAGE_RETRY_MAX_ATTEMPTS !== null && retryAttempt >= IMAGE_RETRY_MAX_ATTEMPTS) {
      return false;
    }
    if (IMAGE_RETRY_MAX_MS !== null) {
      const elapsedMs = Date.now() - firstSeenAtRef.current;
      return elapsedMs < IMAGE_RETRY_MAX_MS;
    }
    return true;
  }, [baseSrc, retryAttempt]);

  const buildRetryUrl = useMemo(() => {
    if (!baseSrc || baseSrc === PLACEHOLDER) {
      return null;
    }
    let candidate = baseSrc;
    // Best-effort fix for spaces in Woo media URLs.
    if (/^https?:\/\//i.test(candidate) && /\s/.test(candidate)) {
      try {
        candidate = encodeURI(candidate);
      } catch {
        // ignore
      }
    }
    const sep = candidate.includes('?') ? '&' : '?';
    return `${candidate}${sep}_imgRetry=${Date.now()}_${retryAttempt + 1}`;
  }, [baseSrc, retryAttempt]);

  const handleError = () => {
    if (isPlaceholder) {
      setDidError(true);
      setIsLoaded(true);
      return;
    }
    if (canRetry && buildRetryUrl) {
      const attempt = retryAttempt + 1;
      const delayMs = Math.min(60000, 800 * Math.pow(1.7, attempt - 1));
      setRetryAttempt(attempt);
      setDidError(false);
      // Show placeholder while we wait, then try again with a cache-busted URL.
      setDisplaySrc(PLACEHOLDER);
      setIsLoaded(true);
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (!mountedRef.current) {
          return;
        }
        setDisplaySrc(buildRetryUrl);
        setIsLoaded(false);
      }, delayMs);
      return;
    }
    // Keep placeholder instead of a permanent error state so we can still recover
    // if the CDN/origin becomes available later.
    setDisplaySrc(PLACEHOLDER);
    setIsLoaded(true);
  };

  const handleLoad = () => {
    setIsLoaded(true);
  };

  if (didError) {
    return (
      <div
        className={`flex h-full w-full items-center justify-center bg-gray-100 text-center align-middle ${className ?? ''}`}
        style={style}
      >
        <img
          src={ERROR_IMG_SRC}
          alt={alt || 'Image'}
          className="block max-h-full max-w-full object-contain"
          loading={loading}
          decoding={decoding}
          referrerPolicy={referrerPolicy}
          crossOrigin={crossOrigin}
          {...rest}
          onLoad={handleLoad}
        />
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden" style={style}>
      {!isLoaded && !didError && !isPlaceholder && (
        <div className="image-skeleton" aria-hidden="true" />
      )}
      <img
        src={effectiveSrc}
        alt={alt}
        loading={loading}
        decoding={decoding}
        referrerPolicy={referrerPolicy}
        crossOrigin={crossOrigin}
        className={`block object-contain transition-opacity duration-300 ${
          isPlaceholder || isLoaded ? 'opacity-100' : 'opacity-0'
        } ${isPlaceholder ? 'peppro-placeholder-img' : ''} ${className ?? ''}`}
        {...rest}
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}
