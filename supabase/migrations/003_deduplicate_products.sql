-- Merge products with identical (name, store, price) — true duplicates only.
-- Products with same name+store but different prices are left for manual review.

-- Step 1: Delete true duplicates (same name, store, AND price). Keep the lowest id.
DELETE FROM products
WHERE id NOT IN (
  SELECT MIN(id) FROM products GROUP BY name, store, price
)
AND name != ''
AND (name, store, price) IN (
  SELECT name, store, price FROM products WHERE name != ''
  GROUP BY name, store, price
  HAVING COUNT(*) > 1
);

-- Step 2: Flag remaining duplicates (same name+store, different price) for manual review.
-- Adds a remarks column if you need to track items needing cleanup.
ALTER TABLE products ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT '';

UPDATE products
SET remarks = 'REVIEW: duplicate name+store with different price'
WHERE (name, store) IN (
  SELECT name, store FROM products WHERE name != ''
  GROUP BY name, store
  HAVING COUNT(*) > 1
)
AND remarks = '';

-- Step 3: Add unique constraint. This will fail if step 1 didn't resolve all duplicates.
-- If it fails, check: SELECT name, store, array_agg(price), array_agg(id) FROM products GROUP BY name, store HAVING COUNT(*) > 1;
-- Manually resolve those, then re-run.
ALTER TABLE products ADD CONSTRAINT uq_products_name_store UNIQUE (name, store);
