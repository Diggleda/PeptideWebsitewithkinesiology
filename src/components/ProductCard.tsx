import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Minus, Plus, ShoppingCart, Info } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
import { ImageWithFallback } from './ImageWithFallback';

export interface ProductVariantAttribute {
  name: string;
  value: string;
}

export interface ProductVariant {
  id: string;
  label: string;
  price: number;
  originalPrice?: number;
  sku?: string;
  inStock: boolean;
  attributes: ProductVariantAttribute[];
  image?: string;
  description?: string;
}

export interface BulkPricingTier {
  minQuantity: number;
  discountPercentage: number;
}

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
  variants?: ProductVariant[];
  hasVariants?: boolean;
  defaultVariantId?: string;
  variantSummary?: string;
  bulkPricingTiers?: BulkPricingTier[];
}

interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: string, quantity?: number, note?: string, variantId?: string | null) => void;
  onViewDetails: (product: Product) => void;
  viewMode: 'grid' | 'list';
}

const formatCurrency = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function ProductCard({ product, onAddToCart, onViewDetails, viewMode }: ProductCardProps) {
  const isList = viewMode === 'list';
  const variantOptions = product.variants ?? [];
  const hasVariantOptions = variantOptions.length > 0;

  const defaultVariant = useMemo(() => {
    if (!hasVariantOptions) {
      return null;
    }
    return (
      variantOptions.find((variant) => variant.id === product.defaultVariantId) ??
      variantOptions.find((variant) => variant.inStock) ??
      variantOptions[0]
    );
  }, [hasVariantOptions, product.defaultVariantId, variantOptions]);

  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(defaultVariant?.id ?? null);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    setSelectedVariantId(defaultVariant?.id ?? null);
    setQuantity(1);
  }, [defaultVariant?.id, product.id]);

  const selectedVariant = hasVariantOptions
    ? variantOptions.find((variant) => variant.id === selectedVariantId) ?? defaultVariant ?? variantOptions[0] ?? null
    : null;

  const sortedBulkTiers = useMemo(() => {
    if (!product.bulkPricingTiers?.length) {
      return [];
    }
    return [...product.bulkPricingTiers].sort((a, b) => a.minQuantity - b.minQuantity);
  }, [product.bulkPricingTiers]);

  const activeBulkTier = sortedBulkTiers
    .filter((tier) => quantity >= tier.minQuantity)
    .slice(-1)[0];

  const nextBulkTier = sortedBulkTiers.find((tier) => tier.minQuantity > quantity);

  const baseUnitPrice = selectedVariant?.price ?? product.price ?? 0;
  const unitDiscount = activeBulkTier ? activeBulkTier.discountPercentage / 100 : 0;
  const unitPrice = baseUnitPrice * (1 - unitDiscount);
  const totalPrice = unitPrice * quantity;
  const savingsBadge =
    activeBulkTier && activeBulkTier.discountPercentage > 0
      ? `-${activeBulkTier.discountPercentage}% bulk savings`
      : null;

  const canAddToCart = product.inStock && (!hasVariantOptions || Boolean(selectedVariant?.inStock));
  const coverImage = selectedVariant?.image ?? product.image;
  const descriptionSnippet = product.description ? product.description.slice(0, 120) : '';

  const handleQuantityChange = (delta: number) => {
    setQuantity((prev) => Math.max(1, prev + delta));
  };

  const handleAddToCart = () => {
    if (!canAddToCart) {
      return;
    }
    onAddToCart(product.id, quantity, undefined, selectedVariant?.id ?? null);
  };

  const infoButton = (
    <button
      type="button"
      onClick={() => onViewDetails(product)}
      className="absolute top-3 right-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-slate-600 shadow-md transition hover:scale-105 hover:text-[rgb(95,179,249)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(95,179,249)]"
      aria-label={`View details for ${product.name}`}
    >
      <Info className="h-4 w-4" />
    </button>
  );

  const containerClass = clsx(
    'flex w-full',
    isList ? 'flex-col gap-6 lg:flex-row' : 'flex-col gap-4'
  );
  const imageWrapperClass = clsx(
    'relative overflow-hidden bg-white/85',
    isList ? 'rounded-b-none lg:rounded-tr-none lg:w-60 xl:w-72' : 'rounded-b-3xl'
  );

  return (
    <Card className="group glass-card squircle-2xl shadow-lg hover:-translate-y-1 hover:shadow-2xl transition-all duration-300 overflow-hidden">
      <CardContent className="p-0">
        <div className={containerClass}>
          <div className={clsx('relative aspect-square w-full', isList ? 'lg:w-60 xl:w-72' : '')}>
            <div className={imageWrapperClass}>
              <ImageWithFallback
                src={coverImage}
                alt={product.name}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              {!product.inStock && (
                <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-[1px] flex items-center justify-center">
                  <Badge variant="destructive" className="squircle-sm text-sm px-4 py-1.5">
                    Out of Stock
                  </Badge>
                </div>
              )}
              {infoButton}
            </div>
          </div>

          <div className={clsx('flex-1 p-5 space-y-4', isList ? 'lg:p-6' : '')}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs squircle-sm">
                {product.category}
              </Badge>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                {product.manufacturer}
              </span>
              {savingsBadge && (
                <Badge className="squircle-sm bg-green-500/90 text-white">{savingsBadge}</Badge>
              )}
            </div>

            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-slate-900 leading-tight">
                {product.name}
              </h3>
              <p className="text-sm text-slate-500 line-clamp-2">
                {product.dosage}
                {descriptionSnippet && ` • ${descriptionSnippet}`}
              </p>
            </div>

            {hasVariantOptions && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600" htmlFor={`variant-${product.id}`}>
                  Dosage / Strength
                </label>
                <div className="relative">
                  <select
                    id={`variant-${product.id}`}
                    value={selectedVariant?.id ?? ''}
                    onChange={(event) => setSelectedVariantId(event.target.value)}
                    className="w-full squircle-sm border border-[var(--brand-glass-border-2)] bg-white/85 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(95,179,249)]"
                  >
                    {variantOptions.map((variant) => (
                      <option key={variant.id} value={variant.id} disabled={!variant.inStock}>
                        {variant.label} {variant.inStock ? '' : '(Out of stock)'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Quantity</label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 squircle-sm"
                  onClick={() => handleQuantityChange(-1)}
                  disabled={quantity <= 1}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <div className="flex-1 text-center px-3 py-2 glass-card squircle-sm text-lg font-semibold">
                  {quantity}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 squircle-sm"
                  onClick={() => handleQuantityChange(1)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-baseline justify-between text-sm text-slate-600">
                <span>Unit Price</span>
                <span className="font-semibold text-slate-900">{formatCurrency(unitPrice)}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-600">Total</span>
                <span className="text-2xl font-bold text-[rgb(56,148,97)]">
                  {formatCurrency(totalPrice)}
                </span>
              </div>
            </div>

            {sortedBulkTiers.length > 0 && (
              <div className="glass-card squircle-lg p-3 space-y-2 border border-[var(--brand-glass-border-2)]">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>Bulk Pricing</span>
                  {activeBulkTier ? (
                    <span className="font-semibold text-green-600">
                      Saving {activeBulkTier.discountPercentage}% at {activeBulkTier.minQuantity}+
                    </span>
                  ) : (
                    <span>Save more when you buy in bulk</span>
                  )}
                </div>
                <div className="space-y-1">
                  {sortedBulkTiers.map((tier) => (
                    <div
                      key={`${tier.minQuantity}-${tier.discountPercentage}`}
                      className={clsx(
                        'flex items-center justify-between text-xs',
                        quantity >= tier.minQuantity ? 'text-green-600 font-medium' : 'text-slate-600'
                      )}
                    >
                      <span>Buy {tier.minQuantity}+</span>
                      <span>Save {tier.discountPercentage}%</span>
                    </div>
                  ))}
                </div>
                {nextBulkTier && (
                  <p className="text-xs text-[rgb(95,179,249)] font-medium">
                    Add {nextBulkTier.minQuantity - quantity} more to unlock {nextBulkTier.discountPercentage}% savings
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>

      <CardFooter className={clsx('flex flex-col gap-2 p-5 pt-0', isList ? 'lg:flex-row lg:items-center' : '')}>
        <Button
          type="button"
          onClick={handleAddToCart}
          disabled={!canAddToCart}
          className="w-full squircle-sm glass-brand btn-hover-lighter flex items-center justify-center gap-2"
        >
          <ShoppingCart className="w-4 h-4" />
          {canAddToCart ? 'Add to Cart' : 'Unavailable'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onViewDetails(product)}
          className="w-full squircle-sm"
        >
          View Details
        </Button>
      </CardFooter>
    </Card>
  );
}
