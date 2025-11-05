import {
  useEffect,
  useMemo,
  useState,
  type TouchEvent,
  type ReactNode,
  type HTMLAttributes,
} from 'react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ImageWithFallback } from './ImageWithFallback';

interface ProductImageCarouselProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  images: string[];
  alt: string;
  imageClassName?: string;
  showDots?: boolean;
  showArrows?: boolean;
  children?: ReactNode;
}

const SWIPE_THRESHOLD = 50;

export function ProductImageCarousel({
  images,
  alt,
  className,
  imageClassName,
  showDots = true,
  showArrows = false,
  children,
  onClick,
  ...rest
}: ProductImageCarouselProps) {
  const normalizedImages = useMemo(
    () => (images && images.length > 0 ? images : ['']),
    [images],
  );

  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [touchEndX, setTouchEndX] = useState<number | null>(null);

  useEffect(() => {
    setCurrentImageIndex(0);
  }, [normalizedImages]);

  useEffect(() => {
    setCurrentImageIndex((index) => {
      const lastIndex = normalizedImages.length > 0 ? normalizedImages.length - 1 : 0;
      return Math.min(index, lastIndex);
    });
  }, [normalizedImages.length]);

  const goToNextImage = () => {
    setCurrentImageIndex((prev) => (prev < normalizedImages.length - 1 ? prev + 1 : prev));
  };

  const goToPreviousImage = () => {
    setCurrentImageIndex((prev) => (prev > 0 ? prev - 1 : prev));
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    setTouchStartX(event.targetTouches[0].clientX);
    setTouchEndX(null);
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    setTouchEndX(event.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (touchStartX !== null && touchEndX !== null) {
      const delta = touchStartX - touchEndX;
      if (delta > SWIPE_THRESHOLD && currentImageIndex < normalizedImages.length - 1) {
        goToNextImage();
      }
      if (delta < -SWIPE_THRESHOLD && currentImageIndex > 0) {
        goToPreviousImage();
      }
    }
    setTouchStartX(null);
    setTouchEndX(null);
  };

  const hasControls = normalizedImages.length > 1;
  const hasPreviousImage = currentImageIndex > 0;
  const hasNextImage = currentImageIndex < normalizedImages.length - 1;

  return (
    <div
      className={clsx('relative overflow-hidden', className)}
      onClick={onClick}
      {...rest}
    >
      <div
        className="relative h-full w-full"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="flex h-full w-full transition-transform duration-300 ease-out"
          style={{ transform: `translateX(-${currentImageIndex * 100}%)` }}
        >
          {normalizedImages.map((imageSource, index) => (
            <div
              key={`${imageSource}-${index}`}
              className="product-image-frame flex h-full w-full flex-shrink-0 items-center justify-center bg-transparent"
            >
              <ImageWithFallback
                src={imageSource}
                alt={`${alt} - ${index + 1}`}
                className={clsx('product-image-frame__img', imageClassName)}
              />
            </div>
          ))}
        </div>

        {children}

        {hasControls && showArrows && hasPreviousImage && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              goToPreviousImage();
            }}
            aria-label="Previous image"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 text-[rgb(95,179,249)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {hasControls && showArrows && hasNextImage && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              goToNextImage();
            }}
            aria-label="Next image"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 text-[rgb(95,179,249)]"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>

      {hasControls && showDots && (
        <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5">
          {normalizedImages.map((_image, index) => (
            <button
              key={`dot-${index}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setCurrentImageIndex(index);
              }}
              className={clsx(
                'transition-all rounded-full',
                index === currentImageIndex
                  ? 'h-2 w-6 bg-white'
                  : 'h-2 w-2 bg-white/50 hover:bg-white/75',
              )}
              aria-label={`View image ${index + 1}`}
              aria-pressed={index === currentImageIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
}
