import { useMemo, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
import { Input } from './ui/input';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { ShoppingCart, Minus, Plus } from 'lucide-react';

export interface ProductVariation {
  id: string;
  strength: string; // e.g., "10mg", "20mg", "50mg"
  basePrice: number;
}

export interface BulkPricingTier {
  minQuantity: number;
  discountPercentage: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  image: string;
  inStock: boolean;
  manufacturer: string;
  variations: ProductVariation[];
  bulkPricingTiers: BulkPricingTier[];
}

interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: string, variationId: string, quantity: number) => void;
  layout?: 'grid' | 'list';
}

export function ProductCard({ product, onAddToCart, layout = 'grid' }: ProductCardProps) {
  const [selectedVariation, setSelectedVariation] = useState<ProductVariation>(
    product.variations?.[0] || { id: 'default', strength: 'Standard', basePrice: 0 },
  );
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState('1');
  const [bulkOpen, setBulkOpen] = useState(false);

  const bulkTiers = product.bulkPricingTiers ?? [];
  const isListLayout = layout === 'list';

  const calculatePrice = () => {
    if (bulkTiers.length === 0) {
      return selectedVariation.basePrice;
    }
    const applicableTier = [...bulkTiers]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find((tier) => quantity >= tier.minQuantity);
    if (applicableTier) {
      const discount = applicableTier.discountPercentage / 100;
      return selectedVariation.basePrice * (1 - discount);
    }
    return selectedVariation.basePrice;
  };

  const currentUnitPrice = calculatePrice();
  const totalPrice = currentUnitPrice * quantity;
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

  const handleVariationChange = (variationId: string) => {
    const variation = product.variations?.find((v) => v.id === variationId);
    if (variation) {
      setSelectedVariation(variation);
    }
  };

  const quantityButtonClasses = `h-8 w-8 squircle-sm ${isListLayout ? 'bg-slate-50 border-2' : ''}`;

  const productMeta = (
    <>
      <Badge
        variant="outline"
        className="text-xs squircle-sm block max-w-full whitespace-normal break-words leading-snug"
      >
        {product.category}
      </Badge>
      <h3 className="line-clamp-2 text-slate-900">{product.name}</h3>
      {product.manufacturer && <p className="text-xs text-gray-500">{product.manufacturer}</p>}
    </>
  );

  const variationSelector =
    product.variations && product.variations.length > 0 ? (
      <div className={isListLayout ? 'space-y-2 min-w-0' : 'space-y-1'}>
        <label className="text-xs text-gray-600">Strength</label>
        <Select value={selectedVariation.id} onValueChange={handleVariationChange}>
          <SelectTrigger className="squircle-sm border border-[var(--brand-glass-border-2)] bg-white/95 shadow-inner focus:ring-[rgb(95,179,249)] focus:ring-2 transition-all">
            <SelectValue placeholder="Select strength" />
          </SelectTrigger>
          <SelectContent className="rounded-2xl border border-[var(--brand-glass-border-2)] bg-white/95 shadow-xl">
            {product.variations.map((variation) => (
              <SelectItem
                key={variation.id}
                value={variation.id}
                className="rounded-xl px-3 py-2 text-sm focus:bg-[rgba(95,179,249,0.08)] focus:text-[rgb(95,179,249)] data-[state=checked]:text-[rgb(95,179,249)]"
              >
                {variation.strength}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  const quantitySelector = (
    <div className={isListLayout ? 'space-y-2 min-w-0' : 'space-y-1'}>
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
        <div className={`flex-1 text-center px-3 py-1 glass-card squircle-sm ${isListLayout ? 'bg-white/80' : ''}`}>
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

  const listBulkSection = bulkContent ? (
    <div className="inline-flex w-full max-w-xl flex-col gap-2 rounded-[28px] border border-[var(--brand-glass-border-2)] bg-white/95 px-5 py-3 shadow-[0_18px_40px_-32px_rgba(95,179,249,0.75)]">
      {bulkContent}
    </div>
  ) : null;

  const addToCartButton = (
    <Button
      onClick={() => {
        onAddToCart(product.id, selectedVariation.id, quantity);
        setQuantity(1);
        setQuantityInput('1');
        setBulkOpen(false);
      }}
      disabled={!product.inStock}
      className={`squircle-sm glass-brand btn-hover-lighter ${isListLayout ? 'w-full md:w-auto' : 'w-full'}`}
    >
      <ShoppingCart className="w-4 h-4 mr-2" />
      {product.inStock ? 'Add to Cart' : 'Out of Stock'}
    </Button>
  );

  if (isListLayout) {
    const variationCount = product.variations?.length ?? 0;
    const variationSummary =
      variationCount > 0
        ? `${variationCount} option${variationCount === 1 ? '' : 's'} available`
        : product.manufacturer || 'Single option';
    return (
      <Card className="glass squircle-sm overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col gap-6 px-5 py-6 lg:flex-row lg:items-center lg:gap-8">
            <div className="flex w-full max-w-full flex-shrink-0 items-center justify-center rounded-2xl bg-white/85 p-4 shadow-inner lg:w-64">
              <div className="relative w-full max-w-[220px]">
                <ImageWithFallback
                  src={product.image}
                  alt={product.name}
                  className="w-full object-contain drop-shadow-xl"
                />
                {!product.inStock && (
                  <div className="absolute inset-0 bg-gray-900/40 flex items-center justify-center rounded-2xl">
                    <Badge variant="destructive" className="squircle-sm">
                      Out of Stock
                    </Badge>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-4 min-w-0">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold text-slate-900">{product.name}</h3>
                <p className="text-sm text-slate-500">{variationSummary}</p>
                {selectedVariation && (
                  <p className="text-xs text-slate-500">
                    Variant:&nbsp;
                    <span className="font-medium text-slate-700">{selectedVariation.strength}</span>
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4 rounded-full border border-[var(--brand-glass-border-2)] bg-white/90 px-4 py-2 shadow-[0_20px_45px_-35px_rgba(95,179,249,0.65)]">
                <span className="text-xl font-semibold text-green-600">${currentUnitPrice.toFixed(2)}</span>
                <div className="flex items-center gap-1 rounded-full bg-white px-3 py-1 shadow-inner">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full hover:bg-slate-100"
                    onClick={() => handleQuantityChange(-1)}
                    disabled={quantity <= 1}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
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
                    className="h-8 w-12 border-none bg-transparent text-center text-base font-semibold focus-visible:ring-0 focus-visible:outline-none"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full hover:bg-slate-100"
                    onClick={() => handleQuantityChange(1)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {variationSelector && <div className="max-w-sm">{variationSelector}</div>}
              {listBulkSection}
            </div>

            <div className="flex w-full flex-col items-end gap-3 lg:w-auto">
              <div className="w-full rounded-2xl border border-[var(--brand-glass-border-2)] bg-white/90 px-5 py-3 text-right shadow-[0_25px_55px_-35px_rgba(95,179,249,0.7)]">
                <span className="text-xs text-gray-500 uppercase tracking-wide">Line Total</span>
                <p className="text-2xl font-bold text-slate-900">${totalPrice.toFixed(2)}</p>
              </div>
              <div className="w-full lg:w-auto">{addToCartButton}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="group overflow-hidden glass-card squircle-lg shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1">
      <CardContent className="p-0">
        <div className="relative aspect-square overflow-hidden">
          <ImageWithFallback
            src={product.image}
            alt={product.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
          {!product.inStock && (
            <div className="absolute inset-0 bg-gray-900/50 flex items-center justify-center">
              <Badge variant="destructive" className="squircle-sm">
                Out of Stock
              </Badge>
            </div>
          )}
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-1">{productMeta}</div>
          {variationSelector}
          {quantitySelector}
          {pricingSummary}
          {gridBulkSection}
        </div>
      </CardContent>
      <CardFooter className="p-4 pt-0">{addToCartButton}</CardFooter>
    </Card>
  );
}
