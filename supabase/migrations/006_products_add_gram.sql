-- Add gram (weight) column to products table.

ALTER TABLE products ADD COLUMN gram INTEGER NOT NULL DEFAULT 0;
