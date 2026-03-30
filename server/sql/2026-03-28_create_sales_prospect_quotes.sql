CREATE TABLE IF NOT EXISTS sales_prospect_quotes (
  id VARCHAR(64) PRIMARY KEY,
  prospect_id VARCHAR(64) NOT NULL,
  sales_rep_id VARCHAR(64) NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  title VARCHAR(190) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  quote_payload_json LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  exported_at DATETIME NULL,
  UNIQUE KEY uniq_sales_prospect_quote_revision (prospect_id, revision_number),
  INDEX idx_sales_prospect_quotes_prospect (prospect_id, created_at),
  INDEX idx_sales_prospect_quotes_prospect_status (prospect_id, status, updated_at),
  INDEX idx_sales_prospect_quotes_sales_rep (sales_rep_id, updated_at)
) CHARACTER SET utf8mb4;
