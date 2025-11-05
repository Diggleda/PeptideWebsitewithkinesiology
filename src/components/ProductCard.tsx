import type { CSSProperties, KeyboardEvent } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
import { ShoppingCart, Star, Info } from 'lucide-react';
import { ProductImageCarousel } from './ProductImageCarousel';

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  originalPrice?: number;
  rating: number;
  reviews: number;
  image: string;
  images: string[];
  inStock: boolean;
  prescription: boolean;
  dosage: string;
  manufacturer: string;
  type?: string;
  description?: string;
}

interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: string) => void;
  onViewDetails: (product: Product) => void;
  viewMode: 'grid' | 'list';
}

export function ProductCard({ product, onAddToCart, onViewDetails, viewMode }: ProductCardProps) {
  const isList = viewMode === 'list';
  const discount = product.originalPrice 
    ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
    : 0;
  const imageWrapperBase = 'flex h-full w-full items-center justify-center bg-white/85';
  const imageClasses = 'h-full w-full object-contain transition-transform duration-300';
  const hasMultipleImages = (product.images?.length ?? 0) > 1;

  const triggerDetails = () => {
    console.debug('[ProductCard] Details requested', { productId: product.id, viewMode });
    onViewDetails(product);
  };

  const triggerAddToCart = () => {
    console.debug('[ProductCard] Add to cart button clicked', { productId: product.id, inStock: product.inStock });
    onAddToCart(product.id);
  };

  const handleCarouselKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      triggerDetails();
    }
  };

  const ratingStars = (
    <div className="flex items-center">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star 
          key={i} 
          className={`w-3 h-3 ${
            i < Math.floor(product.rating) 
              ? 'fill-yellow-400 text-yellow-400' 
              : 'text-gray-300'
          }`} 
        />
      ))}
    </div>
  );

  const ratingSummary = (
    <div className="flex items-center gap-1 text-sm text-gray-600">
      {ratingStars}
      <span>({product.reviews})</span>
    </div>
  );

  const priceDisplay = (
    <div className="flex items-center gap-2">
      {product.price > 0 ? (
        <span className="text-lg font-semibold text-green-600">${product.price.toFixed(2)}</span>
      ) : (
        <span className="text-sm font-medium text-[rgb(95,179,249)]">Request Pricing</span>
      )}
      {product.price > 0 && product.originalPrice && (
        <span className="text-sm text-gray-500 line-through">${product.originalPrice.toFixed(2)}</span>
      )}
    </div>
  );

  if (isList) {
    return (
      <Card className="group w-full max-w-full overflow-hidden glass-card squircle-lg shadow-md hover:shadow-lg transition-all duration-300">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-5">
          <div
            className="relative flex-shrink-0"
            style={{ flexBasis: '26%', maxWidth: '26%', minWidth: '160px' }}
          >
            <div
              className="relative aspect-square w-full overflow-hidden rounded-3xl border border-white/40 shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 btn-hover-lighter"
              tabIndex={0}
              role="button"
              aria-label={`View details for ${product.name}`}
              onClick={triggerDetails}
              onKeyDown={handleCarouselKeyDown}
            >
              <ProductImageCarousel
                images={product.images.length > 0 ? product.images : [product.image]}
                alt={product.name}
                className={`${imageWrapperBase} h-full`}
                imageClassName={imageClasses}
                style={{ '--product-image-frame-padding': 'clamp(0.35rem, 0.9vw, 0.8rem)' } as CSSProperties}
                showDots={hasMultipleImages}
                showArrows={hasMultipleImages}
              />
            </div>
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs squircle-sm">{product.category}</Badge>
                {/* Removed Rx badge per request */}
                {discount > 0 && (
                  <Badge className="squircle-sm bg-red-500 hover:bg-red-600 text-white">
                    -{discount}%
                  </Badge>
                )}
                {!product.inStock && (
                  <Badge variant="destructive" className="squircle-sm">
                    Out of Stock
                  </Badge>
                )}
              </div>
              {priceDisplay}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <h3 className="text-lg font-semibold leading-tight">
                {product.name}
              </h3>
              {ratingSummary}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
              <span>{product.dosage}</span>
              <span>{product.manufacturer}</span>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 pt-1 max-w-full">
              <Button
                variant="outline"
                onClick={triggerDetails}
                className="glass squircle-sm flex-1 sm:flex-initial sm:min-w-[100px] btn-hover-lighter"
              >
                <Info className="w-4 h-4 mr-2" />
                Details
              </Button>
              <Button
                variant="outline"
                onClick={triggerAddToCart}
                disabled={!product.inStock}
                className="flex-1 sm:flex-initial sm:min-w-[120px] glass-brand squircle-sm btn-hover-lighter"
              >
                <ShoppingCart className="w-4 h-4 mr-2" />
                {product.inStock ? 'Add to Cart' : 'Out of Stock'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
      <Card className="group w-full flex h-full flex-col overflow-hidden glass-card squircle-lg shadow-md hover:shadow-lg transition-all duration-300 hover:-translate-y-0.5">
        <CardContent className="flex-1 p-0">
        <div
          className="relative aspect-square overflow-hidden cursor-pointer"
          tabIndex={0}
          role="button"
          aria-label={`View details for ${product.name}`}
          onClick={triggerDetails}
          onKeyDown={handleCarouselKeyDown}
        >
          <ProductImageCarousel
            images={product.images.length > 0 ? product.images : [product.image]}
            alt={product.name}
            className={`${imageWrapperBase} h-full`}
            imageClassName={imageClasses}
            style={{ '--product-image-frame-padding': 'clamp(0.45rem, 1vw, 0.95rem)' } as CSSProperties}
            showDots={hasMultipleImages}
            showArrows={hasMultipleImages}
          >
            {discount > 0 && (
              <Badge className="absolute top-2 left-2 bg-red-500 hover:bg-red-600 squircle-sm">
                  -{discount}%
                </Badge>
              )}
              {/* Removed Rx badge per request */}
              {!product.inStock && (
                <div className="absolute inset-0 bg-gray-900/50 flex items-center justify-center">
                  <Badge variant="destructive">Out of Stock</Badge>
                </div>
              )}
            </ProductImageCarousel>
          </div>
        <div className="flex h-full flex-col p-4">
          <div className="space-y-1">
            <Badge variant="outline" className="text-xs squircle-sm">{product.category}</Badge>
            <h3 className="line-clamp-2 transition-colors">
              {product.name}
            </h3>
            <p className="text-sm text-gray-600">{product.dosage}</p>
            <p className="text-xs text-gray-500">{product.manufacturer}</p>
          </div>

          {ratingSummary}

          <div className="mt-auto flex items-center justify-between">
            {priceDisplay}
          </div>
        </div>
      </CardContent>
      
      <CardFooter className="mt-auto w-full p-4 pt-0">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 w-full">
          <Button
            variant="outline"
            onClick={triggerDetails}
            className="glass squircle-sm btn-hover-lighter"
          >
            <Info className="w-4 h-4 mr-2" />
            Details
          </Button>
          <Button
            variant="outline"
            onClick={triggerAddToCart}
            disabled={!product.inStock}
            className="w-full glass-brand squircle-sm transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
          >
            <ShoppingCart className="w-4 h-4 mr-2" />
            {product.inStock ? 'Add' : 'Out of Stock'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
