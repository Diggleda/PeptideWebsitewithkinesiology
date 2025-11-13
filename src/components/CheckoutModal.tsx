import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogClose } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Card, CardContent } from './ui/card';
import { Minus, Plus, CreditCard, Trash2, LogIn, ShoppingCart, X } from 'lucide-react';
import type { Product, ProductVariant } from '../types/product';
import { toast } from 'sonner@2.0.3';
import { ProductImageCarousel } from './ProductImageCarousel';
import type { CSSProperties } from 'react';

interface CartItem {
  id: string;
  product: Product;
  quantity: number;
  note?: string;
  variant?: ProductVariant | null;
}

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  onCheckout: (referralCode?: string) => Promise<void> | void;
  onUpdateItemQuantity: (cartItemId: string, quantity: number) => void;
  onRemoveItem: (cartItemId: string) => void;
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
  const [bulkOpenMap, setBulkOpenMap] = useState<Record<string, boolean>>({});

  const computeUnitPrice = (product: Product, variant: ProductVariant | null | undefined, quantity: number) => {
    const basePrice = variant?.price ?? product.price;
    const tiers = product.bulkPricingTiers ?? [];
    if (!tiers.length) {
      return basePrice;
    }
    const applicable = [...tiers]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find((tier) => quantity >= tier.minQuantity);
    if (!applicable) {
      return basePrice;
    }
    return basePrice * (1 - applicable.discountPercentage / 100);
  };

  const getVisibleBulkTiers = (product: Product, quantity: number) => {
    const tiers = product.bulkPricingTiers ?? [];
    if (!tiers.length) {
      return [];
    }
    const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
    const currentIndex = sorted.findIndex((tier) => quantity < tier.minQuantity);
    let start = currentIndex === -1 ? Math.max(0, sorted.length - 5) : Math.max(0, currentIndex - 2);
    let visible = sorted.slice(start, start + 5);
    if (visible.length < 5 && start > 0) {
      start = Math.max(0, start - (5 - visible.length));
      visible = sorted.slice(start, start + 5);
    }
    return visible;
  };

  const subtotal = cartItems.reduce((sum, item) => {
    const unitPrice = computeUnitPrice(item.product, item.variant, item.quantity);
    return sum + unitPrice * item.quantity;
  }, 0);
  const total = subtotal;
  const canCheckout = isAuthenticated;
  const checkoutButtonLabel = canCheckout
    ? (isProcessing ? 'Processing order...' : `Complete Purchase (${total.toFixed(2)})`)
    : 'Login to complete purchase';

  // No-op referral handling removed

  const handleCheckout = async () => {
    console.debug('[CheckoutModal] Checkout start', {
      total,
      items: cartItems.map((item) => ({
        id: item.id,
        productId: item.product.id,
        variantId: item.variant?.id,
        qty: item.quantity
      }))
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

  const handleIncreaseQuantity = (cartItemId: string, currentQuantity: number) => {
    const next = Math.min(999, currentQuantity + 1);
    setQuantityInputs((prev) => ({ ...prev, [cartItemId]: String(next) }));
    onUpdateItemQuantity(cartItemId, next);
    setBulkOpenMap((prev) => ({ ...prev, [cartItemId]: true }));
  };

  const handleDecreaseQuantity = (cartItemId: string, currentQuantity: number) => {
    const next = Math.max(1, currentQuantity - 1);
    setQuantityInputs((prev) => ({ ...prev, [cartItemId]: String(next) }));
    onUpdateItemQuantity(cartItemId, next);
    setBulkOpenMap((prev) => ({ ...prev, [cartItemId]: true }));
  };

  const handleQuantityInputChange = (cartItemId: string, value: string) => {
    const digits = value.replace(/[^0-9]/g, '');
    setQuantityInputs((prev) => ({ ...prev, [cartItemId]: digits }));
    if (digits) {
      const normalized = Math.max(1, Math.min(999, parseInt(digits, 10)));
      onUpdateItemQuantity(cartItemId, normalized);
      setBulkOpenMap((prev) => ({ ...prev, [cartItemId]: true }));
    }
  };

  const handleQuantityInputBlur = (cartItemId: string) => {
    if (!quantityInputs[cartItemId]) {
      setQuantityInputs((prev) => ({ ...prev, [cartItemId]: '1' }));
      onUpdateItemQuantity(cartItemId, 1);
    }
  };

  const handleRemoveItem = (cartItemId: string) => {
    console.debug('[CheckoutModal] Remove item request', { cartItemId });
    onRemoveItem(cartItemId);
    setQuantityInputs((prev) => {
      const { [cartItemId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      // referral fields removed
      setQuantityInputs({});
      setIsProcessing(false);
      setBulkOpenMap({});
    }
  }, [isOpen]);

  useEffect(() => {
    if (cartItems.length === 0) {
      setQuantityInputs({});
      return;
    }

    const nextInputs: Record<string, string> = {};
    cartItems.forEach((item) => {
      nextInputs[item.id] = String(item.quantity);
    });
    setQuantityInputs(nextInputs);
    setBulkOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      cartItems.forEach((item) => {
        next[item.id] = prev[item.id] ?? false;
      });
      return next;
    });
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
        className="checkout-modal glass-card squircle-lg w-full max-w-[min(960px,calc(100vw-3rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
        style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}
      >
        <DialogHeader className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
                Checkout
              </DialogTitle>
              {!isCartEmpty && (
                <DialogDescription>Review your order and complete your purchase</DialogDescription>
              )}
            </div>
            <DialogClose className="dialog-close-btn inline-flex items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              aria-label="Close checkout"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="space-y-6 pt-6">
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
                <div className="grid gap-4 lg:grid-cols-2 auto-rows-fr">
                {cartItems.map((item, index) => {
                  const baseImages = item.product.images.length > 0 ? item.product.images : [item.product.image];
                  const carouselImages = item.variant?.image
                    ? [item.variant.image, ...baseImages].filter((src, index, self) => src && self.indexOf(src) === index)
                    : baseImages;
                  const unitPrice = computeUnitPrice(item.product, item.variant, item.quantity);
                  const lineTotal = unitPrice * item.quantity;
                  const visibleTiers = getVisibleBulkTiers(item.product, item.quantity);
                  const isBulkOpen = bulkOpenMap[item.id] ?? false;
                  return (
                    <Card key={item.id} className="glass squircle-sm h-full">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-center gap-4">
                            <div
                              className="flex-shrink-0 self-stretch"
                              style={{ flexBasis: '25%', maxWidth: '25%' }}
                            >
                              <ProductImageCarousel
                                images={carouselImages}
                                alt={item.product.name}
                                className="flex h-full w-full items-center justify-center rounded-lg bg-white/80 p-2"
                                imageClassName="h-full w-full object-contain"
                                style={{ '--product-image-frame-padding': 'clamp(0.35rem, 0.75vw, 0.7rem)' } as CSSProperties}
                                showDots={carouselImages.length > 1}
                                showArrows={false}
                              />
                            </div>
                            <div>
                              <h4 className="line-clamp-1">#{index + 1} — {item.product.name}</h4>
                              <p className="text-sm text-gray-600">{item.product.dosage}</p>
                              {item.variant && (
                                <p className="text-xs text-gray-500">Variant: {item.variant.label}</p>
                              )}
                              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                                <span className="text-green-600 font-bold">
                                  ${unitPrice.toFixed(2)}
                                </span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => handleDecreaseQuantity(item.id, item.quantity)}
                                    disabled={item.quantity <= 1}
                                    className="squircle-sm bg-slate-50 border-2"
                                  >
                                    <Minus className="h-4 w-4" />
                                  </Button>
                                  <Input
                                    value={quantityInputs[item.id] ?? String(item.quantity)}
                                    onChange={(event) => handleQuantityInputChange(item.id, event.target.value)}
                                    onBlur={() => handleQuantityInputBlur(item.id)}
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    className="w-16 text-center squircle-sm bg-slate-50 border-2"
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => handleIncreaseQuantity(item.id, item.quantity)}
                                    className="squircle-sm bg-slate-50 border-2"
                                  >
                                    <Plus className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                              {visibleTiers.length > 0 && (
                                <div className="mt-3 glass-card squircle-sm border border-[var(--brand-glass-border-2)] p-3 space-y-2">
                                  <button
                                    type="button"
                                    className="flex w-full items-center justify-between text-xs font-semibold text-slate-700"
                                    onClick={() =>
                                      setBulkOpenMap((prev) => ({ ...prev, [item.id]: !isBulkOpen }))
                                    }
                                  >
                                    <span className="tracking-wide uppercase text-[0.65rem]">Bulk Pricing</span>
                                    <span className="text-[rgb(95,179,249)] text-[0.65rem]">
                                      {isBulkOpen ? 'Hide' : 'Show'}
                                    </span>
                                  </button>
                                  {isBulkOpen && (
                                    <>
                                      <div className="space-y-1.5 pt-1">
                                        {visibleTiers.map((tier) => (
                                          <div
                                            key={`${tier.minQuantity}-${tier.discountPercentage}`}
                                            className="flex items-center justify-between rounded-md px-2 py-1 text-[0.8rem]"
                                          >
                                            <span
                                              className={
                                                item.quantity >= tier.minQuantity
                                                  ? 'text-green-600 font-semibold'
                                                  : 'text-slate-600'
                                              }
                                            >
                                              Buy {tier.minQuantity}+
                                            </span>
                                            <span
                                              className={`tabular-nums ${
                                                item.quantity >= tier.minQuantity
                                                  ? 'text-green-600 font-semibold'
                                                  : 'text-slate-600'
                                              }`}
                                            >
                                              Save {tier.discountPercentage}%
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                      {item.quantity < visibleTiers[visibleTiers.length - 1].minQuantity && (
                                        <p className="text-xs text-[rgb(95,179,249)] font-medium">
                                          Buy{' '}
                                          {visibleTiers[visibleTiers.length - 1].minQuantity - item.quantity} more to
                                          save {visibleTiers[visibleTiers.length - 1].discountPercentage}%
                                        </p>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                              {item.note && (
                                <p className="mt-2 text-xs text-gray-500">Notes: {item.note}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-3">
                            <p className="font-bold">${lineTotal.toFixed(2)}</p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => handleRemoveItem(item.id)}
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
                      name="cc-number"
                      type="text"
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="1234 5678 9012 3456"
                      className="squircle-sm mt-1 bg-slate-50 border-2"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="expiry">Expiry Date</Label>
                      <Input
                        id="expiry"
                        name="cc-exp"
                        autoComplete="cc-exp"
                        placeholder="MM/YY"
                        className="squircle-sm mt-1 bg-slate-50 border-2"
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="cvv">CVV</Label>
                      <Input
                        id="cvv"
                        name="cc-csc"
                        type="text"
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        placeholder="123"
                        className="squircle-sm mt-1 bg-slate-50 border-2"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="name">Cardholder Name</Label>
                    <Input
                      id="name"
                      name="cc-name"
                      autoComplete="cc-name"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
