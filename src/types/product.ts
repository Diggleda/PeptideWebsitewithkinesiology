export interface ProductVariantAttribute {
  name: string;
  value: string;
}

export interface ProductDimensions {
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
}

export interface ProductVariant {
  id: string;
  wooId?: number;
  label: string;
  price: number;
  originalPrice?: number;
  sku?: string;
  inStock: boolean;
  stockQuantity?: number | null;
  attributes: ProductVariantAttribute[];
  image?: string;
  description?: string;
  weightOz?: number | null;
  dimensions?: ProductDimensions;
}

export interface BulkPricingTier {
  minQuantity: number;
  discountPercentage: number;
}

export interface ProductTag {
  id?: number;
  name: string;
  slug: string;
}

export interface Product {
  id: string;
  wooId?: number;
  name: string;
  category: string;
  price: number;
  originalPrice?: number;
  rating: number;
  reviews: number;
  image: string;
  images: string[];
  image_loaded?: boolean;
  inStock: boolean;
  stockQuantity?: number | null;
  prescription: boolean;
  dosage: string;
  manufacturer: string;
  type?: string;
  isSubscription?: boolean;
  description?: string;
  weightOz?: number | null;
  dimensions?: ProductDimensions;
  sku?: string;
  variants?: ProductVariant[];
  hasVariants?: boolean;
  defaultVariantId?: string;
  variantSummary?: string;
  bulkPricingTiers?: BulkPricingTier[];
  tags?: ProductTag[];
}
