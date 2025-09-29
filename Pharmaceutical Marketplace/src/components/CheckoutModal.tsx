import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Card, CardContent } from './ui/card';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { Minus, Plus, Gift, CreditCard, Trash2 } from 'lucide-react';
import { Product } from './ProductCard';
import { toast } from 'sonner@2.0.3';

interface CartItem {
  product: Product;
  quantity: number;
}

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  userReferralCode?: string;
  onCheckout: (referralCode?: string) => void;
}

export function CheckoutModal({ isOpen, onClose, cartItems, userReferralCode, onCheckout }: CheckoutModalProps) {
  const [referralCode, setReferralCode] = useState('');
  const [appliedReferralCode, setAppliedReferralCode] = useState<string | null>(null);
  const [discount, setDiscount] = useState(0);

  // Mock referral codes
  const validReferralCodes = ['SAVE10', 'HEALTH5', 'PHARMA15'];

  const subtotal = cartItems.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  const discountAmount = (subtotal * discount) / 100;
  const total = subtotal - discountAmount;

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

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setReferralCode('');
      setAppliedReferralCode(null);
      setDiscount(0);
    }
  }, [isOpen]);

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
      <DialogContent className="glass-strong squircle-lg max-w-2xl max-h-[90vh] overflow-y-auto">
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
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 flex-shrink-0">
                      <ImageWithFallback
                        src={item.product.image}
                        alt={item.product.name}
                        className="w-full h-full object-cover squircle-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <h4 className="line-clamp-1">{item.product.name}</h4>
                      <p className="text-sm text-gray-600">{item.product.dosage}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-green-600 font-bold">${item.product.price}</span>
                        <span className="text-xs text-gray-500">x {item.quantity}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold">${(item.product.price * item.quantity).toFixed(2)}</p>
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
                Share your code: <Badge variant="outline" className="text-xs squircle-sm">{userReferralCode}</Badge> for rewards!
              </div>
            )}
          </div>

          {/* Payment Form */}
          <div className="space-y-4">
            <h3>Payment Information</h3>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <Label htmlFor="cardNumber">Card Number</Label>
                <Input
                  id="cardNumber"
                  placeholder="1234 5678 9012 3456"
                  className="glass squircle-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="expiry">Expiry Date</Label>
                  <Input
                    id="expiry"
                    placeholder="MM/YY"
                    className="glass squircle-sm"
                  />
                </div>
                <div>
                  <Label htmlFor="cvv">CVV</Label>
                  <Input
                    id="cvv"
                    placeholder="123"
                    className="glass squircle-sm"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="name">Cardholder Name</Label>
                <Input
                  id="name"
                  placeholder="John Doe"
                  className="glass squircle-sm"
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
              onClick={handleCheckout}
              className="w-full bg-primary hover:bg-primary/90 squircle-sm"
            >
              <CreditCard className="w-4 h-4 mr-2" />
              Complete Purchase (${total.toFixed(2)})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}