import type { Product, ProductVariant } from '../types/product';

export type PricingMode = 'wholesale' | 'retail';

export const roundCurrency = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const resolveRetailBasePrice = (product: Product, variant: ProductVariant | null | undefined) => {
  const candidate = variant?.originalPrice ?? product.originalPrice;
  if (typeof candidate !== 'number') {
    return null;
  }
  const rounded = roundCurrency(candidate);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return null;
  }
  return rounded;
};

export const computeUnitPrice = (
  product: Product,
  variant: ProductVariant | null | undefined,
  quantity: number,
  options?: { pricingMode?: PricingMode },
) => {
  const pricingMode: PricingMode = options?.pricingMode ?? 'wholesale';

  const basePrice = (() => {
    if (pricingMode === 'retail') {
      const retail = resolveRetailBasePrice(product, variant);
      if (retail != null) return retail;
    }
    return roundCurrency(variant?.price ?? product.price);
  })();

  if (pricingMode === 'retail') {
    return basePrice;
  }

  const tiers = product.bulkPricingTiers ?? [];

  if (!Array.isArray(tiers) || tiers.length === 0) {
    return basePrice;
  }

  const applicable = [...tiers]
    .sort((a, b) => (Number(b.minQuantity) || 0) - (Number(a.minQuantity) || 0))
    .find((tier) => quantity >= (Number(tier.minQuantity) || 0));

  if (!applicable) {
    return basePrice;
  }

  const discountPercentage = Number(applicable.discountPercentage) || 0;
  const discounted = basePrice * (1 - discountPercentage / 100);
  return roundCurrency(discounted);
};
