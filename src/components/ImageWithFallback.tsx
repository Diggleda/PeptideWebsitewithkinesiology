import React, { useEffect, useState } from 'react'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

export function ImageWithFallback(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [didError, setDidError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
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
  const effectiveSrc = normalizedSrc ? normalizedSrc : PLACEHOLDER;
  const isPlaceholder = effectiveSrc === PLACEHOLDER;

  useEffect(() => {
    setDidError(false);
    setIsLoaded(isPlaceholder);
  }, [effectiveSrc, isPlaceholder]);

  const handleError = () => {
    setDidError(true);
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
    <div className="relative block h-full w-full overflow-hidden" style={style}>
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
        } ${className ?? ''}`}
        {...rest}
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}
