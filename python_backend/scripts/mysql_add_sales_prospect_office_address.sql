-- Adds editable office address fields for sales prospects (contact form + manual prospects).
-- Safe to run once; verify the columns don't already exist before applying in production.

ALTER TABLE sales_prospects
  ADD COLUMN office_address_line1 VARCHAR(190) NULL,
  ADD COLUMN office_address_line2 VARCHAR(190) NULL,
  ADD COLUMN office_city VARCHAR(190) NULL,
  ADD COLUMN office_state VARCHAR(64) NULL,
  ADD COLUMN office_postal_code VARCHAR(32) NULL,
  ADD COLUMN office_country VARCHAR(64) NULL;
