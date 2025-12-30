import type { Product, ProductVariant } from '../types/product';

export const roundCurrency = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

export const computeUnitPrice = (
  product: Product,
  variant: ProductVariant | null | undefined,
  quantity: number,
) => {
  const basePriceRaw = variant?.price ?? product.price;
  const basePrice = roundCurrency(basePriceRaw);
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

