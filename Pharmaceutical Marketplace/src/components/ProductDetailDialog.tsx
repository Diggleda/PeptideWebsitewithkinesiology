import { useEffect, useState, type ChangeEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ImageWithFallback } from './ImageWithFallback';
import { Product } from './ProductCard';
import { Minus, Plus, ShoppingCart, Star } from 'lucide-react';

interface ProductDetailDialogProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  onAddToCart: (productId: string, quantity: number, note?: string) => void;
}

export function ProductDetailDialog({ product, isOpen, onClose, onAddToCart }: ProductDetailDialogProps) {
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState('1');
  const [quantityDescription, setQuantityDescription] = useState('');

  useEffect(() => {
    if (isOpen) {
      setQuantity(1);
      setQuantityInput('1');
      setQuantityDescription('');
    }
  }, [isOpen, product]);

  const updateQuantity = (value: number) => {
    const normalized = Math.max(1, Math.min(999, Math.floor(Number.isFinite(value) ? value : 1)));
    setQuantity(normalized);
    setQuantityInput(String(normalized));
  };

  const handleQuantityChange = (value: number) => {
    if (!Number.isFinite(value)) return;
    updateQuantity(value);
  };

  const handleQuantityInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const digits = event.target.value.replace(/[^0-9]/g, '');
    setQuantityInput(digits);
    if (digits) {
      updateQuantity(Number(digits));
    }
  };

  const handleQuantityInputBlur = () => {
    if (!quantityInput) {
      updateQuantity(1);
    }
  };

  const handleAddToCart = () => {
    if (!product) return;
    const note = quantityDescription.trim();
    onAddToCart(product.id, quantity, note ? note : undefined);
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="glass-strong squircle-lg w-full max-w-[1100px] lg:h-[90vh] border border-slate-200/80 bg-white/95 p-0 shadow-[0_40px_80px_-40px_rgba(15,37,37,0.55)]"
        style={{
          background: 'linear-gradient(160deg, rgba(255,255,255,0.98), rgba(226,240,240,0.92))',
          backdropFilter: 'blur(28px)'
        }}
      >
        {product ? (
          <div className="flex h-full flex-col lg:flex-row">
            {/* Left column */}
            <aside className="flex-shrink-0 border-slate-200/70 bg-white/92 lg:w-[400px] lg:border-r">
              <DialogHeader className="space-y-3 px-6 pt-6">
                <DialogTitle className="text-2xl">{product.name}</DialogTitle>
                <DialogDescription>
                  Comprehensive details and ordering options for this medication.
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
                <div className="relative overflow-hidden rounded-3xl border border-slate-200/70 bg-white shadow-xl">
                  <ImageWithFallback
                    src={product.image}
                    alt={product.name}
                    className="h-64 w-full object-cover sm:h-72"
                  />
                  {product.prescription && (
                    <Badge
                      variant="secondary"
                      className="absolute top-3 right-3 bg-orange-100 text-orange-800 squircle-sm"
                    >
                      Prescription Required
                    </Badge>
                  )}
                </div>
                <div className="rounded-3xl border border-slate-200/70 bg-white/97 p-5 shadow-inner space-y-3">
                  <Badge variant="outline" className="squircle-sm">
                    {product.category}
                  </Badge>
                  <p className="text-sm text-slate-600">Manufacturer: {product.manufacturer}</p>
                  {product.type && (
                    <p className="text-sm text-slate-600">Type: {product.type}</p>
                  )}
                  <p className="text-sm text-slate-600">Dosage: {product.dosage}</p>
                  {!product.inStock && (
                    <p className="text-sm font-medium text-red-600">Currently out of stock</p>
                  )}
                </div>
              </div>
            </aside>

            {/* Right column */}
            <section className="flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
              <div className="space-y-6 pt-6 lg:pt-10">
                <div className="rounded-3xl border border-slate-200/70 bg-white/98 p-6 shadow-sm space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-green-600">
                    {product.price > 0 ? (
                      <span className="text-3xl font-semibold">${product.price.toFixed(2)}</span>
                    ) : (
                      <span className="text-lg font-semibold text-green-600">Contact for pricing</span>
                    )}
                    {product.price > 0 && product.originalPrice && (
                      <span className="text-sm text-gray-500 line-through">
                        ${product.originalPrice.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                    <div className="flex items-center">
                      {Array.from({ length: 5 }).map((_, index) => (
                        <Star
                          key={index}
                          className={`h-4 w-4 ${
                            index < Math.floor(product.rating)
                              ? 'fill-yellow-400 text-yellow-400'
                              : 'text-gray-200'
                          }`}
                        />
                      ))}
                    </div>
                    <span>{product.rating.toFixed(1)} rating</span>
                    <span>&bull;</span>
                    <span>{product.reviews} reviews</span>
                  </div>
                  <p className="text-sm text-gray-600">
                    Ensure dosage suitability and review any contraindications prior to fulfillment.
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200/70 bg-white/98 p-6 shadow-sm space-y-4">
                  <div className="space-y-3">
                    <Label htmlFor="quantity">Quantity</Label>
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => handleQuantityChange(quantity - 1)}
                        disabled={quantity <= 1}
                        className="squircle-sm"
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <Input
                        id="quantity"
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={quantityInput}
                        onChange={handleQuantityInputChange}
                        onBlur={handleQuantityInputBlur}
                        className="w-24 text-center squircle-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => handleQuantityChange(quantity + 1)}
                        className="squircle-sm"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="quantityDescription">Quantity Description</Label>
                    <textarea
                      id="quantityDescription"
                      value={quantityDescription}
                      onChange={(event) => setQuantityDescription(event.target.value)}
                      placeholder="Add fulfillment notes, packaging instructions, or quantity details"
                      className="min-h-[120px] w-full resize-y rounded-3xl border border-slate-200/70 bg-white/96 p-3 text-sm shadow-inner focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                </div>

                {(product.description || product.benefits || product.protocol) && (
                  <div className="rounded-3xl border border-slate-200/70 bg-white/98 p-6 shadow-sm space-y-4">
                    {product.description && (
                      <div className="space-y-2">
                        <Label>Overview</Label>
                        <p className="text-sm text-slate-600 leading-relaxed">{product.description}</p>
                      </div>
                    )}
                    {product.benefits && (
                      <div className="space-y-2">
                        <Label>Benefits</Label>
                        <p className="text-sm text-slate-600 leading-relaxed">{product.benefits}</p>
                      </div>
                    )}
                    {product.protocol && (
                      <div className="space-y-2">
                        <Label>Protocol</Label>
                        <p className="text-sm text-slate-600 leading-relaxed">{product.protocol}</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-4 rounded-3xl border border-slate-200/70 bg-white/98 p-6 shadow-sm md:flex-row md:items-center md:justify-between">
                  <div className="text-sm text-gray-600">
                    Total: <span className="font-semibold text-green-600">${(product.price * quantity).toFixed(2)}</span>
                  </div>
                  <Button
                    onClick={handleAddToCart}
                    disabled={!product.inStock}
                    className="bg-primary hover:bg-primary/90 squircle-sm"
                  >
                    <ShoppingCart className="mr-2 h-4 w-4" />
                    {product.inStock ? 'Add to Cart' : 'Out of Stock'}
                  </Button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
