import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter } from './ui/card';
import { ImageWithFallback } from './ImageWithFallback';
import { ShoppingCart, Star, Info } from 'lucide-react';

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  originalPrice?: number;
  rating: number;
  reviews: number;
  image: string;
  inStock: boolean;
  prescription: boolean;
  dosage: string;
  manufacturer: string;
  type?: string;
  description?: string;
  benefits?: string;
  protocol?: string;
}

interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: string) => void;
  onViewDetails: (product: Product) => void;
}

export function ProductCard({ product, onAddToCart, onViewDetails }: ProductCardProps) {
  const discount = product.originalPrice 
    ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
    : 0;

  return (
    <Card className="group flex h-full flex-col overflow-hidden glass-card squircle-lg shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1">
      <CardContent className="flex-1 p-0">
        <div
          className="relative aspect-square overflow-hidden cursor-pointer"
          onClick={() => onViewDetails(product)}
        >
          <ImageWithFallback
            src={product.image}
            alt={product.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
          {discount > 0 && (
            <Badge className="absolute top-2 left-2 bg-red-500 hover:bg-red-600 squircle-sm">
              -{discount}%
            </Badge>
          )}
          {product.prescription && (
            <Badge variant="secondary" className="absolute top-2 right-2 bg-orange-100 text-orange-800 squircle-sm">
              Rx
            </Badge>
          )}
          {!product.inStock && (
            <div className="absolute inset-0 bg-gray-900/50 flex items-center justify-center">
              <Badge variant="destructive">Out of Stock</Badge>
            </div>
          )}
        </div>
        <div className="flex h-full flex-col p-4">
          <div className="space-y-1">
            <Badge variant="outline" className="text-xs squircle-sm">{product.category}</Badge>
            <h3 className="line-clamp-2 group-hover:text-blue-600 transition-colors">
              {product.name}
            </h3>
            <p className="text-sm text-gray-600">{product.dosage}</p>
            <p className="text-xs text-gray-500">{product.manufacturer}</p>
          </div>

          <div className="flex items-center gap-1">
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
            <span className="text-sm text-gray-600">({product.reviews})</span>
          </div>

          <div className="mt-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              {product.price > 0 ? (
                <span className="font-bold text-green-600">${product.price.toFixed(2)}</span>
              ) : (
                <span className="text-sm font-medium text-green-600">Request Pricing</span>
              )}
              {product.price > 0 && product.originalPrice && (
                <span className="text-sm text-gray-500 line-through">${product.originalPrice.toFixed(2)}</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
      
      <CardFooter className="mt-auto w-full p-4 pt-0">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            onClick={() => onViewDetails(product)}
            className="glass squircle-sm"
          >
            <Info className="w-4 h-4 mr-2" />
            Details
          </Button>
          <Button 
            onClick={() => onAddToCart(product.id)}
            disabled={!product.inStock}
            className="w-full bg-primary hover:bg-primary/90 squircle-sm"
          >
            <ShoppingCart className="w-4 h-4 mr-2" />
            {product.inStock ? 'Add to Cart' : 'Out of Stock'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
