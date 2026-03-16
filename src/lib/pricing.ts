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
  options?: {
    pricingMode?: PricingMode;
    markupPercent?: number | null;
    forcedTierRange?: { minQuantity: number; maxQuantity: number } | null;
  },
) => {
  const pricingMode: PricingMode = options?.pricingMode ?? 'wholesale';
  const markupPercentRaw = Number(options?.markupPercent ?? 0);
  const markupPercent = Number.isFinite(markupPercentRaw)
    ? Math.max(0, markupPercentRaw)
    : 0;

  const basePrice = (() => {
    if (pricingMode === 'retail') {
      const retail = resolveRetailBasePrice(product, variant);
      if (retail != null) return retail;
    }
    return roundCurrency(variant?.price ?? product.price);
  })();

  let unitPrice = basePrice;

  if (pricingMode !== 'retail') {
    const tiers = variant?.bulkPricingTiers ?? product.bulkPricingTiers ?? [];
    const forcedTierRange = options?.forcedTierRange ?? null;

    if (Array.isArray(tiers) && tiers.length > 0) {
      let applicable = null as (typeof tiers)[number] | null;
      if (
        forcedTierRange &&
        Number.isFinite(Number(forcedTierRange.minQuantity)) &&
        Number.isFinite(Number(forcedTierRange.maxQuantity))
      ) {
        const min = Math.max(0, Number(forcedTierRange.minQuantity) || 0);
        const max = Math.max(min, Number(forcedTierRange.maxQuantity) || min);
        const sortedAsc = [...tiers].sort(
          (a, b) => (Number(a.minQuantity) || 0) - (Number(b.minQuantity) || 0),
        );
        // Anchor forced pricing to the lower bound of the requested band (ex: 11-26 -> quantity 11).
        // This matches typical tier table semantics where each tier starts at its min quantity.
        const targetQuantity = min;
        for (let idx = 0; idx < sortedAsc.length; idx += 1) {
          const tier = sortedAsc[idx];
          const tierMin = Number(tier.minQuantity) || 0;
          const nextTierMin =
            idx + 1 < sortedAsc.length ? Number(sortedAsc[idx + 1].minQuantity) || 0 : Number.POSITIVE_INFINITY;
          if (tierMin <= targetQuantity && targetQuantity < nextTierMin) {
            applicable = tier;
            break;
          }
        }
        if (!applicable) {
          applicable =
            sortedAsc.find((tier) => {
              const tierMin = Number(tier.minQuantity) || 0;
              return tierMin >= min && tierMin <= max;
            }) ?? null;
        }
      }
      if (!applicable) {
        applicable =
          [...tiers]
            .sort((a, b) => (Number(b.minQuantity) || 0) - (Number(a.minQuantity) || 0))
            .find((tier) => quantity >= (Number(tier.minQuantity) || 0)) ?? null;
      }

      if (applicable) {
        const fixedUnitPrice = Number((applicable as any).unitPrice);
        if (Number.isFinite(fixedUnitPrice) && fixedUnitPrice > 0) {
          unitPrice = fixedUnitPrice;
        } else {
          const discountPercentage = Number(applicable.discountPercentage) || 0;
          unitPrice = basePrice * (1 - discountPercentage / 100);
        }
      }
    }
  }

  if (markupPercent > 0) {
    unitPrice *= 1 + markupPercent / 100;
  }

  return roundCurrency(unitPrice);
};
