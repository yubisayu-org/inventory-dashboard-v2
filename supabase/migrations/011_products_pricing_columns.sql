-- Add pricing breakdown columns to products table.
-- Abroad products: country_id, valas, kurs, cargo_per_kg, profit_pct, operational_fee, packing_fee
-- Domestic products: cost, profit_fixed

-- Abroad pricing columns
ALTER TABLE products ADD COLUMN country_id      INTEGER REFERENCES countries(id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN valas           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN kurs            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN cargo_per_kg    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN profit_pct      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN operational_fee INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE products ADD COLUMN packing_fee     INTEGER NOT NULL DEFAULT 5000;

-- Domestic pricing columns
ALTER TABLE products ADD COLUMN cost            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN profit_fixed    INTEGER NOT NULL DEFAULT 0;
