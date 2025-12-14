import type { Product, ProductVariant, BulkPricingTier } from '../types/product';

// Dev-only loader to map tmp/woo-product-211.json into ProductCard Product shape
export async function loadLocalProductForCard(): Promise<Product | null> {
  try {
    // Served from public/fixtures in dev
    const data = await fetch('/fixtures/woo-product-211.json', { cache: 'no-store' }).then((r) => r.json());
    const list = Array.isArray(data) ? data : [];
    const p = list[0];
    if (!p) return null;

    const category = (p.categories?.[0]?.name as string) || 'Store';
    const image = (p.images?.[0]?.src as string) || '';
    const gallery = Array.isArray(p.images) ? p.images.map((im: any) => im?.src).filter(Boolean) : [];

    // Variants from attribute options (Amount)
    const options: string[] = p.attributes?.find((a: any) => a?.name?.toLowerCase() === 'amount')?.options || [];
    const basePrice = Number.parseFloat(p.price || '0') || 0;

    const variants: ProductVariant[] = options.map((opt: string, idx: number) => ({
      id: `fixture-variant-${idx}`,
      label: opt,
      price: basePrice + idx * 40, // simple spread since variant prices are not in payload
      inStock: true,
      attributes: [{ name: 'Amount', value: opt }],
      image,
    }));

    // Bulk tiers: try fixed rules first, then peppro_tier_*_price meta (absolute $); convert to percentage vs basePrice
    const bulkPricingTiers: BulkPricingTier[] = [];
    const metas = Array.isArray(p.meta_data) ? p.meta_data : [];
    const fixedRules = (p.tiered_pricing_fixed_rules as any[]) || [];
    for (const rule of fixedRules) {
      const min = Number(rule?.quantity || rule?.min || 0);
      const fixed = Number(rule?.price || rule?.amount || 0);
      if (min > 0 && fixed > 0 && basePrice > 0) {
        const discount = Math.max(0, Math.min(100, (1 - fixed / basePrice) * 100));
        bulkPricingTiers.push({ minQuantity: Math.floor(min), discountPercentage: Math.round(discount) });
      }
    }
    if (bulkPricingTiers.length === 0) {
      const tierMeta = metas.filter((m: any) => String(m?.key || '').includes('peppro_tier_'));
      for (const m of tierMeta) {
        const key = String(m.key || '');
        const val = Number(String(m.value || '').replace(/[^\d.]/g, ''));
        const qtyMatch = key.match(/(\d+)(?:\+|\u2013|-)?/);
        const min = qtyMatch ? Number(qtyMatch[1]) : 0;
        if (min > 0 && val > 0 && basePrice > 0) {
          const discount = Math.max(0, Math.min(100, (1 - val / basePrice) * 100));
          bulkPricingTiers.push({ minQuantity: min, discountPercentage: Math.round(discount) });
        }
      }
      bulkPricingTiers.sort((a, b) => a.minQuantity - b.minQuantity);
    }

    const product: Product = {
      id: `fixture-${p.id}`,
      name: p.name,
      category,
      price: basePrice,
      originalPrice: undefined,
      rating: 5,
      reviews: 0,
      image: image || '/Peppro_IconLogo_Transparent_NoBuffer.png',
      images: gallery.length ? gallery : [image || '/Peppro_IconLogo_Transparent_NoBuffer.png'],
      inStock: true,
      prescription: false,
      dosage: options.length ? `${options.length} options` : 'See details',
      manufacturer: 'Fixture',
      type: p.type,
      description: '',
      variants: variants.length ? variants : undefined,
      hasVariants: variants.length > 0,
      defaultVariantId: variants[0]?.id,
      variantSummary: variants.slice(0, 3).map((v) => v.label).join(' • '),
      bulkPricingTiers: bulkPricingTiers.length ? bulkPricingTiers : undefined,
    };
    return product;
  } catch {
    return null;
  }
}
