import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Card, CardContent } from './ui/card';
import { ImageWithFallback } from './ImageWithFallback';
import { Minus, Plus, Gift, CreditCard, Trash2, Copy, LogIn } from 'lucide-react';
import { Product } from './ProductCard';
import { toast } from 'sonner@2.0.3';

interface CartItem {
  product: Product;
  quantity: number;
  note?: string;
}

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  userReferralCode?: string;
  onCheckout: (referralCode?: string) => void;
  onUpdateItemQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
}

export function CheckoutModal({
  isOpen,
  onClose,
  cartItems,
  userReferralCode,
  onCheckout,
  onUpdateItemQuantity,
  onRemoveItem,
  isAuthenticated,
  onRequireLogin
}: CheckoutModalProps) {
  const [referralCode, setReferralCode] = useState('');
  const [appliedReferralCode, setAppliedReferralCode] = useState<string | null>(null);
  const [discount, setDiscount] = useState(0);
  const [quantityInputs, setQuantityInputs] = useState<Record<string, string>>({});

  // Mock referral codes
  const validReferralCodes = ['SAVE10', 'HEALTH5', 'PHARMA15'];

  const subtotal = cartItems.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  const discountAmount = (subtotal * discount) / 100;
  const total = subtotal - discountAmount;
  const canCheckout = isAuthenticated;
  const checkoutButtonLabel = canCheckout ? `Complete Purchase (${total.toFixed(2)})` : 'Login to complete purchase';

  const applyReferralCode = () => {
    if (validReferralCodes.includes(referralCode)) {
      setAppliedReferralCode(referralCode);
      const discountPercent = referralCode === 'PHARMA15' ? 15 : referralCode === 'SAVE10' ? 10 : 5;
      setDiscount(discountPercent);
      toast.success(`Referral code applied! ${discountPercent}% discount`);
    } else {
      toast.error('Invalid referral code');
    }
  };

  const removeReferralCode = () => {
    setAppliedReferralCode(null);
    setDiscount(0);
    setReferralCode('');
    toast.success('Referral code removed');
  };

  const handleCheckout = () => {
    onCheckout(appliedReferralCode || undefined);
    onClose();
  };

  const handlePrimaryAction = () => {
    if (!canCheckout) {
      toast.info('Please log in to complete your purchase.');
      onRequireLogin();
      return;
    }
    handleCheckout();
  };

  const handleCopyUserReferralCode = async () => {
    if (!userReferralCode) return;
    try {
      if (!navigator?.clipboard) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(userReferralCode);
      toast.success('Referral code copied');
    } catch (error) {
      toast.error('Unable to copy referral code');
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
    onRemoveItem(productId);
    setQuantityInputs((prev) => {
      const { [productId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setReferralCode('');
      setAppliedReferralCode(null);
      setDiscount(0);
      setQuantityInputs({});
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

  if (cartItems.length === 0) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="glass-strong squircle-lg max-w-md">
          <DialogHeader>
            <DialogTitle>Your Cart</DialogTitle>
            <DialogDescription>Your cart is empty</DialogDescription>
          </DialogHeader>
          <div className="text-center py-8">
            <p className="text-gray-600 mb-4">Add some products to get started!</p>
            <Button onClick={onClose} className="squircle-sm">Continue Shopping</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="glass-strong squircle-lg max-w-2xl max-h-[90vh] overflow-y-auto border border-slate-200/80 bg-white/96 shadow-[0_32px_72px_-32px_rgba(15,37,37,0.55)]"
        style={{
          backdropFilter: 'blur(26px)'
        }}
      >
        <DialogHeader>
          <DialogTitle>Checkout</DialogTitle>
          <DialogDescription>Review your order and complete your purchase</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Cart Items */}
          <div className="space-y-4">
            <h3>Order Summary</h3>
            {cartItems.map((item) => (
              <Card key={item.product.id} className="glass squircle-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className="w-16 h-16 flex-shrink-0">
                        <ImageWithFallback
                          src={item.product.image}
                          alt={item.product.name}
                          className="w-full h-full object-cover squircle-sm"
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
                              className="squircle-sm"
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                            <Input
                              value={quantityInputs[item.product.id] ?? String(item.quantity)}
                              onChange={(event) => handleQuantityInputChange(item.product.id, event.target.value)}
                              onBlur={() => handleQuantityInputBlur(item.product.id)}
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="w-16 text-center squircle-sm"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => handleIncreaseQuantity(item.product.id, item.quantity)}
                              className="squircle-sm"
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
            ))}
          </div>

          {/* Referral Code Section */}
          <div className="space-y-3">
            <Label>Referral Code</Label>
            {!appliedReferralCode ? (
              <div className="flex gap-2">
                <Input
                  placeholder="Enter referral code"
                  value={referralCode}
                  onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  className="glass squircle-sm"
                />
                <Button 
                  variant="outline" 
                  onClick={applyReferralCode}
                  disabled={referralCode.length !== 6}
                  className="glass squircle-sm"
                >
                  <Gift className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between glass squircle-sm p-3">
                <div className="flex items-center gap-2">
                  <Gift className="w-4 h-4 text-green-600" />
                  <span className="text-sm">Code: {appliedReferralCode}</span>
                  <Badge variant="secondary" className="squircle-sm">-{discount}%</Badge>
                </div>
                <Button variant="ghost" size="sm" onClick={removeReferralCode}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            )}
            {userReferralCode && (
              <div className="text-xs text-gray-600">
                Share your code:
                <button
                  type="button"
                  onClick={handleCopyUserReferralCode}
                  className="group copy-trigger ml-2 inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/80 px-3 py-1 font-medium text-slate-700 transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer"
                >
                  <Gift className="h-3 w-3 text-slate-600" />
                  <span className="text-xs">{userReferralCode}</span>
                  <Copy className="copy-icon h-3 w-3 pointer-events-none" aria-hidden="true" />
                  <span className="sr-only">Copy referral code</span>
                </button>
                for rewards!
              </div>
            )}
          </div>

          {/* Payment Form */}
          <div className="space-y-5">
            <h3>Payment Information</h3>
            <div className="grid grid-cols-1 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="cardNumber">Card Number</Label>
                <Input
                  id="cardNumber"
                  placeholder="1234 5678 9012 3456"
                  className="glass squircle-sm mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="expiry">Expiry Date</Label>
                  <Input
                    id="expiry"
                    placeholder="MM/YY"
                    className="glass squircle-sm mt-1"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cvv">CVV</Label>
                  <Input
                    id="cvv"
                    placeholder="123"
                    className="glass squircle-sm mt-1"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Cardholder Name</Label>
                <Input
                  id="name"
                  placeholder="John Doe"
                  className="glass squircle-sm mt-1"
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
            {discount > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Discount ({discount}%):</span>
                <span>-${discountAmount.toFixed(2)}</span>
              </div>
            )}
            <Separator />
            <div className="flex justify-between font-bold">
              <span>Total:</span>
              <span>${total.toFixed(2)}</span>
            </div>
          </div>

          {/* Checkout Button */}
          <div className="pt-4">
            <Button 
              onClick={handlePrimaryAction}
              className="w-full bg-primary hover:bg-primary/90 squircle-sm"
            >
              {canCheckout ? (
                <CreditCard className="w-4 h-4 mr-2" />
              ) : (
                <LogIn className="w-4 h-4 mr-2" />
              )}
              {checkoutButtonLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
