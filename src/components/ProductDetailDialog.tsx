import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ImageWithFallback } from './ImageWithFallback';
import { Product } from './ProductCard';
import { Minus, Plus, ShoppingCart } from 'lucide-react';

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
  const shouldSkipNextCloseRef = useRef(false);

  console.debug('[ProductDetailDialog] Render', { isOpen, hasProduct: Boolean(product) });

  useEffect(() => {
    if (isOpen) {
      setQuantity(1);
      setQuantityInput('1');
      setQuantityDescription('');
      shouldSkipNextCloseRef.current = true;
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
    console.debug('[ProductDetailDialog] Add to cart', { productId: product.id, quantity, note });
    onAddToCart(product.id, quantity, note ? note : undefined);
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        console.debug('[ProductDetailDialog] Open change', { open, productId: product?.id });
        if (!open) {
          if (shouldSkipNextCloseRef.current) {
            shouldSkipNextCloseRef.current = false;
            return;
          }
          onClose();
        }
      }}
    >
      <DialogContent className="squircle-xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-xl font-semibold">
            {product ? product.name : 'Product details'}
          </DialogTitle>
          <DialogDescription>Review the product details and add it to your cart.</DialogDescription>
        </DialogHeader>

        {product ? (
          <div className="pb-6">
            <div className="grid gap-6 border-t border-[var(--brand-glass-border-1)] px-6 pt-5 md:grid-cols-[240px_1fr]">
              <aside className="space-y-4 px-0 md:px-0">
                <div className="overflow-hidden rounded-2xl glass-card border border-[var(--brand-glass-border-2)] shadow-inner">
                  <ImageWithFallback src={product.image} alt={product.name} className="h-56 w-full object-cover" />
                </div>
                <div className="space-y-2 text-sm text-slate-800">
                  <div>
                    <span className="font-medium text-slate-900">Manufacturer:</span> {product.manufacturer || 'N/A'}
                  </div>
                  <div>
                    <span className="font-medium text-slate-900">Dosage:</span> {product.dosage}
                  </div>
                  {product.type && (
                    <div>
                      <span className="font-medium text-slate-900">Type:</span> {product.type}
                    </div>
                  )}
                  {product.prescription && <div className="font-medium text-orange-700">Prescription required</div>}
                  {!product.inStock && <div className="font-medium text-red-600">Currently out of stock</div>}
                </div>
              </aside>

              <section className="flex flex-col">
                <div className="space-y-5">
                  {(product.description || product.benefits || product.protocol) && (
                    <div className="space-y-4">
                      {product.description && (
                        <div className="space-y-2">
                          <Label>Overview</Label>
                          <p className="text-sm leading-relaxed text-slate-700/95">{product.description}</p>
                        </div>
                      )}
                      {product.benefits && (
                        <div className="space-y-2">
                          <Label>Benefits</Label>
                          <p className="text-sm leading-relaxed text-slate-700/95">{product.benefits}</p>
                        </div>
                      )}
                      {product.protocol && (
                        <div className="space-y-2">
                          <Label>Protocol</Label>
                          <p className="text-sm leading-relaxed text-slate-700/95">{product.protocol}</p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-4 glass-card rounded-2xl border border-[var(--brand-glass-border-2)] p-4 shadow-inner">
                    <div className="space-y-3">
                      <Label htmlFor="quantity">Quantity</Label>
                      <div className="flex items-center gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => handleQuantityChange(quantity - 1)}
                          disabled={quantity <= 1}
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
                          className="w-24 text-center"
                        />
                        <Button type="button" variant="outline" size="icon" onClick={() => handleQuantityChange(quantity + 1)}>
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <Label htmlFor="quantityDescription">Order Notes</Label>
                      <textarea
                        id="quantityDescription"
                        value={quantityDescription}
                        onChange={(event) => setQuantityDescription(event.target.value)}
                        placeholder="Add fulfillment notes or special instructions"
                      className="min-h-[120px] w-full resize-y glass squircle-sm p-3 text-sm focus-visible:outline-none focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                      />
                    </div>

                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div className="space-y-1">
                        <div className="flex items-baseline gap-3 text-green-700">
                          {product.price > 0 ? (
                            <span className="text-2xl font-semibold">${product.price.toFixed(2)}</span>
                          ) : (
                            <span className="text-base font-semibold text-green-700">Contact for pricing</span>
                          )}
                          {product.price > 0 && product.originalPrice && (
                            <span className="text-sm text-gray-500 line-through">${product.originalPrice.toFixed(2)}</span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600">
                          Total:{' '}
                          <span className="font-semibold text-green-700">
                            ${(product.price * quantity).toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <Button
                        variant="outline"
                        onClick={handleAddToCart}
                        disabled={!product.inStock}
                        className="glass-strong squircle-sm btn-hover-lighter text-[rgb(7,27,27)] border border-[var(--brand-glass-border-2)]"
                      >
                        <ShoppingCart className="mr-2 h-4 w-4" />
                        {product.inStock ? 'Add to Cart' : 'Out of Stock'}
                      </Button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
