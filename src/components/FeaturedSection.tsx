import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { ImageWithFallback } from './ImageWithFallback';
import { ArrowRight, Zap } from 'lucide-react';
import { Product } from './ProductCard';

interface FeaturedSectionProps {
  featuredProducts: Product[];
  onAddToCart: (productId: string) => void;
}

export function FeaturedSection({ featuredProducts, onAddToCart }: FeaturedSectionProps) {
  const mainFeatured = featuredProducts[0];
  const otherFeatured = featuredProducts.slice(1, 4);

  return (
    <div className="mb-12">
      <div className="flex items-center gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Zap className="w-6 h-6 text-yellow-500" />
          <h2>Featured Products</h2>
        </div>
        <Badge className="bg-yellow-500 hover:bg-yellow-600 squircle-sm">
          Special Offers
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Featured Product */}
        {mainFeatured && (
          <Card className="lg:col-span-2 overflow-hidden glass-card squircle-lg shadow-lg">
            <CardContent className="p-0">
              <div className="grid md:grid-cols-2 gap-0">
                <div className="relative aspect-square md:aspect-auto">
                  <ImageWithFallback
                    src={mainFeatured.image}
                    alt={mainFeatured.name}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-4 left-4">
                    <Badge className="bg-red-500 hover:bg-red-600 squircle-sm">
                      Best Seller
                    </Badge>
                  </div>
                </div>
                
                <div className="p-6 flex flex-col justify-center">
                  <Badge variant="outline" className="w-fit mb-3 squircle-sm">
                    {mainFeatured.category}
                  </Badge>
                  
                  <h3 className="mb-2">{mainFeatured.name}</h3>
                  <p className="text-gray-600 mb-4 line-clamp-3">
                    {mainFeatured.dosage} - {mainFeatured.manufacturer}
                  </p>
                  
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-green-600 font-bold text-lg">
                      ${mainFeatured.price.toFixed(2)}
                    </span>
                    {mainFeatured.originalPrice && (
                      <span className="text-gray-500 line-through">
                        ${mainFeatured.originalPrice.toFixed(2)}
                      </span>
                    )}
                  </div>
                  
                  <Button 
                    variant="outline"
                    onClick={() => onAddToCart(mainFeatured.id)}
                    className="glass-strong squircle-sm btn-hover-lighter btn-add-to-cart border border-[var(--brand-glass-border-2)]"
                  >
                    Add to Cart
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Other Featured Products */}
        <div className="space-y-4">
          {otherFeatured.map((product) => (
            <Card key={product.id} className="overflow-hidden glass-card squircle-lg shadow-md hover:shadow-lg transition-all duration-300">
              <CardContent className="p-0">
                <div className="flex gap-3 p-4">
                  <div className="relative w-16 h-16 flex-shrink-0">
                    <ImageWithFallback
                      src={product.image}
                      alt={product.name}
                      className="w-full h-full object-cover squircle-sm"
                    />
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <Badge variant="outline" className="text-xs mb-1 squircle-sm">
                      {product.category}
                    </Badge>
                    <h4 className="line-clamp-1 text-sm mb-1">{product.name}</h4>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-green-600">${product.price.toFixed(2)}</span>
                      {product.originalPrice && (
                        <span className="text-xs text-gray-500 line-through">
                          ${product.originalPrice.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <Button 
                    variant="outline"
                    size="sm" 
                    onClick={() => onAddToCart(product.id)}
                    className="glass-strong squircle-sm btn-hover-lighter btn-add-to-cart border border-[var(--brand-glass-border-2)]"
                  >
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
