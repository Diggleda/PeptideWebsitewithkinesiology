import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
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
import type { Product } from '../types/product';
import { Minus, Plus, ShoppingCart, Package, Pill, Building2, CheckCircle2, AlertCircle, Tag } from 'lucide-react';
import { ProductImageCarousel } from './ProductImageCarousel';
import { Badge } from './ui/badge';

interface ProductDetailDialogProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  onAddToCart: (productId: string, quantity: number, note?: string, variantId?: string | null) => void;
}

export function ProductDetailDialog({ product, isOpen, onClose, onAddToCart }: ProductDetailDialogProps) {
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState('1');
  const [quantityDescription, setQuantityDescription] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'specs'>('overview');
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);

  console.debug('[ProductDetailDialog] Render', { isOpen, hasProduct: Boolean(product) });

  const tabs = useMemo(() => (
    [
      { id: 'overview' as const, label: 'Overview', show: !!product?.description },
      { id: 'specs' as const, label: 'Specifications', show: true }
    ].filter(tab => tab.show)
  ), [product?.description, product?.id]);

  const variantOptions = product?.variants ?? [];
  const showVariantSelector = variantOptions.length > 0;
  const activeVariant = showVariantSelector
    ? variantOptions.find((variant) => variant.id === selectedVariantId) ?? variantOptions[0] ?? null
    : null;

  useEffect(() => {
    if (isOpen) {
      setQuantity(1);
      setQuantityInput('1');
      setQuantityDescription('');
      const defaultTab = (tabs[0]?.id ?? 'specs') as 'overview' | 'specs';
      setActiveTab(defaultTab);
      setSelectedImageIndex(0);
      const defaultVariantId =
        product?.defaultVariantId ??
        product?.variants?.find((variant) => variant.inStock)?.id ??
        product?.variants?.[0]?.id ??
        null;
      setSelectedVariantId(defaultVariantId);
    }
  }, [isOpen, product, tabs]);

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
    if (showVariantSelector && !activeVariant) {
      console.warn('[ProductDetailDialog] Variant selection required before adding to cart');
      return;
    }
    const note = quantityDescription.trim();
    console.debug('[ProductDetailDialog] Add to cart', {
      productId: product.id,
      quantity,
      note,
      variantId: activeVariant?.id,
    });
    onAddToCart(product.id, quantity, note ? note : undefined, activeVariant?.id ?? null);
    onClose();
  };

  const images = useMemo(() => {
    if (!product) return [];
    const baseImages = product.images.length > 0 ? product.images : [product.image];
    if (activeVariant?.image) {
      const seen = new Set<string>();
      const ordered = [activeVariant.image, ...baseImages];
      return ordered.filter((src) => {
        if (!src || seen.has(src)) {
          return false;
        }
        seen.add(src);
        return true;
      });
    }
    return baseImages;
  }, [product, activeVariant]);

  const displayPrice = activeVariant?.price ?? product?.price ?? 0;
  const displayOriginalPrice = activeVariant?.originalPrice ?? (!product?.hasVariants ? product?.originalPrice : undefined);
  const discount = displayOriginalPrice
    ? Math.round(((displayOriginalPrice - displayPrice) / displayOriginalPrice) * 100)
    : 0;
  const isInStock = showVariantSelector ? Boolean(activeVariant?.inStock) : Boolean(product?.inStock);
  const detailDescriptor = showVariantSelector
    ? activeVariant?.label || activeVariant?.dosage || product?.dosage
    : product?.dosage || activeVariant?.label || activeVariant?.dosage;

  useEffect(() => {
    if (!tabs.some(tab => tab.id === activeTab)) {
      const fallback = (tabs[0]?.id ?? 'specs') as 'overview' | 'specs';
      setActiveTab(fallback);
    }
  }, [tabs, activeTab]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        console.debug('[ProductDetailDialog] Open change', { open, productId: product?.id });
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="squircle-xl max-w-5xl max-h-[90vh] overflow-hidden flex flex-col p-0">
        {/* Sticky Header */}
        <DialogHeader className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-2xl font-bold text-slate-900 line-clamp-2">
                {product ? product.name : 'Product details'}
              </DialogTitle>
              <DialogDescription className="mt-1">Review the product details and add it to your cart.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {product ? (
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="flex flex-col gap-6 pt-6 lg:flex-row lg:items-start">
              {/* Image Column */}
              <div className="space-y-4 flex-shrink-0 w-full max-w-[240px] lg:max-w-[220px] lg:basis-[220px] lg:sticky lg:top-6">
                <div className="relative w-full overflow-hidden rounded-3xl glass-card border border-[var(--brand-glass-border-2)] bg-white/70 shadow-lg aspect-square">
                  <ProductImageCarousel
                    images={images}
                    alt={product.name}
                    className="flex h-full w-full items-center justify-center p-4 sm:p-6"
                    imageClassName="h-full w-full object-contain"
                    style={{ '--product-image-frame-padding': 'clamp(0.55rem, 1vw, 1.15rem)' } as CSSProperties}
                    showArrows={images.length > 1}
                    showDots={false}
                  />

                  <div className="absolute top-4 left-4 flex flex-wrap gap-2">
                    {product.prescription && (
                      <Badge className="squircle-sm bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg border-0">
                        <Pill className="w-3 h-3 mr-1" />
                        Rx Required
                      </Badge>
                    )}
                    {discount > 0 && (
                      <Badge className="squircle-sm bg-gradient-to-br from-red-500 to-red-600 text-white shadow-lg border-0">
                        <Tag className="w-3 h-3 mr-1" />
                        -{discount}% OFF
                      </Badge>
                    )}
                  </div>

                  <div className="absolute top-4 right-4">
                    {product.inStock ? (
                      <Badge className="squircle-sm bg-gradient-to-br from-green-500 to-green-600 text-white shadow-lg border-0">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        In Stock
                      </Badge>
                    ) : (
                      <Badge className="squircle-sm bg-gradient-to-br from-red-500 to-red-600 text-white shadow-lg border-0">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        Out of Stock
                      </Badge>
                    )}
                  </div>
                </div>

                {images.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-2 max-w-[220px] mx-auto lg:mx-0">
                    {images.map((img, idx) => (
                      <button
                        key={idx}
                        onClick={() => setSelectedImageIndex(idx)}
                        className={`flex-shrink-0 w-14 h-14 rounded-lg glass-card border-2 transition-all overflow-hidden ${
                          selectedImageIndex === idx
                            ? 'border-[rgb(95,179,249)] scale-105'
                            : 'border-[var(--brand-glass-border-2)] hover:border-slate-400'
                        }`}
                      >
                        <img src={img} alt={`${product.name} thumbnail ${idx + 1}`} className="w-full h-full object-contain p-0.5" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Tabs + Info Column */}
              <div className="space-y-6 flex-1 min-w-0">
                <div className="space-y-4">
                  <div className="flex gap-2 border-b border-[var(--brand-glass-border-1)] overflow-x-auto pb-1">
                    {tabs.map(tab => (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-all border-b-2 ${
                          activeTab === tab.id
                            ? 'border-[rgb(95,179,249)] text-[rgb(95,179,249)]'
                            : 'border-transparent text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="rounded-2xl border-2 border-[var(--brand-glass-border-2)] p-6 min-h-[200px] bg-white shadow-sm">
                    {activeTab === 'overview' && product.description && (
                      <div className="space-y-2">
                        <h3 className="text-lg font-semibold text-slate-900">Product Overview</h3>
                        <p className="text-sm leading-relaxed text-slate-700">{product.description}</p>
                      </div>
                    )}

                    {activeTab === 'specs' && (
                      <div className="space-y-4">
                        <h3 className="text-lg font-semibold text-slate-900">Specifications</h3>
                        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <dt className="text-xs font-medium text-slate-600 uppercase tracking-wide">Category</dt>
                            <dd className="mt-1 text-sm font-semibold text-slate-900">{product.category}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium text-slate-600 uppercase tracking-wide">Manufacturer</dt>
                            <dd className="mt-1 text-sm font-semibold text-slate-900">{product.manufacturer || 'N/A'}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium text-slate-600 uppercase tracking-wide">Dosage</dt>
                            <dd className="mt-1 text-sm font-semibold text-slate-900">{detailDescriptor}</dd>
                          </div>
                          {product.type && (
                            <div>
                              <dt className="text-xs font-medium text-slate-600 uppercase tracking-wide">Type</dt>
                              <dd className="mt-1 text-sm font-semibold text-slate-900">{product.type}</dd>
                            </div>
                          )}
                        </dl>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="rounded-2xl border-2 border-[var(--brand-glass-border-2)] p-4 space-y-2 bg-white shadow-sm">
                    <div className="flex items-center gap-2 text-slate-600">
                      <Building2 className="w-4 h-4" />
                      <span className="text-xs font-medium uppercase tracking-wide">Manufacturer</span>
                    </div>
                    <p className="text-sm font-semibold text-slate-900">{product.manufacturer || 'N/A'}</p>
                  </div>

                  <div className="rounded-2xl border-2 border-[var(--brand-glass-border-2)] p-4 space-y-2 bg-white shadow-sm">
                    <div className="flex items-center gap-2 text-slate-600">
                      <Pill className="w-4 h-4" />
                      <span className="text-xs font-medium uppercase tracking-wide">Dosage</span>
                    </div>
                    <p className="text-sm font-semibold text-slate-900">{detailDescriptor}</p>
                  </div>

                  {product.type && (
                    <div className="rounded-2xl border-2 border-[var(--brand-glass-border-2)] p-4 space-y-2 bg-white shadow-sm">
                      <div className="flex items-center gap-2 text-slate-600">
                        <Package className="w-4 h-4" />
                        <span className="text-xs font-medium uppercase tracking-wide">Type</span>
                      </div>
                      <p className="text-sm font-semibold text-slate-900">{product.type}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column - Order Panel */}
              <div className="lg:sticky lg:top-6 h-fit flex-shrink-0 lg:basis-[340px] lg:max-w-[340px] lg:w-auto w-full">
                <div className="space-y-5 rounded-3xl border-2 border-[var(--brand-glass-border-2)] p-6 shadow-xl bg-white">
                  {/* Price Section */}
                  <div className="space-y-3 pb-5 border-b border-[var(--brand-glass-border-1)]">
                    <div className="flex items-baseline gap-3">
                      {displayPrice > 0 ? (
                        <>
                          <span className="text-4xl font-bold text-green-600">${displayPrice.toFixed(2)}</span>
                          {displayOriginalPrice && (
                            <div className="flex flex-col">
                              <span className="text-lg text-gray-500 line-through">${displayOriginalPrice.toFixed(2)}</span>
                              <span className="text-xs font-semibold text-red-600">
                                Save ${(displayOriginalPrice - displayPrice).toFixed(2)}
                              </span>
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-lg font-semibold text-green-600">Contact for pricing</span>
                      )}
                    </div>
                    {displayPrice > 0 && quantity > 1 && (
                      <div className="text-sm text-slate-600">
                        Total:{' '}
                        <span className="text-lg font-bold text-green-600">
                          ${(displayPrice * quantity).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Variant Selector */}
                  {showVariantSelector && (
                    <div className="space-y-3 pb-5 border-b border-[var(--brand-glass-border-1)]">
                      <Label className="text-sm font-semibold">Select an option</Label>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {variantOptions.map((variant) => {
                          const isActive = variant.id === activeVariant?.id;
                          const attributesSummary = variant.attributes
                            .map((attr) => attr.value || attr.name)
                            .filter(Boolean)
                            .join(' • ');
                          return (
                            <Button
                              key={variant.id}
                              type="button"
                              variant={isActive ? 'default' : 'outline'}
                              onClick={() => setSelectedVariantId(variant.id)}
                              disabled={!variant.inStock}
                              className={`justify-between text-left ${!variant.inStock ? 'opacity-60' : ''}`}
                            >
                              <span className="flex flex-col text-left">
                                <span className="font-semibold">{variant.label}</span>
                                {attributesSummary && (
                                  <span className="text-xs text-slate-500">
                                    {attributesSummary}
                                  </span>
                                )}
                              </span>
                              <span className="font-semibold">
                                {variant.price > 0 ? `$${variant.price.toFixed(2)}` : '—'}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Quantity Selector */}
                  <div className="space-y-3">
                    <Label htmlFor="quantity" className="text-sm font-semibold">Quantity</Label>
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => handleQuantityChange(quantity - 1)}
                        disabled={quantity <= 1}
                        className="h-12 w-12 rounded-xl border-2 bg-slate-50"
                      >
                        <Minus className="h-5 w-5" />
                      </Button>
                      <Input
                        id="quantity"
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={quantityInput}
                        onChange={handleQuantityInputChange}
                        onBlur={handleQuantityInputBlur}
                        className="h-12 text-center text-xl font-bold squircle-sm bg-slate-50 border-2"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => handleQuantityChange(quantity + 1)}
                        className="h-12 w-12 rounded-xl border-2 bg-slate-50"
                      >
                        <Plus className="h-5 w-5" />
                      </Button>
                    </div>
                  </div>

                  {/* Order Notes */}
                  <div className="space-y-3">
                    <Label htmlFor="quantityDescription" className="text-sm font-semibold">Order Notes (Optional)</Label>
                    <textarea
                      id="quantityDescription"
                      value={quantityDescription}
                      onChange={(event) => setQuantityDescription(event.target.value)}
                      placeholder="Add fulfillment notes or special instructions..."
                      className="min-h-[100px] w-full resize-y squircle-lg p-4 text-sm border-2 border-[var(--brand-glass-border-2)] focus-visible:outline-none focus-visible:border-[rgb(95,179,249)] focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.2)] bg-slate-50"
                    />
                  </div>

                  {/* Add to Cart Button */}
                  <Button
                    onClick={handleAddToCart}
                    disabled={!isInStock}
                    className="w-full h-14 text-base font-semibold glass-brand squircle-lg transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ShoppingCart className="mr-2 h-5 w-5" />
                    {isInStock ? 'Add to Cart' : 'Out of Stock'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
