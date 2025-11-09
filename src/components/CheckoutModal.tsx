import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Card, CardContent } from './ui/card';
import { Minus, Plus, CreditCard, Trash2, LogIn, ShoppingCart } from 'lucide-react';
import { Product } from './ProductCard';
import { toast } from 'sonner@2.0.3';
import { ProductImageCarousel } from './ProductImageCarousel';
import type { CSSProperties } from 'react';

interface CartItem {
  product: Product;
  quantity: number;
  note?: string;
}

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  onCheckout: (referralCode?: string) => Promise<void> | void;
  onUpdateItemQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
}

export function CheckoutModal({
  isOpen,
  onClose,
  cartItems,
  onCheckout,
  onUpdateItemQuantity,
  onRemoveItem,
  isAuthenticated,
  onRequireLogin
}: CheckoutModalProps) {
  // Referral codes are no longer collected at checkout.
  const [quantityInputs, setQuantityInputs] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  const subtotal = cartItems.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  const total = subtotal;
  const canCheckout = isAuthenticated;
  const checkoutButtonLabel = canCheckout
    ? (isProcessing ? 'Processing order...' : `Complete Purchase (${total.toFixed(2)})`)
    : 'Login to complete purchase';

  // No-op referral handling removed

  const handleCheckout = async () => {
    console.debug('[CheckoutModal] Checkout start', {
      total,
      items: cartItems.map((item) => ({ id: item.product.id, qty: item.quantity }))
    });
    setIsProcessing(true);
    try {
      await onCheckout(undefined);
      onClose();
      console.debug('[CheckoutModal] Checkout success');
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePrimaryAction = async () => {
    if (!canCheckout) {
      // toast.info('Please log in to complete your purchase.');
      console.debug('[CheckoutModal] Require login from checkout button');
      onRequireLogin();
      return;
    }
    if (isProcessing) {
      console.debug('[CheckoutModal] Checkout ignored, already processing');
      return;
    }
    try {
      console.debug('[CheckoutModal] Checkout button confirmed');
      await handleCheckout();
    } catch {
      // Error feedback handled by onCheckout caller
      console.warn('[CheckoutModal] Checkout handler threw');
    }
  };

  const handleIncreaseQuantity = (productId: string, currentQuantity: number) => {
    const next = Math.min(999, currentQuantity + 1);
    setQuantityInputs((prev) => ({ ...prev, [productId]: String(next) }));
    onUpdateItemQuantity(productId, next);
  };

  const handleDecreaseQuantity = (productId: string, currentQuantity: number) => {
    const next = Math.max(1, currentQuantity - 1);
    setQuantityInputs((prev) => ({ ...prev, [productId]: String(next) }));
    onUpdateItemQuantity(productId, next);
  };

  const handleQuantityInputChange = (productId: string, value: string) => {
    const digits = value.replace(/[^0-9]/g, '');
    setQuantityInputs((prev) => ({ ...prev, [productId]: digits }));
    if (digits) {
      const normalized = Math.max(1, Math.min(999, parseInt(digits, 10)));
      onUpdateItemQuantity(productId, normalized);
    }
  };

  const handleQuantityInputBlur = (productId: string) => {
    if (!quantityInputs[productId]) {
      setQuantityInputs((prev) => ({ ...prev, [productId]: '1' }));
      onUpdateItemQuantity(productId, 1);
    }
  };

  const handleRemoveItem = (productId: string) => {
    console.debug('[CheckoutModal] Remove item request', { productId });
    onRemoveItem(productId);
    setQuantityInputs((prev) => {
      const { [productId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      // referral fields removed
      setQuantityInputs({});
      setIsProcessing(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (cartItems.length === 0) {
      setQuantityInputs({});
      return;
    }

    const next: Record<string, string> = {};
    cartItems.forEach((item) => {
      next[item.product.id] = String(item.quantity);
    });
    setQuantityInputs(next);
  }, [cartItems]);

  const isCartEmpty = cartItems.length === 0;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        console.debug('[CheckoutModal] Dialog open change', { open });
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl"
        style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
            Checkout
          </DialogTitle>
          {!isCartEmpty && (
            <DialogDescription>Review your order and complete your purchase</DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-6">
          {isCartEmpty ? (
            <div className="flex flex-col items-center justify-center py-14 space-y-6 text-center">
              <div className="flex items-center gap-3 text-slate-600">
                <ShoppingCart className="h-6 w-6 text-[rgb(95,179,249)]" />
                <span className="text-base font-medium text-slate-700">Your cart is empty</span>
              </div>
              <Button
                onClick={onClose}
                className="squircle-sm glass-brand btn-hover-lighter px-6"
              >
                Continue Shopping
              </Button>
            </div>
          ) : (
            <>
              {/* Cart Items */}
              <div className="space-y-4">
                <h3>Order Summary</h3>
                {cartItems.map((item) => {
                  const primaryImage = item.product.images[0] ?? item.product.image;
                  return (
                    <Card key={item.product.id} className="glass squircle-sm">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-center gap-4">
                            <div className="w-24 h-24 flex-shrink-0">
                              <ProductImageCarousel
                                images={item.product.images.length > 0 ? item.product.images : [primaryImage]}
                                alt={item.product.name}
                                className="flex h-full w-full items-center justify-center rounded-lg bg-white/80 p-2"
                                imageClassName="h-full w-full object-contain"
                                style={{ '--product-image-frame-padding': 'clamp(0.35rem, 0.75vw, 0.7rem)' } as CSSProperties}
                                showDots={item.product.images.length > 1}
                                showArrows={false}
                              />
                            </div>
                            <div>
                              <h4 className="line-clamp-1">{item.product.name}</h4>
                              <p className="text-sm text-gray-600">{item.product.dosage}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                                <span className="text-green-600 font-bold">${item.product.price.toFixed(2)}</span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => handleDecreaseQuantity(item.product.id, item.quantity)}
                                    disabled={item.quantity <= 1}
                                    className="squircle-sm bg-slate-50 border-2"
                                  >
                                    <Minus className="h-4 w-4" />
                                  </Button>
                                  <Input
                                    value={quantityInputs[item.product.id] ?? String(item.quantity)}
                                    onChange={(event) => handleQuantityInputChange(item.product.id, event.target.value)}
                                    onBlur={() => handleQuantityInputBlur(item.product.id)}
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    className="w-16 text-center squircle-sm bg-slate-50 border-2"
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => handleIncreaseQuantity(item.product.id, item.quantity)}
                                    className="squircle-sm bg-slate-50 border-2"
                                  >
                                    <Plus className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                              {item.note && (
                                <p className="mt-2 text-xs text-gray-500">Notes: {item.note}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-3">
                            <p className="font-bold">${(item.product.price * item.quantity).toFixed(2)}</p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => handleRemoveItem(item.product.id)}
                              className="text-red-500 hover:text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">Remove item</span>
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Referral Code Section removed */}

              {/* Payment Form */}
              <div className="space-y-5">
                <h3>Payment Information</h3>
                <div className="grid grid-cols-1 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cardNumber">Card Number</Label>
                    <Input
                      id="cardNumber"
                      placeholder="1234 5678 9012 3456"
                      className="squircle-sm mt-1 bg-slate-50 border-2"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="expiry">Expiry Date</Label>
                      <Input
                        id="expiry"
                        placeholder="MM/YY"
                        className="squircle-sm mt-1 bg-slate-50 border-2"
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="cvv">CVV</Label>
                      <Input
                        id="cvv"
                        placeholder="123"
                        className="squircle-sm mt-1 bg-slate-50 border-2"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="name">Cardholder Name</Label>
                    <Input
                      id="name"
                      placeholder="John Doe"
                      className="squircle-sm mt-1 bg-slate-50 border-2"
                    />
                  </div>
                </div>
              </div>

              {/* Order Total */}
              <div className="space-y-2">
                <Separator />
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>${subtotal.toFixed(2)}</span>
                </div>
                <Separator />
                <div className="flex justify-between font-bold">
                  <span>Total:</span>
                  <span>${total.toFixed(2)}</span>
                </div>
              </div>

              {/* Checkout Button */}
              <div className="pt-4">
                <Button
                  variant="ghost"
                  onClick={handlePrimaryAction}
                  disabled={isProcessing}
                  className="w-full glass-brand squircle-sm transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                >
                  {canCheckout ? (
                    <CreditCard className="w-4 h-4 mr-2" />
                  ) : (
                    <LogIn className="w-4 h-4 mr-2" />
                  )}
                  {checkoutButtonLabel}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
