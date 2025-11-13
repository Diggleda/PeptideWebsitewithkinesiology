export interface ProductVariantAttribute {
  name: string;
  value: string;
}

export interface ProductVariant {
  id: string;
  label: string;
  price: number;
  originalPrice?: number;
  sku?: string;
  inStock: boolean;
  attributes: ProductVariantAttribute[];
  image?: string;
  description?: string;
}

export interface BulkPricingTier {
  minQuantity: number;
  discountPercentage: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  originalPrice?: number;
  rating: number;
  reviews: number;
  image: string;
  images: string[];
  inStock: boolean;
  prescription: boolean;
  dosage: string;
  manufacturer: string;
  type?: string;
  description?: string;
  variants?: ProductVariant[];
  hasVariants?: boolean;
  defaultVariantId?: string;
  variantSummary?: string;
  bulkPricingTiers?: BulkPricingTier[];
}
