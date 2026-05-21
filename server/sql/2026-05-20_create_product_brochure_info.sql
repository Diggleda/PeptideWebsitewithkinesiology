-- Product brochure information synced from Google Sheets.
CREATE TABLE IF NOT EXISTS product_brochure_info (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_name VARCHAR(255) NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  parent_product_id BIGINT UNSIGNED NULL,
  variation_id BIGINT UNSIGNED NULL,
  product_sku VARCHAR(128) NOT NULL,
  parent_sku VARCHAR(128) NULL,
  product_description LONGTEXT NULL,
  product_information LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_brochure_info_sku (product_sku),
  INDEX idx_product_brochure_info_product_id (product_id),
  INDEX idx_product_brochure_info_variation_id (variation_id),
  INDEX idx_product_brochure_info_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
