import React, { useEffect, useState } from 'react'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

export function ImageWithFallback(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [didError, setDidError] = useState(false)
  const {
    alt,
    style,
    className,
    loading = 'lazy',
    decoding = 'async',
    referrerPolicy = 'no-referrer',
    crossOrigin = 'anonymous',
    ...rest
  } = props

  useEffect(() => {
    setDidError(false)
  }, [props.src])

  const handleError = () => {
    setDidError(true)
  }

  const PLACEHOLDER = '/Placeholder.png'

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
        />
      </div>
    );
  }

  return (
    <img
      src={PLACEHOLDER}
      alt={alt}
      loading={loading}
      decoding={decoding}
      referrerPolicy={referrerPolicy}
      crossOrigin={crossOrigin}
      className={`block ${className ?? ''}`}
      style={style}
      {...rest}
      onError={handleError}
    />
  );
}
