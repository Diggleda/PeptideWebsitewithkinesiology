import { useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
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

  // Calculate current price based on quantity and bulk pricing tiers
  const calculatePrice = () => {
    if (!product.bulkPricingTiers || product.bulkPricingTiers.length === 0) {
      return selectedVariation.basePrice;
    }
    
    const applicableTier = [...product.bulkPricingTiers]
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
  const getNextTier = () => {
    if (!product.bulkPricingTiers || product.bulkPricingTiers.length === 0) {
      return null;
    }
    const nextTier = product.bulkPricingTiers.find(
      tier => tier.minQuantity > quantity
    );
    return nextTier;
  };

  const nextTier = getNextTier();

  const handleQuantityChange = (delta: number) => {
    const newQuantity = Math.max(1, quantity + delta);
    setQuantity(newQuantity);
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
            <Badge variant="outline" className="text-xs squircle-sm">{product.category}</Badge>
            <h3 className="line-clamp-2 group-hover:text-blue-600 transition-colors">
              {product.name}
            </h3>
            <p className="text-xs text-gray-500">{product.manufacturer}</p>
          </div>

          {/* Variation Selector */}
          {product.variations && product.variations.length > 1 && (
            <div className="space-y-1">
              <label className="text-xs text-gray-600">Strength</label>
              <Select 
                value={selectedVariation.id} 
                onValueChange={handleVariationChange}
              >
                <SelectTrigger className="squircle-sm">
                  <SelectValue />
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
                {quantity}
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
          {product.bulkPricingTiers && product.bulkPricingTiers.length > 0 && (
            <div className="glass-card squircle-sm p-2 space-y-1">
              <p className="text-xs text-gray-700">Bulk Pricing:</p>
              <div className="space-y-0.5">
                {product.bulkPricingTiers.map((tier, index) => (
                  <div 
                    key={index}
                    className={`text-xs flex justify-between ${
                      quantity >= tier.minQuantity 
                        ? 'text-green-600 font-medium' 
                        : 'text-gray-600'
                    }`}
                  >
                    <span>Buy {tier.minQuantity}+</span>
                    <span>Save {tier.discountPercentage}%</span>
                  </div>
                ))}
              </div>
              {nextTier && (
                <p className="text-xs text-blue-600 mt-1">
                  Buy {nextTier.minQuantity - quantity} more to save {nextTier.discountPercentage}%
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
      
      <CardFooter className="p-4 pt-0">
        <Button 
          onClick={() => onAddToCart(product.id, selectedVariation.id, quantity)}
          disabled={!product.inStock}
          className="w-full bg-primary hover:bg-primary/90 squircle-sm"
        >
          <ShoppingCart className="w-4 h-4 mr-2" />
          {product.inStock ? 'Add to Cart' : 'Out of Stock'}
        </Button>
      </CardFooter>
    </Card>
  );
}
