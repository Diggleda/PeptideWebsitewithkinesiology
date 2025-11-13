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
}

export function ProductCard({ product, onAddToCart }: ProductCardProps) {
  const [selectedVariation, setSelectedVariation] = useState<ProductVariation>(
    product.variations?.[0] || { id: 'default', strength: 'Standard', basePrice: 0 }
  );
  const [quantity, setQuantity] = useState(1);
  const [bulkOpen, setBulkOpen] = useState(false);

  const bulkTiers = product.bulkPricingTiers ?? [];

  // Calculate current price based on quantity and bulk pricing tiers
  const calculatePrice = () => {
    if (bulkTiers.length === 0) {
      return selectedVariation.basePrice;
    }

    const applicableTier = [...bulkTiers]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find(tier => quantity >= tier.minQuantity);
    
    if (applicableTier) {
      const discount = applicableTier.discountPercentage / 100;
      return selectedVariation.basePrice * (1 - discount);
    }
    
    return selectedVariation.basePrice;
  };

  const currentUnitPrice = calculatePrice();
  const totalPrice = currentUnitPrice * quantity;

  // Get the next bulk pricing tier
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
    setBulkOpen(true);
  };

  const handleVariationChange = (variationId: string) => {
    const variation = product.variations?.find(v => v.id === variationId);
    if (variation) {
      setSelectedVariation(variation);
    }
  };

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
              <Badge variant="destructive" className="squircle-sm">Out of Stock</Badge>
            </div>
          )}
        </div>
        
        <div className="p-4 space-y-3">
          <div className="space-y-1">
            <Badge variant="outline" className="text-xs squircle-sm max-w-full truncate">{product.category}</Badge>
            <h3 className="line-clamp-2 group-hover:text-blue-600 transition-colors">
              {product.name}
            </h3>
            <p className="text-xs text-gray-500">{product.manufacturer}</p>
          </div>

          {/* Variation Selector */}
          {product.variations && product.variations.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs text-gray-600">Strength</label>
              <Select 
                value={selectedVariation.id} 
                onValueChange={handleVariationChange}
                >
                  <SelectTrigger className="squircle-sm border border-[var(--brand-glass-border-2)] bg-white/95 shadow-inner focus:ring-[rgb(95,179,249)]">
                    <SelectValue placeholder="Select strength" />
                  </SelectTrigger>
                  <SelectContent>
                    {product.variations.map((variation) => (
                    <SelectItem key={variation.id} value={variation.id}>
                      {variation.strength}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Quantity Selector */}
          <div className="space-y-1">
            <label className="text-xs text-gray-600">Quantity</label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 squircle-sm"
                onClick={() => handleQuantityChange(-1)}
                disabled={quantity <= 1}
              >
                <Minus className="h-3 w-3" />
              </Button>
              <div className="flex-1 text-center px-3 py-1 glass-card squircle-sm">
                <Input
                  type="number"
                  min={1}
                  value={quantity}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setQuantity(Number.isNaN(next) ? 1 : Math.max(1, next));
                  setBulkOpen(true);
                }}
                  className="h-auto border-none bg-transparent text-center text-base font-semibold focus-visible:ring-0 focus-visible:outline-none"
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 squircle-sm"
                onClick={() => handleQuantityChange(1)}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {/* Pricing Display */}
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-gray-600">Unit Price:</span>
              <span className="font-bold text-green-600">${currentUnitPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-gray-600">Total:</span>
              <span className="text-lg font-bold text-green-700">${totalPrice.toFixed(2)}</span>
            </div>
          </div>

          {/* Bulk Pricing Info */}
          {bulkTiers.length > 0 && (
            <div className="glass-card squircle-sm border border-[var(--brand-glass-border-2)] p-3 space-y-2">
              <button
                type="button"
                onClick={() => setBulkOpen((prev) => !prev)}
                className="flex w-full items-center justify-between text-xs font-semibold text-slate-700 focus-visible:outline-none"
              >
                <span className="tracking-wide uppercase text-[0.65rem]">Bulk Pricing</span>
                <span className="text-[rgb(95,179,249)] text-[0.65rem] font-medium">
                  {bulkOpen ? 'Hide' : 'Show'}
                </span>
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
                        <span className={quantity >= tier.minQuantity ? 'text-green-600 font-semibold tabular-nums' : 'text-slate-600 tabular-nums'}>
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
            </div>
          )}
        </div>
      </CardContent>
      
      <CardFooter className="p-4 pt-0">
        <Button 
          onClick={() => {
            onAddToCart(product.id, selectedVariation.id, quantity);
            setQuantity(1);
            setBulkOpen(false);
          }}
          disabled={!product.inStock}
          className="w-full squircle-sm glass-brand btn-hover-lighter"
        >
          <ShoppingCart className="w-4 h-4 mr-2" />
          {product.inStock ? 'Add to Cart' : 'Out of Stock'}
        </Button>
      </CardFooter>
    </Card>
  );
}
